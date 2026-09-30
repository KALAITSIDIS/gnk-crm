import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ANON_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * The REAL `mergeContacts` action, against the REAL local stack, with two
 * throwaway organisations (T-contact-merge-org-isolation).
 *
 * The merge runs its repoints on the SERVICE-ROLE client, so RLS is not
 * between it and anybody's rows: the only thing that keeps A's merge inside A
 * is the query itself. Ten links onto `contacts` are still single-column (the
 * live list is read from `pg_constraint` below, not trusted), so a row of B can
 * legitimately be stored naming A's contact — B's admin can POST such a lead
 * through PostgREST today. Until this change, A's admin merging two of A's own
 * contacts rewrote those B rows onto A's primary, and B could then read A's
 * surviving contact id through its own lead.
 *
 * Nothing below the action is stubbed except the Next.js request plumbing:
 * `createClient` hands the action a supabase-js client signed in (at aal2) as
 * a fixture user, `createAdminClient` is the real service client, and
 * `logEvent` writes into the real hash chain. Only `revalidatePath` is a stub.
 *
 * Foreign rows are PLANTED with the service role where B's own session cannot
 * write the column (a mandate owner, a document) — that is the state the
 * schema admits, whichever path wrote it. The three links bound to the
 * contact's organisation since 0123 / 0126 (viewings, reservations, tasks) are
 * proven to refuse such a row, and then only A's side is exercised for them.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN = Date.now().toString(36);

const state = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = state.queue.shift();
    if (!c) throw new Error("test harness: no client queued for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});

import { mergeContacts, type MergeState } from "@/lib/actions/merge-contacts";

let svc: SupabaseClient;
let pg: Client;
let adminA: TestUser;
let agentA: TestUser;
let adminB: TestUser;
const userIds: string[] = [];
const stageOf: Record<string, string> = {};
let n = 0;

async function sessionClient(user: TestUser): Promise<SupabaseClient> {
  const { data } = await user.client.auth.getSession();
  const s = data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await c.auth.setSession({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
  });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  return c;
}

async function merge(user: TestUser, primaryId: string, duplicateId: string): Promise<MergeState> {
  state.queue.push(await sessionClient(user));
  const fd = new FormData();
  fd.set("primary_id", primaryId);
  fd.set("duplicate_id", duplicateId);
  return mergeContacts({ error: null, mergedAt: null }, fd);
}

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await svc.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table} fixture: ${error.message}`);
  return (data as { id: string }).id;
}

const phone = () => `+3579${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

async function contact(org: string, label: string, extra: Record<string, unknown> = {}) {
  n += 1;
  return ins("contacts", {
    org_id: org,
    first_name: `ZZMerge${label}`,
    last_name: `${RUN}${n}`,
    phone_e164: phone(),
    ...extra,
  });
}

async function property(org: string, extra: Record<string, unknown> = {}) {
  n += 1;
  return ins("properties", {
    org_id: org,
    reference: `ZZCM${RUN.slice(-4).toUpperCase()}${n}`,
    property_type: "apartment",
    status: "available",
    ...extra,
  });
}

/** One reference to a contact: table, column, row id, plus the filter it must keep. */
interface Ref {
  name: string;
  table: string;
  column: string;
  id: string;
}

/**
 * Every column the action repoints, each holding the duplicate — on A's side
 * all fourteen, on B's side every one the schema lets a B row hold.
 */
async function world() {
  const primary = await contact(ORG_A, "Keep", { email: null, notes: null });
  const dupPhone = phone();
  const duplicate = await contact(ORG_A, "Gone", {
    phone_e164: dupPhone,
    email: `zzmerge-${RUN}-${n}@dup.example`,
    notes: "duplicate note",
  });
  const earlier = await contact(ORG_A, "Earlier", {
    phone_e164: null,
    is_archived: true,
    merged_into_id: duplicate,
  });

  const a: Ref[] = [];
  const b: Ref[] = [];
  const add = (list: Ref[], name: string, table: string, column: string, id: string) =>
    list.push({ name, table, column, id });

  // --- A: every repointed column names the duplicate --------------------------
  const propA = await property(ORG_A, { owner_contact_id: duplicate, developer_contact_id: duplicate });
  add(a, "properties.owner_contact_id", "properties", "owner_contact_id", propA);
  add(a, "properties.developer_contact_id", "properties", "developer_contact_id", propA);
  const dealA = await ins("deals", {
    org_id: ORG_A,
    deal_type: "sale",
    stage_id: stageOf[ORG_A],
    title: `ZZCM ${RUN} A`,
    buyer_contact_id: duplicate,
    seller_contact_id: duplicate,
  });
  add(a, "deals.buyer_contact_id", "deals", "buyer_contact_id", dealA);
  add(a, "deals.seller_contact_id", "deals", "seller_contact_id", dealA);
  add(a, "offers.contact_id", "offers", "contact_id",
    await ins("offers", { org_id: ORG_A, deal_id: dealA, amount: 1000, contact_id: duplicate }));
  add(a, "leads.contact_id", "leads", "contact_id",
    await ins("leads", { org_id: ORG_A, contact_id: duplicate }));
  add(a, "viewings.contact_id", "viewings", "contact_id",
    await ins("viewings", {
      org_id: ORG_A,
      contact_id: duplicate,
      property_id: propA,
      agent_id: adminA.id,
      scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
    }));
  add(a, "buyer_requirements.contact_id", "buyer_requirements", "contact_id",
    await ins("buyer_requirements", { org_id: ORG_A, contact_id: duplicate }));
  add(a, "reservations.contact_id", "reservations", "contact_id",
    await ins("reservations", {
      org_id: ORG_A,
      contact_id: duplicate,
      property_id: propA,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }));
  add(a, "share_links.contact_id", "share_links", "contact_id",
    await ins("share_links", {
      org_id: ORG_A,
      contact_id: duplicate,
      token_sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }));
  add(a, "tasks.contact_id", "tasks", "contact_id",
    await ins("tasks", { org_id: ORG_A, title: `ZZCM ${RUN} A`, contact_id: duplicate }));
  add(a, "mandates.owner_contact_id", "mandates", "owner_contact_id",
    await ins("mandates", { org_id: ORG_A, property_id: propA, type: "open", owner_contact_id: duplicate }));
  add(a, "documents.entity_id", "documents", "entity_id",
    await ins("documents", {
      org_id: ORG_A,
      entity_type: "contact",
      entity_id: duplicate,
      title: "ZZCM doc",
      storage_path: `zz/${RUN}/${randomUUID()}.pdf`,
    }));
  add(a, "contacts.merged_into_id", "contacts", "merged_into_id", earlier);

  // an A document of ANOTHER entity type whose id happens to equal the
  // duplicate's: the entity_type predicate is what leaves it alone
  const otherTypeDoc = await ins("documents", {
    org_id: ORG_A,
    entity_type: "property",
    entity_id: duplicate,
    title: "ZZCM other-type doc",
    storage_path: `zz/${RUN}/${randomUUID()}.pdf`,
  });

  // --- B: every single-column link the schema lets a B row point at A ---------
  // The lead goes through B's OWN admin session, as a crafted request would.
  const bClient = await sessionClient(adminB);
  const planted = await bClient
    .from("leads")
    .insert({ org_id: ORG_B, contact_id: duplicate })
    .select("id")
    .single();
  const bLead = planted.data?.id as string | undefined;
  add(b, "leads.contact_id", "leads", "contact_id",
    bLead ?? (await ins("leads", { org_id: ORG_B, contact_id: duplicate })));

  const propB = await property(ORG_B, { owner_contact_id: duplicate, developer_contact_id: duplicate });
  add(b, "properties.owner_contact_id", "properties", "owner_contact_id", propB);
  add(b, "properties.developer_contact_id", "properties", "developer_contact_id", propB);
  const dealB = await ins("deals", {
    org_id: ORG_B,
    deal_type: "sale",
    stage_id: stageOf[ORG_B],
    title: `ZZCM ${RUN} B`,
    buyer_contact_id: duplicate,
    seller_contact_id: duplicate,
  });
  add(b, "deals.buyer_contact_id", "deals", "buyer_contact_id", dealB);
  add(b, "deals.seller_contact_id", "deals", "seller_contact_id", dealB);
  add(b, "offers.contact_id", "offers", "contact_id",
    await ins("offers", { org_id: ORG_B, deal_id: dealB, amount: 1000, contact_id: duplicate }));
  add(b, "buyer_requirements.contact_id", "buyer_requirements", "contact_id",
    await ins("buyer_requirements", { org_id: ORG_B, contact_id: duplicate }));
  add(b, "share_links.contact_id", "share_links", "contact_id",
    await ins("share_links", {
      org_id: ORG_B,
      contact_id: duplicate,
      token_sha256: createHash("sha256").update(randomBytes(16)).digest("hex"),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }));
  add(b, "mandates.owner_contact_id", "mandates", "owner_contact_id",
    await ins("mandates", { org_id: ORG_B, property_id: propB, type: "open", owner_contact_id: duplicate }));
  add(b, "documents.entity_id", "documents", "entity_id",
    await ins("documents", {
      org_id: ORG_B,
      entity_type: "contact",
      entity_id: duplicate,
      title: "ZZCM doc B",
      storage_path: `zz/${RUN}/${randomUUID()}.pdf`,
    }));
  add(b, "contacts.merged_into_id", "contacts", "merged_into_id",
    await contact(ORG_B, "Foreign", { phone_e164: null, is_archived: true, merged_into_id: duplicate }));

  return {
    primary,
    duplicate,
    dupPhone,
    earlier,
    otherTypeDoc,
    propB,
    a,
    b,
    plantedThroughB: planted.error ? `refused: ${planted.error.code} ${planted.error.message}` : "accepted",
  };
}

async function valueOf(ref: Ref): Promise<string | null> {
  const { rows } = await pg.query(`select ${ref.column}::text as v from public.${ref.table} where id = $1`, [
    ref.id,
  ]);
  if (rows.length !== 1) throw new Error(`${ref.name} ${ref.id}: row missing`);
  return rows[0].v;
}

async function snapshot(refs: Ref[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const r of refs) out[r.name] = await valueOf(r);
  return out;
}

const all = (refs: Ref[], v: string) => Object.fromEntries(refs.map((r) => [r.name, v]));

async function contactRow(id: string) {
  const { rows } = await pg.query(
    `select org_id, is_archived, merged_into_id, email, phone_e164, additional_phones, notes
       from contacts where id = $1`,
    [id],
  );
  return rows[0] as {
    org_id: string;
    is_archived: boolean;
    merged_into_id: string | null;
    email: string | null;
    phone_e164: string | null;
    additional_phones: string[] | null;
    notes: string | null;
  };
}

async function eventCount(org: string): Promise<number> {
  const { rows } = await pg.query("select count(*)::int as c from events where org_id = $1", [org]);
  return rows[0].c;
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG_A, `Merge A ${RUN}`, `merge-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `Merge B ${RUN}`, `merge-b-${RUN}`);
  adminA = await createTestUser(svc, `cm-admin-a-${RUN}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `cm-agent-a-${RUN}@test.local`, "agent", ORG_A);
  adminB = await createTestUser(svc, `cm-admin-b-${RUN}@test.local`, "admin", ORG_B);
  userIds.push(adminA.id, agentA.id, adminB.id);
  for (const org of [ORG_A, ORG_B]) {
    const { rows } = await pg.query(
      "select id from deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1",
      [org],
    );
    stageOf[org] = rows[0].id;
  }
});

afterAll(async () => {
  const orgs = [ORG_A, ORG_B];
  for (const t of [
    "tasks",
    "offers",
    "reservations",
    "viewings",
    "share_links",
    "buyer_requirements",
    "mandates",
    "documents",
  ]) {
    await pg.query(`delete from ${t} where org_id = any($1)`, [orgs]);
  }
  await pg.query("delete from leads where org_id = any($1)", [orgs]);
  await pg.query("delete from deals where org_id = any($1)", [orgs]);
  await pg.query(
    "update properties set owner_contact_id = null, developer_contact_id = null where org_id = any($1)",
    [orgs],
  );
  await pg.query("update contacts set merged_into_id = null where org_id = any($1)", [orgs]);
  await pg.query("delete from interaction_notes where org_id = any($1)", [orgs]);
  await pg.query("delete from contacts where org_id = any($1)", [orgs]);
  await pg.query("delete from properties where org_id = any($1)", [orgs]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await pg.query("delete from profiles where org_id = any($1)", [orgs]);
  await pg.query("delete from events where org_id = any($1)", [orgs]);
  await pg.query("delete from events_chain_checkpoint where org_id = any($1)", [orgs]);
  await pg.query("delete from chain_checks where org_id = any($1)", [orgs]);
  await pg.query("delete from deal_stages where org_id = any($1)", [orgs]);
  await pg.query("delete from districts where org_id = any($1)", [orgs]);
  await pg.query("delete from organizations where id = any($1)", [orgs]);
  await pg.end();
});

describe("preconditions: what the schema and policies admit today", () => {
  it("the live links onto contacts are exactly the ones the action repoints", async () => {
    const { rows } = await pg.query<{ link: string }>(
      `select c.conrelid::regclass::text || '.' || a.attname as link
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[array_length(c.conkey, 1)]
        where c.contype = 'f' and c.confrelid = 'public.contacts'::regclass
        order by 1`,
    );
    expect(rows.map((r) => r.link)).toEqual([
      "buyer_requirements.contact_id",
      "contacts.merged_into_id",
      "deals.buyer_contact_id",
      "deals.seller_contact_id",
      "leads.contact_id",
      "mandates.owner_contact_id",
      "offers.contact_id",
      "properties.developer_contact_id",
      "properties.owner_contact_id",
      "reservations.contact_id",
      "share_links.contact_id",
      "tasks.contact_id",
      "viewings.contact_id",
    ]);
  });

  it("B cannot read A's contacts, but B's admin CAN store a lead naming one", async () => {
    const w = await world();
    const bClient = await sessionClient(adminB);
    const { data: seen } = await bClient.from("contacts").select("id").in("id", [w.primary, w.duplicate]);
    expect(seen ?? []).toEqual([]);
    console.log(`[evidence] B admin POST /leads naming A's duplicate: ${w.plantedThroughB}`);
    expect(w.plantedThroughB).toBe("accepted");
  });

  it("viewings, reservations and tasks refuse a B row naming A's contact (0123 / 0126)", async () => {
    const dup = await contact(ORG_A, "Probe");
    const propB = await property(ORG_B);
    const tries = await Promise.all([
      svc.from("viewings").insert({
        org_id: ORG_B,
        contact_id: dup,
        property_id: propB,
        agent_id: adminB.id,
        scheduled_at: new Date().toISOString(),
      }),
      svc.from("reservations").insert({
        org_id: ORG_B,
        contact_id: dup,
        property_id: propB,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      svc.from("tasks").insert({ org_id: ORG_B, title: "ZZCM probe", contact_id: dup }),
    ]);
    expect(tries.map((t) => t.error?.code)).toEqual(["23503", "23503", "23503"]);
  });
});

describe("A's merge stays inside A", () => {
  it("moves every A reference, leaves every B reference, archives and backfills", async () => {
    const w = await world();
    const bEventsBefore = await eventCount(ORG_B);
    const res = await merge(adminA, w.primary, w.duplicate);
    expect(res.error).toBeNull();

    const aAfter = await snapshot(w.a);
    const bAfter = await snapshot(w.b);
    console.log(`[evidence] after A's merge\n  A: ${JSON.stringify(aAfter)}\n  B: ${JSON.stringify(bAfter)}`);

    // every A reference follows the duplicate onto the primary
    expect(aAfter).toEqual(all(w.a, w.primary));
    // no B reference moved — each still names what B stored
    expect(bAfter).toEqual(all(w.b, w.duplicate));

    // B learns nothing through its own lead: it still reads the id it wrote
    const bClient = await sessionClient(adminB);
    const bLead = w.b.find((r) => r.name === "leads.contact_id")!;
    const { data: lead } = await bClient.from("leads").select("contact_id").eq("id", bLead.id).single();
    expect(lead?.contact_id).toBe(w.duplicate);
    expect(lead?.contact_id).not.toBe(w.primary);

    // the other-type document is left alone
    const { rows: doc } = await pg.query("select entity_id::text from documents where id = $1", [w.otherTypeDoc]);
    expect(doc[0].entity_id).toBe(w.duplicate);

    // the duplicate is archived onto the primary, never onto itself
    const dup = await contactRow(w.duplicate);
    expect(dup).toMatchObject({ is_archived: true, merged_into_id: w.primary });

    // backfill: the primary took the e-mail and keeps the duplicate's number reachable
    const pri = await contactRow(w.primary);
    expect(pri.email).toBe((await contactRow(w.duplicate)).email);
    expect(pri.additional_phones).toContain(w.dupPhone);
    expect(pri.notes).toContain("duplicate note");

    // events: one of each, in A, by A's admin — nothing written into B
    const { rows: evs } = await pg.query(
      `select entity_id::text, event_type, org_id::text, actor_id::text, payload
         from events where entity_id = any($1) and event_type in ('merged', 'archived') order by id`,
      [[w.primary, w.duplicate]],
    );
    expect(evs).toEqual([
      {
        entity_id: w.primary,
        event_type: "merged",
        org_id: ORG_A,
        actor_id: adminA.id,
        payload: { merged_contact_id: w.duplicate, dropped_fields: [] },
      },
      {
        entity_id: w.duplicate,
        event_type: "archived",
        org_id: ORG_A,
        actor_id: adminA.id,
        payload: { merged_into: w.primary },
      },
    ]);
    expect(await eventCount(ORG_B)).toBe(bEventsBefore);
  });

  it("a merge interrupted after the archive resumes, moves A's rows and still leaves B's", async () => {
    const w = await world();
    // step 1 ran, then the request died
    await pg.query("update contacts set is_archived = true, merged_into_id = $1 where id = $2", [
      w.primary,
      w.duplicate,
    ]);
    const res = await merge(adminA, w.primary, w.duplicate);
    expect(res.error).toBeNull();
    expect(await snapshot(w.a)).toEqual(all(w.a, w.primary));
    expect(await snapshot(w.b)).toEqual(all(w.b, w.duplicate));
    expect(await contactRow(w.duplicate)).toMatchObject({ is_archived: true, merged_into_id: w.primary });

    // and running it a third time is a no-op for both organisations
    const again = await merge(adminA, w.primary, w.duplicate);
    expect(again.error).toBeNull();
    expect(await snapshot(w.a)).toEqual(all(w.a, w.primary));
    expect(await snapshot(w.b)).toEqual(all(w.b, w.duplicate));
    const pri = await contactRow(w.primary);
    expect(pri.notes?.split("duplicate note").length).toBe(2); // appended once
  });
});

describe("who may merge", () => {
  it("an agent cannot merge, and nothing moves", async () => {
    const w = await world();
    const res = await merge(agentA, w.primary, w.duplicate);
    expect(res.error).toBe("Only admins can merge contacts");
    expect(await snapshot(w.a)).toEqual(all(w.a, w.duplicate));
    expect((await contactRow(w.duplicate)).is_archived).toBe(false);
  });

  it("B's admin cannot merge A's contacts — neither both, nor one into its own", async () => {
    const w = await world();
    const bOwn = await contact(ORG_B, "BOwn");
    const tries = [
      await merge(adminB, w.primary, w.duplicate),
      await merge(adminB, bOwn, w.duplicate),
      await merge(adminB, w.primary, bOwn),
    ];
    for (const r of tries) {
      expect(r.error).not.toBeNull();
      expect(r.mergedAt).toBeNull();
    }
    expect(await snapshot(w.a)).toEqual(all(w.a, w.duplicate));
    expect(await snapshot(w.b)).toEqual(all(w.b, w.duplicate));
    expect(await contactRow(w.duplicate)).toMatchObject({ is_archived: false, merged_into_id: null });
    expect(await contactRow(bOwn)).toMatchObject({ is_archived: false, merged_into_id: null });
  });

  it("an unknown contact id is refused with nothing written", async () => {
    const w = await world();
    const res = await merge(adminA, w.primary, randomUUID());
    expect(res.error).toBe("Contact not found");
    expect(await snapshot(w.a)).toEqual(all(w.a, w.duplicate));
  });
});
