import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { VIEWING_EXPORT_SELECT } from "@/lib/services/viewing-export";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * 0123: a viewing belongs to the organisation of the property it shows and
 * of the contact it is for, and the nightly sweep's viewing reminders read
 * only the viewing's own organisation's property. The viewing's own
 * parent-link sequel of 0120 (task-viewing-org-isolation.test.ts), in 0122's
 * shape (mandate-key-parent-org-isolation.test.ts).
 *
 * THE GAP, as it stood at 0122 (measured through PostgREST): `viewings.
 * property_id` and `viewings.contact_id` referenced `properties(id)` /
 * `contacts(id)` alone (0001) and `viewings_insert` / `viewings_update` check
 * only the CALLER's organisation, so a member of B could put a B viewing on
 * A's property or A's contact — neither of which B can read — and a real vs
 * missing id answered 201 vs 23503 on each link. The nightly sweep's arms 2
 * and 2b (`create_followup_nudges`, 0078) join `properties p on p.id =
 * v.property_id` with no organisation predicate, so such a viewing earned B a
 * reminder whose title carried A's property reference and whose property_id
 * was A's. The tests marked "RED at 0122" failed against 0122's catalogue
 * before the migration; the rest pin what must not change.
 *
 * TWO KINDS OF CALLER, as in 0119–0122: supabase-js through PostgREST (aal2
 * sessions — the fixtures enrol TOTP factors, so `require_aal2` binds them as
 * it binds real users), and one `pg` session as postgres — pg_cron's role —
 * for fixtures, verification, cleanup, the scheduled sweep and the migration
 * replays. EVERY SWEEP AND EVERY REPLAY RUNS INSIDE A TRANSACTION THAT IS
 * ROLLED BACK after its reads: the sweep is global, the replays rewrite the
 * catalogue, and the malformed rows the sweep tests need (a viewing of B on
 * A's property, planted past the key with `session_replication_role =
 * replica`, allowed to postgres through supautils) never outlive the test.
 * This file is never pointed at hosted.
 *
 * TWO THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORGS = [ORG_A, ORG_B];
const RUN = Date.now().toString(36);

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, "..", "migrations", "0123_viewing_parent_org_isolation.sql");
/** create_followup_nudges' body as 0078 wrote it (CR-stripped md5 of prosrc). */
const MD5_0078 = "09f1d9363b2d3f699dbae71a8ef3f66a";
/** The one line 0123 adds, twice (arms 2 and 2b). */
const ORG_LINE = "\n       and p.org_id = v.org_id";

let o: Client;
let svc: SupabaseClient;

let adminA: TestUser;
let agentA: TestUser;
let adminB: TestUser;
let agentB: TestUser;
const userIds: string[] = [];
let n = 0;

type Parent = { id: string; reference: string };
type Person = { id: string; name: string };
let propA: Parent;
let propB: Parent;
let contactA: Person;
let contactB: Person;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function newProperty(org: string): Promise<Parent> {
  n += 1;
  const { rows } = await o.query<Parent>(
    `insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id, reference`,
    [org, `VPO${RUN}${n}`.toUpperCase()],
  );
  return rows[0]!;
}

async function newContact(org: string): Promise<Person> {
  n += 1;
  const name = `ZZTEST Viewer${n} ${RUN}`;
  const { rows } = await o.query<{ id: string }>(
    `insert into contacts (org_id, first_name) values ($1, $2) returning id`,
    [org, name],
  );
  return { id: rows[0]!.id, name };
}

type ViewingOpts = {
  status?: "scheduled" | "completed" | "no_show" | "cancelled";
  /** hours in the past (negative = the future) */
  hoursAgo?: number;
  agent?: string;
  createdBy?: string;
};

/** A viewing as postgres. `plant` writes it past the keys (replica mode, this transaction or statement only). */
async function newViewing(org: string, property: string, contact: string, opts: ViewingOpts & { plant?: boolean } = {}) {
  const agent = opts.agent ?? (org === ORG_A ? agentA.id : agentB.id);
  const sql = `insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at, status, created_by)
               values ($1, $2, $3, $4, now() - make_interval(hours => $5::int), $6::viewing_status, $7) returning id`;
  const params = [org, property, contact, agent, opts.hoursAgo ?? -24, opts.status ?? "scheduled", opts.createdBy ?? agent];
  if (!opts.plant) return (await o.query<{ id: string }>(sql, params)).rows[0]!.id;
  // inside the caller's transaction: replica for this one row, then back
  await o.query("set local session_replication_role = replica");
  try {
    return (await o.query<{ id: string }>(sql, params)).rows[0]!.id;
  } finally {
    await o.query("set local session_replication_role = origin");
  }
}

async function viewingRow(id: string) {
  const { rows } = await o.query<{ org_id: string; property_id: string; contact_id: string }>(
    "select org_id, property_id, contact_id from viewings where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

async function count(sql: string, params: unknown[] = []) {
  const { rows } = await o.query<{ c: number }>(sql, params);
  return rows[0]!.c;
}

/** Everything below the caller runs in ONE transaction on `o`, rolled back afterwards. */
async function rolledBack(body: () => Promise<void>) {
  await o.query("begin");
  try {
    await body();
  } finally {
    await o.query("rollback");
  }
}

const sweep = (org: string | null = null) =>
  o.query("select public.create_followup_nudges($1::uuid)", [org]);

async function tasksOn(viewing: string) {
  const { rows } = await o.query<{
    id: string;
    org_id: string;
    kind: string;
    title: string;
    property_id: string | null;
    assignee_id: string | null;
    is_done: boolean;
  }>(
    `select id, org_id, kind, title, property_id, assignee_id, is_done from tasks
      where viewing_id = $1 order by created_at, id`,
    [viewing],
  );
  return rows;
}

async function viewingEvents(viewing: string) {
  const { rows } = await o.query<{ org_id: string; event_type: string; actor_id: string | null; payload: Record<string, unknown> }>(
    `select org_id, event_type, actor_id, payload from events
      where org_id = any($2::uuid[]) and entity_type = 'viewing' and entity_id = $1 order by id`,
    [viewing, ORGS],
  );
  return rows;
}

async function chainOk(org: string) {
  const { rows } = await o.query<{ ok: boolean }>("select public.verify_events_chain($1) as ok", [org]);
  return rows[0]!.ok;
}

/**
 * Nothing of B's — task or event — names or carries anything of A's property
 * `p`. The TASK half is what arms 2 / 2b broke at 0122 (title and
 * property_id); their event payloads carry ids of B's own task and viewing
 * only, so the EVENT half is defensive — it fails only if a future payload
 * starts copying the property.
 */
async function bHoldsNothingOf(p: Parent) {
  expect(
    await count(
      `select count(*)::int as c from tasks
        where org_id = $1 and (property_id = $2 or position($3 in title) > 0)`,
      [ORG_B, p.id, p.reference],
    ),
    "no task of B names A's property or carries its reference",
  ).toBe(0);
  expect(
    await count(
      `select count(*)::int as c from events
        where org_id = $1 and (payload::text like '%' || $2 || '%' or payload::text like '%' || $3 || '%')`,
      [ORG_B, p.id, p.reference],
    ),
    "no event of B carries A's property id or reference",
  ).toBe(0);
}

/**
 * Fresh parents for one rolled-back sweep scenario. The file's shared parents
 * carry committed future viewings from the tests above, and arm 2b reads any
 * later viewing of the same contact and property as the rebooking already made.
 */
async function sweepParents() {
  return {
    pa: await newProperty(ORG_A),
    ca: (await newContact(ORG_A)).id,
    pb: await newProperty(ORG_B),
    cb: (await newContact(ORG_B)).id,
  };
}

/** 0122's catalogue for this file's objects, inside the caller's transaction. */
async function revertTo0122() {
  await o.query(`
    alter table public.viewings drop constraint viewings_org_property_fkey;
    alter table public.viewings drop constraint viewings_org_contact_fkey;
    drop index public.viewings_org_property_idx;
    drop index public.viewings_org_contact_idx;
    alter table public.contacts drop constraint contacts_org_id_id_key;
    alter table public.viewings add constraint viewings_property_id_fkey foreign key (property_id) references public.properties(id);
    alter table public.viewings add constraint viewings_contact_id_fkey foreign key (contact_id) references public.contacts(id);
    do $$
    declare b text;
    begin
      select prosrc into b from pg_proc where oid = 'public.create_followup_nudges(uuid)'::regprocedure;
      execute format('create or replace function public.create_followup_nudges(p_org uuid default null) returns void '
                     'language sql security definer set search_path = public as %L',
                     replace(b, E'\\n       and p.org_id = v.org_id', ''));
    end $$;
    comment on function public.create_followup_nudges(uuid) is null;
  `);
}

async function sweepMd5() {
  const { rows } = await o.query<{ m: string }>(
    "select md5(replace(prosrc, E'\\r', '')) as m from pg_proc where oid = 'public.create_followup_nudges(uuid)'::regprocedure",
  );
  return rows[0]!.m;
}

async function viewingKeys() {
  const { rows } = await o.query<{ conname: string; def: string; convalidated: boolean }>(
    `select conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint
      where conrelid = 'public.viewings'::regclass and contype = 'f'
        and confrelid in ('public.properties'::regclass, 'public.contacts'::regclass)
      order by conname`,
  );
  return rows;
}

const KEYS_0123 = [
  { conname: "viewings_org_contact_fkey", def: "FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)", convalidated: true },
  { conname: "viewings_org_property_fkey", def: "FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id)", convalidated: true },
];
const KEYS_0122 = [
  { conname: "viewings_contact_id_fkey", def: "FOREIGN KEY (contact_id) REFERENCES contacts(id)", convalidated: true },
  { conname: "viewings_property_id_fkey", def: "FOREIGN KEY (property_id) REFERENCES properties(id)", convalidated: true },
];

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();

  await ensureTestOrg(svc, ORG_A, `viewing-parents A ${RUN}`, `viewing-parents-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `viewing-parents B ${RUN}`, `viewing-parents-b-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors ({} messages)
  adminA = await createTestUser(svc, `vpo-admin-a-${RUN}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `vpo-agent-a-${RUN}@test.local`, "agent", ORG_A);
  adminB = await createTestUser(svc, `vpo-admin-b-${RUN}@test.local`, "admin", ORG_B);
  agentB = await createTestUser(svc, `vpo-agent-b-${RUN}@test.local`, "agent", ORG_B);
  userIds.push(adminA.id, agentA.id, adminB.id, agentB.id);

  propA = await newProperty(ORG_A);
  propB = await newProperty(ORG_B);
  contactA = await newContact(ORG_A);
  contactB = await newContact(ORG_B);
});

afterAll(async () => {
  await o.query("delete from tasks where org_id = any($1::uuid[])", [ORGS]);
  // one statement: a viewing of either organisation may name the other's parents
  await o.query("delete from viewing_slips where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from viewings where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from contacts where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const org of ORGS) {
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
describe("the premise: organisation B cannot read A's property or contact", () => {
  it("B's admin and agent see neither; A's admin sees both", async () => {
    for (const c of [adminB.client, agentB.client]) {
      expect((await c.from("properties").select("id").eq("id", propA.id)).data).toEqual([]);
      expect((await c.from("contacts").select("id").eq("id", contactA.id)).data).toEqual([]);
    }
    expect((await adminA.client.from("properties").select("id").eq("id", propA.id)).data).toEqual([{ id: propA.id }]);
    expect((await adminA.client.from("contacts").select("id").eq("id", contactA.id)).data).toEqual([{ id: contactA.id }]);
  });
});

describe("B cannot put a viewing on A's property or A's contact (23503, nothing written) — RED at 0122", () => {
  /** createViewing's insert, field for field (lib/actions/viewings.ts), as B's session sends it. */
  const createShape = (who: TestUser, property: string, contact: string, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    property_id: property,
    contact_id: contact,
    agent_id: who.id,
    deal_id: null,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
    duration_min: 30,
    created_by: who.id,
    ...extra,
  });

  it("INSERT naming A's property — as B's agent and as B's admin", async () => {
    for (const who of [agentB, adminB]) {
      const r = await who.client.from("viewings").insert(createShape(who, propA.id, contactB.id)).select("id");
      expect(r.error?.code, who.email).toBe("23503");
      expect(r.data, who.email).toBeNull();
    }
    expect(await count("select count(*)::int as c from viewings where org_id = $1 and property_id = $2", [ORG_B, propA.id])).toBe(0);
  });

  it("INSERT naming A's contact — as B's agent and as B's admin", async () => {
    for (const who of [agentB, adminB]) {
      const r = await who.client.from("viewings").insert(createShape(who, propB.id, contactA.id)).select("id");
      expect(r.error?.code, who.email).toBe("23503");
    }
    expect(await count("select count(*)::int as c from viewings where org_id = $1 and contact_id = $2", [ORG_B, contactA.id])).toBe(0);
  });

  it("UPDATE — B's viewing cannot be re-pointed at A's property or A's contact, by its agent or by B's admin", async () => {
    const mine = await newViewing(ORG_B, propB.id, contactB.id);
    for (const who of [agentB, adminB]) {
      const p = await who.client.from("viewings").update({ property_id: propA.id }).eq("id", mine).select("id");
      expect(p.error?.code, `${who.email} property`).toBe("23503");
      const c = await who.client.from("viewings").update({ contact_id: contactA.id }).eq("id", mine).select("id");
      expect(c.error?.code, `${who.email} contact`).toBe("23503");
    }
    expect(await viewingRow(mine)).toEqual({ org_id: ORG_B, property_id: propB.id, contact_id: contactB.id });
  });

  it("UPSERT — onto B's existing viewing (merge) and as a new id, for each link: refused, nothing written", async () => {
    const mine = await newViewing(ORG_B, propB.id, contactB.id);
    for (const [link, property, contact] of [
      ["property", propA.id, contactB.id],
      ["contact", propB.id, contactA.id],
    ] as const) {
      const merge = await adminB.client
        .from("viewings")
        .upsert({ id: mine, ...createShape(adminB, property, contact) }, { onConflict: "id" })
        .select("id");
      expect(merge.error?.code, `${link} merge`).toBe("23503");
      const fresh = randomUUID();
      const insert = await agentB.client
        .from("viewings")
        .upsert({ id: fresh, ...createShape(agentB, property, contact) }, { onConflict: "id" })
        .select("id");
      expect(insert.error?.code, `${link} new id`).toBe("23503");
      expect(await viewingRow(fresh), `${link} new id`).toBeNull();
    }
    expect(await viewingRow(mine)).toEqual({ org_id: ORG_B, property_id: propB.id, contact_id: contactB.id });
  });

  it("the refusal no longer tells B whether an A property or contact id exists, and carries nothing of A's", async () => {
    for (const [link, real, other] of [
      ["property", propA.id, { contact_id: contactB.id }],
      ["contact", contactA.id, { property_id: propB.id }],
    ] as const) {
      const missing = randomUUID();
      const col = link === "property" ? "property_id" : "contact_id";
      const a = await agentB.client.from("viewings").insert(createShape(agentB, propB.id, contactB.id, { ...other, [col]: real })).select("id");
      const b = await agentB.client.from("viewings").insert(createShape(agentB, propB.id, contactB.id, { ...other, [col]: missing })).select("id");
      expect(a.error?.code, `${link}: an A id`).toBe("23503");
      expect(b.error?.code, `${link}: a missing id`).toBe("23503");
      expect(a.error?.message, link).toBe(b.error?.message);
      // the detail names only what B sent (its own organisation and the id it chose)
      expect((a.error?.details ?? "").replace(real, "<id>"), link).toBe((b.error?.details ?? "").replace(missing, "<id>"));
      const body = JSON.stringify(a.error);
      for (const secret of [ORG_A, propA.reference, contactA.name]) expect(body, `${link}: ${secret}`).not.toContain(secret);
    }
  });

  it("the keys bind writers that bypass the application and RLS: the service role and the table owner", async () => {
    const svcIns = await svc
      .from("viewings")
      .insert({ org_id: ORG_B, property_id: propA.id, contact_id: contactB.id, agent_id: agentB.id, scheduled_at: new Date().toISOString() })
      .select("id");
    expect(svcIns.error?.code, "service role, A's property").toBe("23503");
    const svcIns2 = await svc
      .from("viewings")
      .insert({ org_id: ORG_B, property_id: propB.id, contact_id: contactA.id, agent_id: agentB.id, scheduled_at: new Date().toISOString() })
      .select("id");
    expect(svcIns2.error?.code, "service role, A's contact").toBe("23503");
    await expect(newViewing(ORG_B, propA.id, contactB.id)).rejects.toMatchObject({ code: "23503", constraint: "viewings_org_property_fkey" });
    await expect(newViewing(ORG_B, propB.id, contactA.id)).rejects.toMatchObject({ code: "23503", constraint: "viewings_org_contact_fkey" });
    expect(await count("select count(*)::int as c from viewings where org_id = $1 and (property_id = $2 or contact_id = $3)", [ORG_B, propA.id, contactA.id])).toBe(0);
  });

  it("a viewing's organisation cannot move away from its parents' (RLS for a session, the keys for the service role), nor a parent's organisation out from under its viewings", async () => {
    const p = await newProperty(ORG_A);
    const c = await newContact(ORG_A);
    const v = await newViewing(ORG_A, p.id, c.id);
    const user = await adminA.client.from("viewings").update({ org_id: ORG_B }).eq("id", v).select("id");
    expect(user.error?.code, "viewings_update WITH CHECK").toBe("42501");
    const maintenance = await svc.from("viewings").update({ org_id: ORG_B }).eq("id", v).select("id");
    expect(maintenance.error?.code).toBe("23503");
    expect((await viewingRow(v))!.org_id).toBe(ORG_A);
    const moveProperty = await svc.from("properties").update({ org_id: ORG_B }).eq("id", p.id).select("id");
    expect(moveProperty.error?.code, "a property under a viewing keeps its organisation").toBe("23503");
    const moveContact = await svc.from("contacts").update({ org_id: ORG_B }).eq("id", c.id).select("id");
    expect(moveContact.error?.code, "a contact under a viewing keeps its organisation").toBe("23503");
    expect(await count("select count(*)::int as c from properties where id = $1 and org_id = $2", [p.id, ORG_A])).toBe(1);
    expect(await count("select count(*)::int as c from contacts where id = $1 and org_id = $2", [c.id, ORG_A])).toBe(1);
  });
});

describe("same-organisation links, embeds and deletion stay as they were", () => {
  it("A's agent creates a viewing (createViewing's shape); A's admin re-points it within A; the merge's repoint and a reschedule succeed", async () => {
    const p2 = await newProperty(ORG_A);
    const c2 = await newContact(ORG_A);
    const created = await agentA.client
      .from("viewings")
      .insert({
        org_id: ORG_A,
        property_id: propA.id,
        contact_id: contactA.id,
        agent_id: agentA.id,
        deal_id: null,
        scheduled_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        duration_min: 45,
        created_by: agentA.id,
      })
      .select("id")
      .single();
    expect(created.error).toBeNull();
    const id = created.data!.id;
    const moved = await adminA.client.from("viewings").update({ property_id: p2.id, contact_id: c2.id }).eq("id", id).select("id");
    expect(moved.error).toBeNull();
    expect(moved.data, "RLS refuses an UPDATE by matching zero rows").toEqual([{ id }]);
    // mergeContacts' repoint (lib/actions/merge-contacts.ts), on the admin client
    const merged = await svc.from("viewings").update({ contact_id: contactA.id }).eq("contact_id", c2.id).select("id");
    expect(merged.error).toBeNull();
    expect(merged.data).toEqual([{ id }]);
    // rescheduleViewing's write: the viewing's own agent, a compare-and-set on status
    const resched = await agentA.client
      .from("viewings")
      .update({ scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), duration_min: 60 })
      .eq("id", id)
      .eq("status", "scheduled")
      .select("id");
    expect(resched.error).toBeNull();
    expect(resched.data).toEqual([{ id }]);
    expect(await viewingRow(id)).toEqual({ org_id: ORG_A, property_id: p2.id, contact_id: contactA.id });
  });

  it("PostgREST embeds keep ONE relationship each way — the selects the app sends, and the reverse embeds", async () => {
    const v = await newViewing(ORG_A, propA.id, contactA.id);
    // app/(app)/viewings/[id]/page.tsx — the widest of the viewing selects
    const detail = await adminA.client
      .from("viewings")
      .select(
        `id, org_id, agent_id, scheduled_at, duration_min, status, feedback, property_id, deal_id,
         properties(id, reference, address),
         contacts(id, display_name, phone_e164),
         deals(id, title),
         agent:profiles!agent_id(full_name)`,
      )
      .eq("id", v)
      .single();
    expect(detail.error).toBeNull();
    const d = detail.data as unknown as { properties: { reference: string }; contacts: { display_name: string } };
    expect(d.properties.reference).toBe(propA.reference);
    expect(d.contacts.display_name).toBe(contactA.name);
    // app/(app)/viewings/page.tsx (list) and checkViewingConflicts (lib/actions/viewings.ts)
    const list = await agentA.client
      .from("viewings")
      .select("id, route_date, properties(reference), contacts(display_name), agent:profiles!agent_id(full_name)")
      .eq("id", v)
      .single();
    expect(list.error).toBeNull();
    const clash = await agentA.client
      .from("viewings")
      .select("id, scheduled_at, duration_min, agent_id, property_id, contact_id, properties(reference)")
      .or(`property_id.eq.${propA.id},contact_id.eq.${contactA.id}`)
      .eq("id", v);
    expect(clash.error).toBeNull();
    expect(clash.data).toHaveLength(1);
    // the CSV export (lib/services/viewing-export.ts) — viewing_slips too
    const exp = await adminA.client.from("viewings").select(VIEWING_EXPORT_SELECT).eq("id", v).single();
    expect(exp.error).toBeNull();
    expect((exp.data as unknown as { contacts: { display_name: string } }).contacts.display_name).toBe(contactA.name);
    // the reverse direction
    const fromProperty = await adminA.client.from("properties").select("id, viewings(id)").eq("id", propA.id).single();
    expect(fromProperty.error).toBeNull();
    expect((fromProperty.data as unknown as { viewings: { id: string }[] }).viewings.map((x) => x.id)).toContain(v);
    const fromContact = await adminA.client.from("contacts").select("id, viewings(id)").eq("id", contactA.id).single();
    expect(fromContact.error).toBeNull();
    expect((fromContact.data as unknown as { viewings: { id: string }[] }).viewings.map((x) => x.id)).toContain(v);
  });

  it("deletion: a property or a contact with viewings still cannot be deleted (NO ACTION, as before)", async () => {
    const p = await newProperty(ORG_A);
    const c = await newContact(ORG_A);
    await newViewing(ORG_A, p.id, c.id);
    await expect(o.query("delete from properties where id = $1", [p.id])).rejects.toMatchObject({
      code: "23503",
      constraint: expect.stringMatching(/^viewings_(org_property|property_id)_fkey$/),
    });
    await expect(o.query("delete from contacts where id = $1", [c.id])).rejects.toMatchObject({
      code: "23503",
      constraint: expect.stringMatching(/^viewings_(org_contact|contact_id)_fkey$/),
    });
  });
});

describe("the nightly sweep reads only the viewing's own property (rows planted past the keys, rolled back)", () => {
  let hours = 48;
  beforeAll(async () => {
    const { rows } = await o.query<{ h: number }>("select public.nudge_threshold('viewing_feedback_hours', 48)::int as h");
    hours = rows[0]!.h;
  });

  it("arm 2 (feedback): B's completed viewing on A's property earns B no reminder carrying A's reference — the global run — RED at 0122", async () => {
    await rolledBack(async () => {
      const { pa, pb, cb } = await sweepParents();
      const planted = await newViewing(ORG_B, pa.id, cb, { status: "completed", hoursAgo: hours + 24, plant: true });
      const own = await newViewing(ORG_B, pb.id, cb, { status: "completed", hoursAgo: hours + 24 });
      await sweep();
      expect(await tasksOn(planted), "no reminder for a viewing whose property is not its organisation's").toEqual([]);
      expect(await viewingEvents(planted)).toEqual([]);
      await bHoldsNothingOf(pa);
      const [t] = await tasksOn(own);
      expect(t, "B's own viewing is still served").toMatchObject({
        org_id: ORG_B,
        kind: "viewing_feedback",
        title: `Log viewing feedback: ${pb.reference}`,
        property_id: pb.id,
      });
    });
  });

  it("arm 2b (no-show): B's no-show on A's property earns B no rebooking reminder carrying A's reference — the org-scoped run — RED at 0122", async () => {
    await rolledBack(async () => {
      const { pa, pb, cb } = await sweepParents();
      const planted = await newViewing(ORG_B, pa.id, cb, { status: "no_show", hoursAgo: 30, plant: true });
      const own = await newViewing(ORG_B, pb.id, cb, { status: "no_show", hoursAgo: 30 });
      await sweep(ORG_B);
      expect(await tasksOn(planted), "no reminder for a viewing whose property is not its organisation's").toEqual([]);
      expect(await viewingEvents(planted)).toEqual([]);
      await bHoldsNothingOf(pa);
      const [t] = await tasksOn(own);
      expect(t, "B's own no-show is still served").toMatchObject({
        org_id: ORG_B,
        kind: "viewing_no_show",
        title: `Rebook after no-show: ${pb.reference}`,
        property_id: pb.id,
      });
    });
  });

  it("valid reminders for BOTH organisations — global and organisation-scoped, run twice: one task and one event each, the Cyprus due dates, the assignee fallback, the audit shape, the chains", async () => {
    await rolledBack(async () => {
      const { pa, ca, pb, cb } = await sweepParents();
      // planted rows of both kinds sit beside the valid ones throughout
      await newViewing(ORG_B, pa.id, cb, { status: "completed", hoursAgo: hours + 24, plant: true });
      await newViewing(ORG_B, pa.id, cb, { status: "no_show", hoursAgo: 30, plant: true });
      const aFb = await newViewing(ORG_A, pa.id, ca, { status: "completed", hoursAgo: hours + 24 });
      const aNs = await newViewing(ORG_A, pa.id, ca, { status: "no_show", hoursAgo: 30 });
      const bFb = await newViewing(ORG_B, pb.id, cb, { status: "completed", hoursAgo: hours + 30 });
      const bNs = await newViewing(ORG_B, pb.id, cb, { status: "no_show", hoursAgo: 40 });
      // B's agent is deactivated: B's reminders fall back past the agent and
      // the creator (the same person) to B's oldest active admin
      await o.query("update profiles set is_active = false where id = $1", [agentB.id]);

      await sweep(ORG_B);
      expect(await tasksOn(aFb), "an org-scoped run for B leaves A alone").toEqual([]);
      await sweep(ORG_B);
      await sweep(); // the global run serves A, and must not duplicate B's
      await sweep();

      const expectOne = async (viewing: string, org: string, kind: string, title: string, property: string, assignee: string) => {
        const tasks = await tasksOn(viewing);
        expect(tasks, `${kind} ${viewing}`).toHaveLength(1);
        expect(tasks[0]).toMatchObject({ org_id: org, kind, title, property_id: property, assignee_id: assignee, is_done: false });
        const ev = await viewingEvents(viewing);
        expect(ev.map((e) => [e.org_id, e.event_type, e.actor_id]), `${kind} events`).toEqual([[org, "followup_task_created", null]]);
        expect(ev[0]!.payload).toEqual(
          kind === "viewing_feedback"
            ? { kind, task_id: tasks[0]!.id, assignee_id: assignee, hours }
            : { kind, task_id: tasks[0]!.id, assignee_id: assignee },
        );
      };
      await expectOne(aFb, ORG_A, "viewing_feedback", `Log viewing feedback: ${pa.reference}`, pa.id, agentA.id);
      await expectOne(aNs, ORG_A, "viewing_no_show", `Rebook after no-show: ${pa.reference}`, pa.id, agentA.id);
      await expectOne(bFb, ORG_B, "viewing_feedback", `Log viewing feedback: ${pb.reference}`, pb.id, adminB.id);
      await expectOne(bNs, ORG_B, "viewing_no_show", `Rebook after no-show: ${pb.reference}`, pb.id, adminB.id);

      // due dates: Cyprus end-of-day of the feedback window's boundary, and
      // of the day after a missed slot (0052 / 0075), unchanged
      const { rows: due } = await o.query<{ ok: boolean }>(
        `select bool_and(
                  t.due_at = case t.kind
                    when 'viewing_feedback' then
                      ((((v.scheduled_at + make_interval(hours => $2::int)) at time zone 'Asia/Nicosia')::date)::timestamp
                        + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia'
                    else
                      ((((v.scheduled_at at time zone 'Asia/Nicosia')::date + 1))::timestamp
                        + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia'
                  end) as ok
           from tasks t join viewings v on v.id = t.viewing_id
          where t.viewing_id = any($1::uuid[])`,
        [[aFb, aNs, bFb, bNs], hours],
      );
      expect(due[0]!.ok).toBe(true);
      await bHoldsNothingOf(pa);
      expect(await chainOk(ORG_A)).toBe(true);
      expect(await chainOk(ORG_B)).toBe(true);
    });
  });

  it("completion stays the sweep's: feedback logged and a rebooking made complete the reminders with one `superseded` each, planted rows beside them", async () => {
    await rolledBack(async () => {
      const { pa, ca, cb } = await sweepParents();
      await newViewing(ORG_B, pa.id, cb, { status: "completed", hoursAgo: hours + 24, plant: true });
      const fb = await newViewing(ORG_A, pa.id, ca, { status: "completed", hoursAgo: hours + 24 });
      const ns = await newViewing(ORG_A, pa.id, ca, { status: "no_show", hoursAgo: 30 });
      await sweep();
      const [tf] = await tasksOn(fb);
      const [tn] = await tasksOn(ns);
      // feedback written with the edit-time trigger off (replica), so arm 4 —
      // the sweep's own self-heal — is what must complete the reminder
      await o.query("set local session_replication_role = replica");
      await o.query(`update viewings set feedback = '{"rating": 4}'::jsonb where id = $1`, [fb]);
      await o.query("set local session_replication_role = origin");
      // the rebooking arm 4b looks for: a later, non-cancelled viewing of the same contact and property
      await newViewing(ORG_A, pa.id, ca, { status: "scheduled", hoursAgo: -48 });
      await sweep();
      await sweep();
      const { rows } = await o.query<{ entity_id: string; event_type: string; actor_id: string | null; payload: Record<string, unknown> }>(
        `select entity_id, event_type, actor_id, payload from events
          where org_id = $1 and entity_type = 'task' and entity_id = any($2::uuid[]) order by id`,
        [ORG_A, [tf!.id, tn!.id]],
      );
      expect(rows).toEqual([
        { entity_id: tf!.id, event_type: "superseded", actor_id: null, payload: { kind: "viewing_feedback", viewing_id: fb, reason: "feedback_logged_or_viewing_reopened" } },
        { entity_id: tn!.id, event_type: "superseded", actor_id: null, payload: { kind: "viewing_no_show", viewing_id: ns, reason: "viewing_rebooked" } },
      ]);
      expect((await tasksOn(fb))[0]!.is_done).toBe(true);
      expect((await tasksOn(ns))[0]!.is_done).toBe(true);
      await bHoldsNothingOf(pa);
      expect(await chainOk(ORG_A)).toBe(true);
    });
  });
});

describe("the catalogue: two tenant-bound, validated relationships; the sweep's property joins scoped in its own text — RED at 0122", () => {
  it("viewings name their property and contact by (org_id, …) — validated, NO ACTION, the single-column keys gone; contacts (org_id, id) unique; the referencing indexes; the earlier tenant keys untouched", async () => {
    expect(await viewingKeys()).toEqual(KEYS_0123);
    const { rows: rules } = await o.query<{ d: string; u: string; m: string }>(
      `select string_agg(distinct confdeltype::text, '') as d, string_agg(distinct confupdtype::text, '') as u, string_agg(distinct confmatchtype::text, '') as m
         from pg_constraint where conname in ('viewings_org_property_fkey', 'viewings_org_contact_fkey')`,
    );
    expect(rules[0]).toEqual({ d: "a", u: "a", m: "s" });
    const { rows: uniq } = await o.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.contacts'::regclass and conname = 'contacts_org_id_id_key'",
    );
    expect(uniq).toEqual([{ def: "UNIQUE (org_id, id)" }]);
    const { rows: idx } = await o.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'public'
          and indexname in ('viewings_org_property_idx', 'viewings_org_contact_idx', 'viewings_property_idx', 'viewings_contact_idx') order by 1`,
    );
    expect(idx.map((i) => i.indexdef)).toEqual([
      "CREATE INDEX viewings_contact_idx ON public.viewings USING btree (contact_id)",
      "CREATE INDEX viewings_org_contact_idx ON public.viewings USING btree (org_id, contact_id)",
      "CREATE INDEX viewings_org_property_idx ON public.viewings USING btree (org_id, property_id)",
      "CREATE INDEX viewings_property_idx ON public.viewings USING btree (property_id)",
    ]);
    const { rows: earlier } = await o.query<{ c: number }>(
      `select count(*)::int as c from pg_constraint where convalidated and conname in
         ('tasks_org_deal_fkey', 'tasks_org_viewing_fkey', 'tasks_org_mandate_fkey', 'mandates_org_property_fkey',
          'property_keys_org_property_fkey', 'mandates_org_renewed_from_fkey', 'properties_org_id_id_key',
          'viewings_org_id_id_key', 'mandates_org_id_id_key', 'deals_org_id_id_key')`,
    );
    expect(earlier[0]!.c).toBe(10);
  });

  it("create_followup_nudges: both viewing arms join the viewing's own organisation's property; nothing else moved; definer, search_path, service_role only", async () => {
    const { rows } = await o.query<{ src: string; secdef: boolean; config: string[]; anon: boolean; auth: boolean; svc: boolean; n: number }>(
      `select replace(p.prosrc, E'\\r', '') as src, p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              (select count(*)::int from pg_proc x where x.proname = 'create_followup_nudges') as n
         from pg_proc p where p.oid = 'public.create_followup_nudges(uuid)'::regprocedure`,
    );
    const r = rows[0]!;
    expect(r).toMatchObject({ secdef: true, config: ["search_path=public"], anon: false, auth: false, svc: true, n: 1 });
    const code = r.src.replace(/--[^\n]*/g, "");
    expect(code).toMatch(/join properties p on p\.id = v\.property_id\s+and p\.org_id = v\.org_id\s+where v\.status = 'completed'/);
    expect(code).toMatch(/join properties p on p\.id = v\.property_id\s+and p\.org_id = v\.org_id\s+where v\.status = 'no_show'/);
    expect(code).not.toMatch(/current_org_id/);
    expect(r.src.split(ORG_LINE).length - 1, "the line is added exactly twice").toBe(2);
    const { rows: m } = await o.query<{ m: string }>("select md5($1) as m", [r.src.split(ORG_LINE).join("")]);
    expect(m[0]!.m, "without the two lines, the body is 0078's").toBe(MD5_0078);
  });
});

describe("the migration file: upgrade from 0122, refusal over existing mismatches, re-run, concurrent writers", () => {
  const file = () => readFileSync(MIGRATION, "utf8");

  it("applies over 0122's catalogue and this database's accumulated data: the keys validate, the probes run, the body is 0078's plus the two lines", async () => {
    const notices: string[] = [];
    const listen = (msg: { message?: string }) => notices.push(msg.message ?? "");
    o.on("notice", listen);
    try {
      await rolledBack(async () => {
        await revertTo0122();
        expect(await viewingKeys()).toEqual(KEYS_0122);
        expect(await sweepMd5(), "the revert restored 0078's body exactly").toBe(MD5_0078);
        await o.query(file());
        expect(await viewingKeys()).toEqual(KEYS_0123);
        const { rows } = await o.query<{ src: string }>(
          "select replace(prosrc, E'\\r', '') as src from pg_proc where oid = 'public.create_followup_nudges(uuid)'::regprocedure",
        );
        const { rows: m } = await o.query<{ m: string }>("select md5($1) as m", [rows[0]!.src.split(ORG_LINE).join("")]);
        expect(m[0]!.m).toBe(MD5_0078);
      });
    } finally {
      o.off("notice", listen);
    }
    expect(notices.some((x) => x.startsWith("0123: preflight passed"))).toBe(true);
    expect(notices.some((x) => x.startsWith("0123: probes refused by their keys: {property,contact}"))).toBe(true);
  });

  // What proves this test is the message: the PREFLIGHT refused (with both
  // counts), so it ran before the key additions, which would otherwise have
  // failed 23503 on these rows. That it precedes ALL DDL is the file's text
  // order, not something this test observes. The checks after the savepoint
  // rollback restate that nothing was deleted, reassigned or repaired; a
  // failed statement cannot leave partial DDL behind in any case.
  it("refuses over existing mismatches in its preflight — with both counts and the way to list them — deleting, reassigning and repairing nothing", async () => {
    await rolledBack(async () => {
      await revertTo0122();
      // accepted by 0122's single-column keys: no plant needed
      const vp = await newViewing(ORG_B, propA.id, contactB.id);
      const vc = await newViewing(ORG_B, propB.id, contactA.id);
      const vc2 = await newViewing(ORG_B, propB.id, contactA.id);
      await o.query("savepoint before_0123");
      await expect(o.query(file())).rejects.toThrow(
        /^0123 aborted: 1 viewing\(s\) name a property of another organisation, 2 viewing\(s\) name a contact of another organisation — nothing was changed/,
      );
      await o.query("rollback to savepoint before_0123");
      expect(await viewingKeys()).toEqual(KEYS_0122);
      expect(await count("select count(*)::int as c from pg_constraint where conname = 'contacts_org_id_id_key'")).toBe(0);
      expect(await sweepMd5()).toBe(MD5_0078);
      expect(await viewingRow(vp)).toEqual({ org_id: ORG_B, property_id: propA.id, contact_id: contactB.id });
      expect(await viewingRow(vc)).toEqual({ org_id: ORG_B, property_id: propB.id, contact_id: contactA.id });
      expect(await viewingRow(vc2)).toEqual({ org_id: ORG_B, property_id: propB.id, contact_id: contactA.id });
    });
  });

  it("refuses, before any DDL, when the live sweep is not 0078's body — an unrecorded change is not silently overwritten", async () => {
    await rolledBack(async () => {
      await revertTo0122();
      // a hotfix typed into an SQL editor: one title reworded
      await o.query(`
        do $$
        declare b text;
        begin
          select prosrc into b from pg_proc where oid = 'public.create_followup_nudges(uuid)'::regprocedure;
          execute format('create or replace function public.create_followup_nudges(p_org uuid default null) returns void '
                         'language sql security definer set search_path = public as %L',
                         replace(b, 'Log viewing feedback: ', 'Log feedback: '));
        end $$;
      `);
      const tampered = await sweepMd5();
      expect(tampered).not.toBe(MD5_0078);
      await o.query("savepoint before_0123");
      await expect(o.query(file())).rejects.toThrow(
        new RegExp(`^0123 aborted: create_followup_nudges is not 0078's body on this database \\(md5 ${tampered}\\) — nothing was changed`),
      );
      // the message is the proof (the preflight precedes every DDL); this restates the state
      await o.query("rollback to savepoint before_0123");
      expect(await viewingKeys()).toEqual(KEYS_0122);
    });
  });

  it("run a second time, it stops in its preflight (the sweep is no longer 0078's)", async () => {
    await rolledBack(async () => {
      await expect(o.query(file())).rejects.toThrow(/^0123 aborted: create_followup_nudges is not 0078's body on this database/);
    });
  });

  it("an in-flight write to viewings holds the file at its LOCK — before the preflight passes — until lock_timeout (55P03)", async () => {
    const writer = new Client({ connectionString: DB_URL });
    await writer.connect();
    const notices: string[] = [];
    const listen = (msg: { message?: string }) => notices.push(msg.message ?? "");
    try {
      await writer.query("begin");
      await writer.query(
        `insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at) values ($1, $2, $3, $4, now() + interval '1 day')`,
        [ORG_B, propB.id, contactB.id, agentB.id],
      );
      o.on("notice", listen);
      const started = Date.now();
      await rolledBack(async () => {
        await expect(o.query(file())).rejects.toMatchObject({ code: "55P03" });
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(notices.filter((x) => x.startsWith("0123:")), "the preflight never ran beside the writer").toEqual([]);
    } finally {
      o.off("notice", listen);
      await writer.query("rollback");
      await writer.end();
    }
  });
});
