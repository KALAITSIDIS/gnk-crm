import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { LINKS_0139, REVERT_0139_SQL, readMigration0139 } from "./revert-0139";

/**
 * Every link onto a contact belongs to the contact's organisation
 * (T-contact-links-org-isolation, migration 0139 — release 2 of 2).
 *
 * THE GAP (reproduced at 0138 by this file — the tests marked RED at 0138
 * failed there, each for the reason it names): ten foreign keys referenced
 * contacts by id ALONE — leads.contact_id, deals.buyer_contact_id /
 * seller_contact_id, offers.contact_id, share_links.contact_id,
 * buyer_requirements.contact_id, mandates.owner_contact_id,
 * properties.owner_contact_id / developer_contact_id and
 * contacts.merged_into_id — and every insert / update policy checks only the
 * CALLER's organisation. Organisation B's admin could hang B's rows on
 * organisation A's contact through PostgREST, and a real A id (accepted)
 * against a missing one (23503) told B the contact exists.
 *
 * THE FIX: each key re-made (org_id, <col>) → contacts (org_id, id) UNDER ITS
 * OWN NAME, so the embed hints release 1 moved to constraint names keep
 * resolving (contact-link-embeds.test.ts runs the exports live). The delete
 * rules are kept (CASCADE for buyer_requirements, NO ACTION for the rest).
 *
 * Plants that cross organisations are made only inside rolled-back
 * transactions or through the RED paths themselves (whose rows afterAll
 * removes, and beforeAll sweeps after a killed run); the B-side organisations
 * are throwaway. MEASURE RED PER SECTION at 0138: section 1's accepted RED
 * writes commit cross-organisation rows, and section 4's replays count
 * mismatches across the whole database — run in one go at 0138, they fail
 * for that reason, not their own.
 */

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN = Date.now().toString(36);

let svc: SupabaseClient;
let o: Client;
let adminA: TestUser;
let adminB: TestUser;
const userIds: string[] = [];
const ids = { cA: "", cA2: "", cB: "", cB2: "", dealA: "", dealB: "", propA: "", propB: "" };

const inADay = () => new Date(Date.now() + 86_400_000).toISOString();
const hex64 = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

/** The rows of a stale run's throwaway organisations that can name ANOTHER organisation's contact. */
async function sweepCrossOrgRows(db: Client, namePatterns: string[]) {
  const { rows } = await db.query<{ id: string }>("select id from organizations where name like any($1::text[])", [namePatterns]);
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  for (const t of ["leads", "offers", "share_links", "buyer_requirements", "mandates"]) {
    await db.query(`delete from ${t} where org_id = any($1::uuid[])`, [ids]);
  }
  await db.query("update deals set buyer_contact_id = null, seller_contact_id = null where org_id = any($1::uuid[])", [ids]);
  await db.query("update properties set owner_contact_id = null, developer_contact_id = null where org_id = any($1::uuid[])", [ids]);
  await db.query("update contacts set merged_into_id = null where org_id = any($1::uuid[])", [ids]);
}

async function rolledBack(fn: () => Promise<void>) {
  await o.query("begin");
  try {
    await fn();
  } finally {
    await o.query("rollback");
  }
}

async function svcInsert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await svc.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data as { id: string }).id;
}

const newContact = (org: string, first: string) =>
  svcInsert("contacts", { org_id: org, contact_kind: "person", first_name: first, last_name: `CL ${RUN}` });
const newProperty = (org: string) =>
  svcInsert("properties", { org_id: org, reference: `CL${RUN}${Math.random().toString(36).slice(2, 7)}`.slice(0, 20), property_type: "apartment" });

async function stageOf(org: string) {
  const { rows } = await o.query<{ id: string }>(
    "select id from deal_stages where org_id = $1 and deal_type = 'sale' order by sort_order limit 1",
    [org],
  );
  return rows[0]!.id;
}

/** Every foreign key onto contacts, as the catalogue states it. */
async function keysOnContacts() {
  const { rows } = await o.query<{ rel: string; conname: string; def: string; convalidated: boolean }>(
    `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def, convalidated
       from pg_constraint where contype = 'f' and confrelid = 'public.contacts'::regclass
      order by conname collate "C"`,
  );
  return rows;
}

const EARLIER = [
  { rel: "reservations", conname: "reservations_org_contact_fkey", def: "FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE SET NULL (contact_id)", convalidated: true },
  { rel: "tasks", conname: "tasks_org_contact_fkey", def: "FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)", convalidated: true },
  { rel: "viewings", conname: "viewings_org_contact_fkey", def: "FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)", convalidated: true },
];
const byName = (a: { conname: string }, b: { conname: string }) => (a.conname < b.conname ? -1 : a.conname > b.conname ? 1 : 0);
const KEYS_0139 = [
  ...LINKS_0139.map((l) => ({
    rel: l.table,
    conname: l.key,
    def: `FOREIGN KEY (org_id, ${l.column}) REFERENCES contacts(org_id, id)${l.del === "c" ? " ON DELETE CASCADE" : ""}`,
    convalidated: true,
  })),
  ...EARLIER,
].sort(byName);
const KEYS_0138 = [
  ...LINKS_0139.map((l) => ({
    rel: l.table,
    conname: l.key,
    def: `FOREIGN KEY (${l.column}) REFERENCES contacts(id)${l.del === "c" ? " ON DELETE CASCADE" : ""}`,
    convalidated: true,
  })),
  ...EARLIER,
].sort(byName);

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  // a killed earlier run of THIS file leaves its rows behind (afterAll never
  // ran) — and a run at 0138 commits cross-organisation ones, which would stop
  // the replays below (and the next local apply of 0139) in the preflight:
  // clear this file's own throwaway organisations' links only, never every
  // cross-organisation row in the database (the restore pack reports those)
  await sweepCrossOrgRows(o, ["contact links A %", "contact links B %"]);
  await ensureTestOrg(svc, ORG_A, `contact links A ${RUN}`, `contact-links-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `contact links B ${RUN}`, `contact-links-b-${RUN}`);
  adminA = await createTestUser(svc, `cl-a-${RUN}@test.local`, "admin", ORG_A);
  userIds.push(adminA.id);
  adminB = await createTestUser(svc, `cl-b-${RUN}@test.local`, "admin", ORG_B);
  userIds.push(adminB.id);
  ids.cA = await newContact(ORG_A, "Alpha");
  ids.cA2 = await newContact(ORG_A, "Alpha2");
  ids.cB = await newContact(ORG_B, "Beta");
  ids.cB2 = await newContact(ORG_B, "Beta2");
  ids.propA = await newProperty(ORG_A);
  ids.propB = await newProperty(ORG_B);
  ids.dealA = await svcInsert("deals", { org_id: ORG_A, stage_id: await stageOf(ORG_A), title: `CL A ${RUN}`, deal_type: "sale" });
  ids.dealB = await svcInsert("deals", { org_id: ORG_B, stage_id: await stageOf(ORG_B), title: `CL B ${RUN}`, deal_type: "sale", created_by: adminB.id });
});

afterAll(async () => {
  // children first (a RED run at 0138 commits B rows naming A's contacts)
  for (const org of [ORG_A, ORG_B]) {
    for (const t of ["offers", "share_links", "buyer_requirements", "mandates", "leads"]) {
      await o.query(`delete from ${t} where org_id = $1`, [org]);
    }
    await o.query("update deals set buyer_contact_id = null, seller_contact_id = null where org_id = $1", [org]);
    await o.query("update properties set owner_contact_id = null, developer_contact_id = null where org_id = $1", [org]);
    await o.query("update contacts set merged_into_id = null where org_id = $1", [org]);
  }
  for (const org of [ORG_A, ORG_B]) {
    await o.query("delete from deals where org_id = $1", [org]);
    await o.query("delete from properties where org_id = $1", [org]);
    await o.query("delete from contacts where org_id = $1", [org]);
  }
  for (const id of userIds) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) console.warn(`afterAll: auth user ${id} not deleted: ${error.message}`);
  }
  for (const org of [ORG_A, ORG_B]) {
    await o.query("delete from profiles where org_id = $1", [org]);
    await o.query("delete from events where org_id = $1", [org]);
    await o.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await o.query("delete from chain_checks where org_id = $1", [org]);
    await o.query("delete from deal_stages where org_id = $1", [org]);
    await o.query("delete from districts where org_id = $1", [org]);
    await o.query("delete from organizations where id = $1", [org]);
  }
  await o.end();
});

// ---------------------------------------------------------------------------
type Res = { error: { code?: string; message: string } | null };
/** One write per link, as B's admin through PostgREST, naming `contact`. */
const WRITES: { link: string; table: string; key: string; write: (c: SupabaseClient, contact: string) => Promise<Res> }[] = [
  { link: "a lead (insert)", table: "leads", key: "leads_contact_id_fkey",
    write: async (c, contact) => c.from("leads").insert({ org_id: ORG_B, contact_id: contact }).select("id") },
  { link: "a deal's buyer (update)", table: "deals", key: "deals_buyer_contact_id_fkey",
    write: async (c, contact) => c.from("deals").update({ buyer_contact_id: contact }).eq("id", ids.dealB).select("id") },
  { link: "a deal's seller (update)", table: "deals", key: "deals_seller_contact_id_fkey",
    write: async (c, contact) => c.from("deals").update({ seller_contact_id: contact }).eq("id", ids.dealB).select("id") },
  { link: "an offer (insert)", table: "offers", key: "offers_contact_id_fkey",
    write: async (c, contact) =>
      c.from("offers").insert({ org_id: ORG_B, deal_id: ids.dealB, amount: 1, contact_id: contact }).select("id") },
  { link: "a share link (insert)", table: "share_links", key: "share_links_contact_id_fkey",
    write: async (c, contact) =>
      c.from("share_links")
        .insert({ org_id: ORG_B, token_sha256: hex64(), expires_at: inADay(), contact_id: contact, created_by: adminB.id })
        .select("id") },
  { link: "a buyer requirement (insert)", table: "buyer_requirements", key: "buyer_requirements_contact_id_fkey",
    write: async (c, contact) => c.from("buyer_requirements").insert({ org_id: ORG_B, contact_id: contact }).select("id") },
  { link: "a mandate's owner (insert)", table: "mandates", key: "mandates_owner_contact_id_fkey",
    // one active mandate per property: each attempt gets its own listing
    write: async (c, contact) =>
      c.from("mandates")
        .insert({ org_id: ORG_B, property_id: await newProperty(ORG_B), type: "exclusive", owner_contact_id: contact })
        .select("id") },
  { link: "a listing's owner (update)", table: "properties", key: "properties_owner_contact_id_fkey",
    write: async (c, contact) => c.from("properties").update({ owner_contact_id: contact }).eq("id", ids.propB).select("id") },
  { link: "a listing's developer (update)", table: "properties", key: "properties_developer_contact_id_fkey",
    write: async (c, contact) => c.from("properties").update({ developer_contact_id: contact }).eq("id", ids.propB).select("id") },
  { link: "a contact's merge pointer (update)", table: "contacts", key: "contacts_merged_into_id_fkey",
    write: async (c, contact) => c.from("contacts").update({ merged_into_id: contact }).eq("id", ids.cB2).select("id") },
];

describe("1. through PostgREST, as organisation B's admin", () => {
  for (const w of WRITES) {
    it(`RED at 0138: ${w.link} naming A's contact is refused 23503 by ${w.key} — the same answer as a contact that does not exist`, async () => {
      const foreign = await w.write(adminB.client, ids.cA);
      const missing = await w.write(adminB.client, randomUUID());
      expect(foreign.error?.code, JSON.stringify(foreign.error)).toBe("23503");
      expect(foreign.error?.message).toBe(`insert or update on table "${w.table}" violates foreign key constraint "${w.key}"`);
      expect(missing.error?.code).toBe("23503");
      expect(missing.error?.message, "no oracle: a real foreign id and a missing one read the same").toBe(foreign.error?.message);
    });
    it(`${w.link} naming B's own contact is accepted`, async () => {
      const own = await w.write(adminB.client, ids.cB);
      expect(own.error, JSON.stringify(own.error)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
describe("2. the delete rules are kept", () => {
  it("a requirement still goes with its contact (ON DELETE CASCADE)", async () => {
    await rolledBack(async () => {
      const c = (await o.query<{ id: string }>("insert into contacts (org_id, first_name) values ($1, 'cascade') returning id", [ORG_A])).rows[0]!.id;
      const r = (await o.query<{ id: string }>("insert into buyer_requirements (org_id, contact_id) values ($1, $2) returning id", [ORG_A, c])).rows[0]!.id;
      await o.query("delete from contacts where id = $1", [c]);
      expect((await o.query("select 1 from buyer_requirements where id = $1", [r])).rowCount).toBe(0);
    });
  });

  for (const [what, insert, key] of [
    ["a lead", "insert into leads (org_id, contact_id) values ($1, $2)", "leads_contact_id_fkey"],
    ["a merged duplicate", "insert into contacts (org_id, first_name, merged_into_id) values ($1, 'dup', $2)", "contacts_merged_into_id_fkey"],
  ] as const) {
    it(`a contact named by ${what} still cannot be deleted (NO ACTION, by the same key)`, async () => {
      await rolledBack(async () => {
        const c = (await o.query<{ id: string }>("insert into contacts (org_id, first_name) values ($1, 'kept') returning id", [ORG_A])).rows[0]!.id;
        await o.query(insert, [ORG_A, c]);
        await o.query("savepoint del");
        await expect(o.query("delete from contacts where id = $1", [c])).rejects.toMatchObject({ code: "23503", constraint: key });
        await o.query("rollback to savepoint del");
      });
    });
  }
});

// ---------------------------------------------------------------------------
describe("3. the catalogue", () => {
  it("RED at 0138: all thirteen keys onto contacts are (org_id, <col>) → contacts (org_id, id), the ten under their old names with their old rules", async () => {
    expect(await keysOnContacts()).toEqual(KEYS_0139);
  });

  it("RED at 0138: the BACKLOG VERIFY reads 0 — no single-column key onto contacts remains", async () => {
    const { rows } = await o.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where contype = 'f' and confrelid = 'public.contacts'::regclass and array_length(conkey, 1) = 1",
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("RED at 0138: each link has its (org_id, <col>) index — partial where the column is nullable", async () => {
    const { rows } = await o.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = any($1::text[]) order by indexname collate \"C\"",
      [LINKS_0139.map((l) => l.index)],
    );
    expect(rows.map((r) => r.indexname)).toEqual(LINKS_0139.map((l) => l.index).sort());
    for (const l of LINKS_0139) {
      const def = rows.find((r) => r.indexname === l.index)!.indexdef;
      const partial = l.table === "buyer_requirements" ? "" : ` WHERE (${l.column} IS NOT NULL)`;
      expect(def, l.index).toBe(`CREATE INDEX ${l.index} ON public.${l.table} USING btree (org_id, ${l.column})${partial}`);
    }
  });

  it("no unique index covers a link column (it would answer 23505 before the key's 23503)", async () => {
    const { rows } = await o.query<{ n: number }>(
      `select count(*)::int as n from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey::int2[])
       where i.indisunique and (i.indrelid::regclass::text, a.attname::text) in (${LINKS_0139.map((l) => `('${l.table}', '${l.column}')`).join(", ")})`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("PostgREST resolves ONE relationship each way for every single-link table (no PGRST201), forward and reverse", async () => {
    for (const [table, select] of [
      ["leads", "id, contacts(id)"],
      ["offers", "id, contacts(id)"],
      ["share_links", "id, contacts(id)"],
      ["buyer_requirements", "id, contacts!inner(id)"],
      ["mandates", "id, contacts(id)"],
      ["contacts", "id, leads(id), offers(id), share_links(id), buyer_requirements(id), mandates(id)"],
    ] as const) {
      const r = await adminA.client.from(table).select(select).limit(1);
      expect(r.error, `${table}: ${JSON.stringify(r.error)}`).toBeNull();
    }
  });

  it("RED at 0138 (the ROLLBACK FLOOR): a column hint onto a re-keyed link answers PGRST200, its constraint-name hint resolves", async () => {
    for (const [table, column, key] of [
      ["deals", "buyer_contact_id", "deals_buyer_contact_id_fkey"],
      ["properties", "owner_contact_id", "properties_owner_contact_id_fkey"],
    ] as const) {
      const byColumn = await adminA.client.from(table).select(`id, contacts!${column}(id)`).limit(1);
      expect(byColumn.error?.code, `${table} by column`).toBe("PGRST200");
      const byName = await adminA.client.from(table).select(`id, contacts!${key}(id)`).limit(1);
      expect(byName.error, `${table} by name`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
describe("4. the migration file (every replay rolled back)", () => {
  const file = readMigration0139;
  const COUNTS = [
    "lead(s)", "deal buyer(s)", "deal seller(s)", "offer(s)", "share link(s)", "requirement(s)",
    "mandate owner(s)", "property owner(s)", "property developer(s)", "merge pointer(s)",
  ];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("applies over 0138's catalogue: the keys validate under their old names, the ten probes are refused by their keys, the summary is the last row", async () => {
    const notices: string[] = [];
    const listen = (m: { message?: string }) => notices.push(m.message ?? "");
    o.on("notice", listen);
    try {
      await rolledBack(async () => {
        await o.query(REVERT_0139_SQL);
        expect(await keysOnContacts()).toEqual(KEYS_0138);
        const res = await o.query(file());
        const last = (Array.isArray(res) ? res[res.length - 1] : res) as { rows: { summary: string }[] };
        expect(last.rows[0]!.summary).toBe(
          "keys_replaced=10 single_column_onto_contacts=0 probes_refused=10 (lead, deal-buyer, deal-seller, offer, share-link, requirement, mandate, property-owner, property-developer, merge-pointer)",
        );
        expect(await keysOnContacts()).toEqual(KEYS_0139);
      });
    } finally {
      o.off("notice", listen);
    }
    expect(notices.some((n) => n.startsWith("0139: preflight passed"))).toBe(true);
  });

  WRITES.forEach((w, i) => {
    it(`refuses, in its preflight, over a single existing mismatch on ${w.link}, naming the count — and changes nothing`, async () => {
      await rolledBack(async () => {
        await o.query(REVERT_0139_SQL);
        // at 0138 the single-column key accepts it: plant B's row naming A's contact
        switch (i) {
          case 0: await o.query("insert into leads (org_id, contact_id) values ($1, $2)", [ORG_B, ids.cA]); break;
          case 1: await o.query("update deals set buyer_contact_id = $2 where id = $1", [ids.dealB, ids.cA]); break;
          case 2: await o.query("update deals set seller_contact_id = $2 where id = $1", [ids.dealB, ids.cA]); break;
          case 3: await o.query("insert into offers (org_id, deal_id, amount, contact_id) values ($1, $2, 1, $3)", [ORG_B, ids.dealB, ids.cA]); break;
          case 4: await o.query("insert into share_links (org_id, token_sha256, expires_at, contact_id) values ($1, $2, now() + interval '1 day', $3)", [ORG_B, hex64(), ids.cA]); break;
          case 5: await o.query("insert into buyer_requirements (org_id, contact_id) values ($1, $2)", [ORG_B, ids.cA]); break;
          case 6: {
            const p = (await o.query<{ id: string }>("insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id", [ORG_B, `CLM${RUN}`.slice(0, 20)])).rows[0]!.id;
            await o.query("insert into mandates (org_id, property_id, type, owner_contact_id) values ($1, $2, 'exclusive', $3)", [ORG_B, p, ids.cA]);
            break;
          }
          case 7: await o.query("update properties set owner_contact_id = $2 where id = $1", [ids.propB, ids.cA]); break;
          case 8: await o.query("update properties set developer_contact_id = $2 where id = $1", [ids.propB, ids.cA]); break;
          default: await o.query("update contacts set merged_into_id = $2 where id = $1", [ids.cB2, ids.cA]);
        }
        const counts = COUNTS.map((c, j) => `${j === i ? 1 : 0} ${c}`).join(", ");
        await o.query("savepoint before_0139");
        await expect(o.query(file())).rejects.toThrow(
          new RegExp(`^0139 aborted: rows name a contact of another organisation — ${esc(counts)} — nothing was changed`),
        );
        await o.query("rollback to savepoint before_0139");
        expect(await keysOnContacts(), "nothing changed").toEqual(KEYS_0138);
      });
    });
  });

  for (const d of [
    { what: "a key with a different rule", sql: "alter table public.buyer_requirements drop constraint buyer_requirements_contact_id_fkey, add constraint buyer_requirements_contact_id_fkey foreign key (contact_id) references public.contacts(id)", re: /^0139 aborted: the foreign key from buyer_requirements\.contact_id onto contacts is not 0043's buyer_requirements_contact_id_fkey / },
    { what: "a second key on a link column", sql: "alter table public.leads add constraint zz_leads_contact_again foreign key (contact_id) references public.contacts(id)", re: /^0139 aborted: the foreign key from leads\.contact_id onto contacts is not 0001's leads_contact_id_fkey / },
    { what: "a unique index on a link column", sql: "create unique index zz_share_links_contact_uq on public.share_links (contact_id)", re: /^0139 aborted: a unique index on share_links\.contact_id would answer before the key — nothing was changed/ },
    { what: "a taken index name", sql: "create index offers_org_contact_idx on public.offers (org_id)", re: /^0139 aborted: an index name this file creates is taken — nothing was changed/ },
  ]) {
    it(`refuses before any DDL over ${d.what}`, async () => {
      await rolledBack(async () => {
        await o.query(REVERT_0139_SQL);
        await o.query(d.sql);
        await o.query("savepoint before_0139");
        await expect(o.query(file())).rejects.toThrow(d.re);
        await o.query("rollback to savepoint before_0139");
      });
    });
  }

  it("RED at 0138: run a second time, it stops in its preflight (the keys are no longer the originals)", async () => {
    await rolledBack(async () => {
      await expect(o.query(file())).rejects.toThrow(/^0139 aborted: the foreign key from leads\.contact_id onto contacts is not 0001's leads_contact_id_fkey/);
    });
  });

  it("its preflight (the LOCK, the counts, the key guards) precedes every change, and each key is dropped and re-added under its name in ONE statement", () => {
    const code = file().replace(/--[^\n]*/g, "");
    const firstChange = code.search(/^\s*(alter|create|drop|comment on|grant|revoke)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    for (const marker of [
      "lock table public.contacts, public.properties, public.deals, public.mandates, public.offers,",
      "into n_l ", "into n_c ", "pg_get_constraintdef(oid) = k.def", "0139: preflight passed",
    ]) {
      const at = code.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      expect(at, marker).toBeLessThan(firstChange);
    }
    expect(code.lastIndexOf("0139 aborted: rows name")).toBeLessThan(firstChange);
    for (const l of LINKS_0139) {
      expect(code, l.key).toMatch(
        new RegExp(`alter table public\\.${l.table}\\s+drop constraint ${l.key},\\s+add constraint ${l.key}\\s+foreign key \\(org_id, ${l.column}\\) references public\\.contacts \\(org_id, id\\)${l.del === "c" ? " on delete cascade" : ""};`),
      );
    }
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = file();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0139 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("the rollback recipe restores 0138's keys under the same names — and with them a cross-organisation lead", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0139_SQL);
      expect(await keysOnContacts()).toEqual(KEYS_0138);
      const { rows } = await o.query<{ n: number }>(
        "select count(*)::int as n from pg_indexes where schemaname = 'public' and indexname = any($1::text[])",
        [LINKS_0139.map((l) => l.index)],
      );
      expect(rows[0]!.n, "the ten indexes are gone").toBe(0);
      await o.query("insert into leads (org_id, contact_id) values ($1, $2)", [ORG_B, ids.cA]);
      await o.query(REVERT_0139_SQL); // a no-op at 0138
      expect(await keysOnContacts()).toEqual(KEYS_0138);
    });
  });

  it("an in-flight write to buyer_requirements (the last table locked) holds the file at its LOCK until lock_timeout (55P03)", async () => {
    const writer = new Client({ connectionString: DB_URL });
    await writer.connect();
    const req = (await o.query<{ id: string }>("insert into buyer_requirements (org_id, contact_id) values ($1, $2) returning id", [ORG_A, ids.cA])).rows[0]!.id;
    try {
      await writer.query("begin");
      await writer.query("update buyer_requirements set contact_id = contact_id where id = $1", [req]);
      const started = Date.now();
      // no revert first: the revert needs the same lock and has no timeout.
      // At 0139 the LOCK is still the preflight's FIRST statement — before the
      // key guard that would stop a second run — so it meets the writer.
      await rolledBack(async () => {
        await expect(o.query(file())).rejects.toMatchObject({ code: "55P03" });
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    } finally {
      await writer.query("rollback");
      await writer.end();
      await o.query("delete from buyer_requirements where id = $1", [req]);
    }
  });
});

// ---------------------------------------------------------------------------
describe("5. the restore pack's 0139 rows", () => {
  const pack = () => readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
  const rowSql = (start: string) => {
    const p = pack();
    const from = p.indexOf(`  select '${start}`);
    expect(from, start).toBeGreaterThan(0);
    const to = p.indexOf("\n  union all\n", from);
    return `select * from (${p.slice(from, to)}) r(check_name, expected, actual)`;
  };
  const INTEGRITY = "INTEGRITY: no lead, deal, offer, share link, requirement, mandate, listing or merge pointer names a contact of another organisation (0139)";
  const DANGLING = "INTEGRITY: no lead, deal, offer, share link, requirement, mandate, listing or merge pointer names a contact that does not exist (0139)";
  const SECURITY = "SECURITY: every foreign key onto contacts is bound to the contact''s organisation (0139)";

  it("RED at 0138 (the SECURITY row): each reads as expected now", async () => {
    for (const r of [INTEGRITY, DANGLING, SECURITY]) {
      const { rows } = await o.query<{ expected: string; actual: string }>(rowSql(r));
      expect(rows[0]!.actual, r).toBe(rows[0]!.expected);
    }
  });

  it("each reads red over what it guards: a single-column key, a cross-organisation link, a dangling id", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0139_SQL);
      expect((await o.query<{ actual: string }>(rowSql(SECURITY))).rows[0]!.actual).toBe("10");
      await o.query("insert into leads (org_id, contact_id) values ($1, $2)", [ORG_B, ids.cA]);
      expect((await o.query<{ actual: string }>(rowSql(INTEGRITY))).rows[0]!.actual).toMatch(/^leads [1-9]/);
      await o.query("set local session_replication_role = replica");
      await o.query("insert into offers (org_id, deal_id, amount, contact_id) values ($1, $2, 1, $3)", [ORG_B, ids.dealB, randomUUID()]);
      await o.query("set local session_replication_role = origin");
      expect((await o.query<{ actual: string }>(rowSql(DANGLING))).rows[0]!.actual).not.toBe("0");
    });
  });
});
