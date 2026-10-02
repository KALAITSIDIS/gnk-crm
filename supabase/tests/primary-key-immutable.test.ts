import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_PASSWORD, anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { GUARD_0118 } from "./revert-0131";
import { GUARDED, LOCK_ORDER_0132, REVERT_0132_SQL, UNGUARDED_SQL, readMigration0132 } from "./revert-0132";

/**
 * A session cannot change a record's primary key (T-primary-key-immutable,
 * migration 0132).
 *
 * THE GAP (reproduced at 58fb84d / 0131 by this file): contacts_update /
 * leads_update restrict rows, not columns, and `authenticated` holds UPDATE
 * on `id`. An aal2 admin, a contact's assigned agent, the agent who created
 * it, and any agent of the organisation on an unassigned lead PATCHed
 * `{id: <new uuid>}` and the row moved to the new id. Its events, notes and
 * documents are keyed by entity_id with no foreign key, so they stayed on the
 * old id — and a second record re-keyed ONTO a former id adopted them. 24 of
 * the 26 tables whose key an API role may update accepted the same from the
 * roles their policies admit (deals refuse since 0131; organizations by
 * policy), through a PATCH or through an upsert on a non-key unique key.
 *
 * THE DESIGN PINNED HERE: trg_primary_key_immutable(), an invoker trigger
 * BEFORE UPDATE OF <the key> on each of the 25 tables other than deals,
 * refuses a session's (authenticated / anon) change of a key VALUE with 42501
 * "A record's primary key cannot be changed (<table>.<column>)". A write that
 * restates the key passes; the service role and postgres are not bound
 * (parity with 0118 / 0127 / 0131). The catalogue test holds every future
 * table to the rule.
 *
 * TWO KINDS OF CALLER, both real:
 *  - supabase-js clients through PostgREST — how the app and any crafted
 *    request reach the database — for the audit's matrix, the other ways of
 *    asking, and the composite / text keys;
 *  - `pg` sessions impersonating a user (`set local role authenticated` +
 *    request.jwt.claims, PostgREST's own transaction setup) inside rolled-back
 *    transactions, for every guarded table and every role (and ownership
 *    arm) its UPDATE policy admits.
 *
 * Fixtures: two throwaway organisations (deleted at the end as postgres), and
 * per-table organisations that exist only inside rolled-back transactions.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);
const CONFIG_KEY = `zz_pk_${RUN}`;

let o: Client; // postgres: fixtures, verification, rolled-back probes, cleanup
let svc: SupabaseClient;
let admin: TestUser;
let agent: TestUser; // owns the contacts / leads under test
let peer: TestUser; // same organisation, owns nothing
let lm: TestUser;
let otherAdmin: TestUser; // another organisation
let aal1: SupabaseClient; // the admin, signed in again without the second factor
const userIds: string[] = [];
let n = 0;

const refusal = (table: string, col = "id") => `A record's primary key cannot be changed (${table}.${col})`;

type PgrstResult = { error: { code?: string; message?: string } | null; status: number; data?: unknown };
function expectRefused(r: PgrstResult, table: string, col = "id") {
  expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
  expect(r.error?.message).toBe(refusal(table, col));
  expect(r.status).toBe(403);
}

// ---------------------------------------------------------------------------
// persistent fixtures (written as postgres: fixtures, not the writes under test)
// ---------------------------------------------------------------------------
async function contact(opts: { assigned?: string | null; createdBy?: string | null } = {}) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into contacts (org_id, first_name, last_name, assigned_agent_id, created_by)
     values ($1, $2, 'ZZTEST pk', $3, $4) returning id`,
    [ORG, `pk ${RUN} ${n}`, opts.assigned ?? null, opts.createdBy ?? null],
  );
  return rows[0]!.id;
}
async function lead(opts: { assigned?: string | null } = {}) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into leads (org_id, source, assigned_agent_id, message) values ($1, 'other', $2, $3) returning id`,
    [ORG, opts.assigned ?? null, `ZZTEST pk lead ${RUN} ${n}`],
  );
  return rows[0]!.id;
}
async function property() {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id`,
    [ORG, `ZZPK-${RUN}-${n}`],
  );
  return rows[0]!.id;
}
async function present(table: string, id: string) {
  const { rowCount } = await o.query(`select 1 from ${table} where id = $1`, [id]);
  return rowCount === 1;
}
async function rekey(client: SupabaseClient, table: string, id: string, extra: Record<string, unknown> = {}) {
  const to = randomUUID();
  const r = await client.from(table).update({ id: to, ...extra }).eq("id", id).select("id");
  return { r, to };
}
/** The row is still at its id, and nothing exists at the id it was asked to take. */
async function expectUnmoved(table: string, id: string, to: string) {
  expect(await present(table, id), `${table} ${id} still there`).toBe(true);
  expect(await present(table, to), `nothing at ${to}`).toBe(false);
}

// ---------------------------------------------------------------------------
// rolled-back probes as a session
// ---------------------------------------------------------------------------
/** Run `body` in a transaction on `o` that is always rolled back; collect NOTICEs. */
async function rolledBack(body: (notices: string[]) => Promise<void>) {
  const notices: string[] = [];
  const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
  o.on("notice", onNotice);
  await o.query("begin");
  // on a shared stack, wait at most 5 s for a lock, then fail cleanly
  await o.query("set local lock_timeout = '5s'");
  try {
    await body(notices);
  } finally {
    await o.query("rollback");
    o.off("notice", onNotice);
  }
}
async function asSession(uid: string, aal: "aal1" | "aal2" = "aal2") {
  await o.query("set local role authenticated");
  await o.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal })]);
}

type Fx = Record<
  "org" | "admin" | "agent" | "lm" | "spare" | "victim" | "dist" | "stage" | "prop" | "unit" | "unit2" | "cont" | "deal" | "pl" | "pl2" | "res" | "T" | "NEW",
  string
> & { tag: string };
function fx(): Fx {
  const id = () => randomUUID();
  return {
    org: id(), admin: id(), agent: id(), lm: id(), spare: id(), victim: id(), dist: id(), stage: id(), prop: id(), unit: id(),
    unit2: id(), cont: id(), deal: id(), pl: id(), pl2: id(), res: id(), T: id(), NEW: id(), tag: randomUUID().slice(0, 8),
  };
}
/** An organisation, its admin / agent / listing manager, an auth user with no profile, and the parents the targets need. */
function fixtureSql(f: Fx) {
  const user = (uid: string, who: string) =>
    `('00000000-0000-0000-0000-000000000000', '${uid}', 'authenticated', 'authenticated', 'zz-pk-${who}-${f.tag}@test.local')`;
  return `
insert into public.organizations (id, name, slug) values ('${f.org}', 'zz pk ${f.tag}', 'zz-pk-${f.tag}');
insert into auth.users (instance_id, id, aud, role, email) values
  ${user(f.admin, "admin")}, ${user(f.agent, "agent")}, ${user(f.lm, "lm")}, ${user(f.spare, "spare")}, ${user(f.victim, "victim")};
insert into public.profiles (id, org_id, role, full_name, email) values
  ('${f.admin}', '${f.org}', 'admin', 'ZZTEST pk admin', 'zz-pk-admin-${f.tag}@test.local'),
  ('${f.agent}', '${f.org}', 'agent', 'ZZTEST pk agent', 'zz-pk-agent-${f.tag}@test.local'),
  ('${f.lm}', '${f.org}', 'listing_manager', 'ZZTEST pk lm', 'zz-pk-lm-${f.tag}@test.local'),
  ('${f.victim}', '${f.org}', 'agent', 'ZZTEST pk victim', 'zz-pk-victim-${f.tag}@test.local');
insert into public.districts (id, org_id, code, name) values ('${f.dist}', '${f.org}', 'ZZP', '{"en":"Z"}');
insert into public.deal_stages (id, org_id, deal_type, name, sort_order) values ('${f.stage}', '${f.org}', 'sale', 'Z', 1);
insert into public.properties (id, org_id, reference, property_type) values
  ('${f.prop}', '${f.org}', 'ZZP-${f.tag}-1', 'apartment'),
  ('${f.unit}', '${f.org}', 'ZZP-${f.tag}-2', 'apartment'),
  ('${f.unit2}', '${f.org}', 'ZZP-${f.tag}-3', 'apartment');
insert into public.contacts (id, org_id, first_name) values ('${f.cont}', '${f.org}', 'Z');
insert into public.deals (id, org_id, stage_id, title, agent_id) values ('${f.deal}', '${f.org}', '${f.stage}', 'Z', '${f.agent}');
insert into public.price_lists (id, org_id, project_id, version) values
  ('${f.pl}', '${f.org}', '${f.prop}', 1), ('${f.pl2}', '${f.org}', '${f.prop}', 2);
insert into public.reservations (id, org_id, property_id, expires_at) values ('${f.res}', '${f.org}', '${f.prop}', now() + interval '7 days');
`;
}

type Role = "admin" | "agent" | "lm";
type Case = { table: string; col: string; roles: Role[]; target: (f: Fx, role: Role) => string; update: (f: Fx, role: Role) => string };
/** The row's owner for an ownership arm: the caller, or (for the admin, who needs none) the agent. */
const owner = (f: Fx, role: Role) => (role === "admin" ? f.agent : f[role]);
const byId = (table: string) => (f: Fx) => `update public.${table} set id = '${f.NEW}' where id = '${f.T}'`;
/**
 * Every guarded table, a childless target row, and each role its UPDATE policy
 * admits on it — every arm: tasks to any assignee, share_links to any
 * creator, profiles to their own row (protect_profile_columns refuses a
 * non-admin's id change too, but 0132's guard sorts first and answers).
 */
const CASES: Case[] = [
  { table: "areas", col: "id", roles: ["admin"], update: byId("areas"),
    target: (f) => `insert into public.areas (id, org_id, district_id, name) values ('${f.T}', '${f.org}', '${f.dist}', '{"en":"T"}')` },
  { table: "buyer_requirements", col: "id", roles: ["admin", "agent", "lm"], update: byId("buyer_requirements"),
    target: (f) => `insert into public.buyer_requirements (id, org_id, contact_id, created_by) values ('${f.T}', '${f.org}', '${f.cont}', '${f.agent}')` },
  { table: "contacts", col: "id", roles: ["admin", "agent"], update: byId("contacts"),
    target: (f) => `insert into public.contacts (id, org_id, first_name, assigned_agent_id) values ('${f.T}', '${f.org}', 'T', '${f.agent}')` },
  { table: "cyprus_config", col: "key", roles: ["admin"],
    target: (f) => `insert into public.cyprus_config (key, value) values ('zz_pk_${f.tag}', '{}'::jsonb)`,
    update: (f) => `update public.cyprus_config set key = 'zz_pk_${f.tag}_2' where key = 'zz_pk_${f.tag}'` },
  { table: "deal_stages", col: "id", roles: ["admin"], update: byId("deal_stages"),
    target: (f) => `insert into public.deal_stages (id, org_id, deal_type, name, sort_order) values ('${f.T}', '${f.org}', 'sale', 'T', 99)` },
  { table: "districts", col: "id", roles: ["admin"], update: byId("districts"),
    target: (f) => `insert into public.districts (id, org_id, code, name) values ('${f.T}', '${f.org}', 'ZZT', '{"en":"T"}')` },
  { table: "documents", col: "id", roles: ["admin"], update: byId("documents"),
    target: (f) =>
      `insert into public.documents (id, org_id, entity_type, entity_id, title, storage_path)
       values ('${f.T}', '${f.org}', 'contact', '${f.cont}', 'T', '${f.org}/contact/${f.cont}/t.pdf')` },
  { table: "leads", col: "id", roles: ["admin", "agent"], update: byId("leads"),
    target: (f) => `insert into public.leads (id, org_id, assigned_agent_id) values ('${f.T}', '${f.org}', '${f.agent}')` },
  { table: "mandates", col: "id", roles: ["admin"], update: byId("mandates"),
    target: (f) => `insert into public.mandates (id, org_id, property_id, type) values ('${f.T}', '${f.org}', '${f.prop}', 'exclusive')` },
  { table: "offers", col: "id", roles: ["admin", "agent"], update: byId("offers"),
    target: (f) => `insert into public.offers (id, org_id, deal_id, amount) values ('${f.T}', '${f.org}', '${f.deal}', 1000)` },
  { table: "organizations", col: "id", roles: ["admin"], target: () => "",
    update: (f) => `update public.organizations set id = '${f.NEW}' where id = '${f.org}'` },
  { table: "payment_plans", col: "id", roles: ["admin", "lm"], update: byId("payment_plans"),
    target: (f) => `insert into public.payment_plans (id, org_id, project_id, name) values ('${f.T}', '${f.org}', '${f.prop}', 'T')` },
  { table: "portal_connections", col: "id", roles: ["admin"], update: byId("portal_connections"),
    target: (f) => `insert into public.portal_connections (id, org_id, portal) values ('${f.T}', '${f.org}', 'zz_pk')` },
  { table: "price_list_items", col: "unit_id", roles: ["admin", "lm"],
    target: (f) => `insert into public.price_list_items (price_list_id, unit_id, list_price) values ('${f.pl}', '${f.unit}', 100)`,
    update: (f) => `update public.price_list_items set unit_id = '${f.unit2}' where price_list_id = '${f.pl}' and unit_id = '${f.unit}'` },
  { table: "price_list_items", col: "price_list_id", roles: ["admin", "lm"],
    target: (f) => `insert into public.price_list_items (price_list_id, unit_id, list_price) values ('${f.pl}', '${f.unit}', 100)`,
    update: (f) => `update public.price_list_items set price_list_id = '${f.pl2}' where price_list_id = '${f.pl}' and unit_id = '${f.unit}'` },
  { table: "price_lists", col: "id", roles: ["admin", "lm"], update: byId("price_lists"),
    target: (f) => `insert into public.price_lists (id, org_id, project_id, version) values ('${f.T}', '${f.org}', '${f.prop}', 7)` },
  { table: "profiles", col: "id", roles: ["admin"], target: () => "",
    update: (f) => `update public.profiles set id = '${f.spare}' where id = '${f.victim}'` },
  { table: "profiles", col: "id", roles: ["agent", "lm"], target: () => "",
    update: (f, role) => `update public.profiles set id = '${f.spare}' where id = '${f[role]}'` },
  { table: "properties", col: "id", roles: ["admin", "agent", "lm"], update: byId("properties"),
    target: (f) =>
      `insert into public.properties (id, org_id, reference, property_type, assigned_agent_id)
       values ('${f.T}', '${f.org}', 'ZZP-${f.tag}-T', 'apartment', '${f.agent}')` },
  { table: "property_keys", col: "id", roles: ["admin", "lm"], update: byId("property_keys"),
    target: (f) => `insert into public.property_keys (id, org_id, property_id, key_code) values ('${f.T}', '${f.org}', '${f.prop}', 'K-${f.tag}')` },
  { table: "property_media", col: "id", roles: ["admin", "lm"], update: byId("property_media"),
    target: (f) => `insert into public.property_media (id, org_id, property_id) values ('${f.T}', '${f.org}', '${f.prop}')` },
  { table: "reservation_installments", col: "id", roles: ["admin", "agent", "lm"], update: byId("reservation_installments"),
    target: (f) =>
      `insert into public.reservation_installments (id, org_id, reservation_id, sort_order, label, amount)
       values ('${f.T}', '${f.org}', '${f.res}', 1, 'T', 100)` },
  { table: "reservations", col: "id", roles: ["admin", "agent", "lm"], update: byId("reservations"),
    target: (f) =>
      `insert into public.reservations (id, org_id, property_id, expires_at) values ('${f.T}', '${f.org}', '${f.unit2}', now() + interval '7 days')` },
  { table: "share_links", col: "id", roles: ["admin", "agent", "lm"], update: byId("share_links"),
    target: (f, role) =>
      `insert into public.share_links (id, org_id, token_sha256, expires_at, created_by)
       values ('${f.T}', '${f.org}', md5('${f.T}') || md5('${f.tag}'), now() + interval '7 days', '${owner(f, role)}')` },
  { table: "tasks", col: "id", roles: ["admin", "agent", "lm"], update: byId("tasks"),
    target: (f, role) => `insert into public.tasks (id, org_id, title, assignee_id) values ('${f.T}', '${f.org}', 'T', '${owner(f, role)}')` },
  { table: "unit_types", col: "id", roles: ["admin", "lm"], update: byId("unit_types"),
    target: (f) => `insert into public.unit_types (id, org_id, project_id, code) values ('${f.T}', '${f.org}', '${f.prop}', 'T1')` },
  { table: "viewings", col: "id", roles: ["admin", "agent"], update: byId("viewings"),
    target: (f) =>
      `insert into public.viewings (id, org_id, property_id, contact_id, agent_id, scheduled_at)
       values ('${f.T}', '${f.org}', '${f.prop}', '${f.cont}', '${f.agent}', now() + interval '1 day')` },
];

// ---------------------------------------------------------------------------
beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `pk immutable ${RUN}`, `pk-immutable-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `pk immutable other ${RUN}`, `pk-immutable-other-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors. An id is
  // recorded even when createTestUser fails AFTER creating the auth user (the
  // profile, sign-in or enrolment step — or a gateway error on a create that
  // succeeded): it is looked up by e-mail, so afterAll still deletes it
  const user = async (who: string, role: "admin" | "agent" | "listing_manager", org: string) => {
    const email = `pk-${who}-${RUN}@test.local`;
    try {
      const u = await createTestUser(svc, email, role, org);
      userIds.push(u.id);
      return u;
    } catch (e) {
      const { rows } = await o.query<{ id: string }>("select id from auth.users where email = $1", [email]);
      for (const r of rows) if (!userIds.includes(r.id)) userIds.push(r.id);
      throw e;
    }
  };
  admin = await user("admin", "admin", ORG);
  agent = await user("agent", "agent", ORG);
  peer = await user("peer", "agent", ORG);
  lm = await user("lm", "listing_manager", ORG);
  otherAdmin = await user("other-admin", "admin", OTHER_ORG);
  aal1 = anonClient();
  const signIn = await aal1.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD });
  if (signIn.error) throw new Error(`aal1 sign-in: ${signIn.error.message}`);
  await o.query("insert into cyprus_config (key, value) values ($1, '{\"v\": 1}'::jsonb)", [CONFIG_KEY]);
});

afterAll(async () => {
  await o.query("delete from cyprus_config where key like $1", [`${CONFIG_KEY}%`]);
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from tasks where org_id = $1", [org]);
    await o.query("delete from price_list_items where price_list_id in (select id from price_lists where org_id = $1)", [org]);
    await o.query("delete from price_lists where org_id = $1", [org]);
    await o.query("delete from unit_types where org_id = $1", [org]);
    await o.query("delete from property_keys where org_id = $1", [org]);
    await o.query("delete from leads where org_id = $1", [org]);
    await o.query("delete from contacts where org_id = $1", [org]);
    await o.query("delete from properties where org_id = $1", [org]);
  }
  for (const id of userIds) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) console.warn(`afterAll: auth user ${id} not deleted: ${error.message}`);
  }
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from profiles where org_id = $1", [org]);
    await o.query("delete from events where org_id = $1", [org]);
    await o.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await o.query("delete from chain_checks where org_id = $1", [org]);
    await o.query("delete from areas where org_id = $1", [org]);
    await o.query("delete from deal_stages where org_id = $1", [org]);
    await o.query("delete from districts where org_id = $1", [org]);
    await o.query("delete from organizations where id = $1", [org]);
  }
  await o.end();
});

// ---------------------------------------------------------------------------
describe("1. the audit's matrix: no session re-keys a contact or a lead", () => {
  it("contacts: the admin, the assigned agent and the agent who created it are refused — the row keeps its id", async () => {
    for (const [, client, row] of [
      ["admin", () => admin.client, () => contact({ assigned: agent.id })],
      ["assigned agent", () => agent.client, () => contact({ assigned: agent.id })],
      ["creating agent", () => agent.client, () => contact({ createdBy: agent.id })],
    ] as const) {
      const id = await row();
      const { r, to } = await rekey(client(), "contacts", id);
      expectRefused(r, "contacts");
      await expectUnmoved("contacts", id, to);
    }
  });

  it("leads: the admin, the assigned agent, and any agent on an UNASSIGNED lead are refused", async () => {
    for (const [, client, row] of [
      ["admin", () => admin.client, () => lead({ assigned: agent.id })],
      ["assigned agent", () => agent.client, () => lead({ assigned: agent.id })],
      ["agent, unassigned lead", () => agent.client, () => lead()],
      ["peer agent, unassigned lead", () => peer.client, () => lead()],
    ] as const) {
      const id = await row();
      const { r, to } = await rekey(client(), "leads", id);
      expectRefused(r, "leads");
      await expectUnmoved("leads", id, to);
    }
  });

  it("the callers refused already stay refused — a peer, a listing manager, another organisation's admin, aal1, anon — and nothing moves", async () => {
    const c = await contact({ assigned: agent.id, createdBy: agent.id });
    const l = await lead({ assigned: agent.id });
    for (const client of [peer.client, lm.client, otherAdmin.client, aal1, anonClient()]) {
      for (const [table, id] of [
        ["contacts", c],
        ["leads", l],
      ] as const) {
        const { r, to } = await rekey(client, table, id);
        // a filtered row (200, no data) or no privilege (401) — either way, no row
        expect(r.data ?? [], JSON.stringify(r)).toEqual([]);
        await expectUnmoved(table, id, to);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("2. every way of asking is refused; restating the key is not changing it", () => {
  it("a PATCH that changes the id together with an ordinary field is refused whole — the field is unchanged too", async () => {
    const c = await contact({ assigned: agent.id });
    const { r, to } = await rekey(agent.client, "contacts", c, { notes: "ZZTEST changed" });
    expectRefused(r, "contacts");
    await expectUnmoved("contacts", c, to);
    expect((await o.query("select notes from contacts where id = $1", [c])).rows[0].notes).toBeNull();

    const l = await lead({ assigned: agent.id });
    const lr = await rekey(agent.client, "leads", l, { message: "ZZTEST changed", status: "contacted" });
    expectRefused(lr.r, "leads");
    await expectUnmoved("leads", l, lr.to);
    expect((await o.query("select status::text as s from leads where id = $1", [l])).rows[0].s).not.toBe("contacted");
  });

  it("return=minimal (no body requested) is refused the same way, not a silent 204", async () => {
    const c = await contact({ assigned: agent.id });
    const to = randomUUID();
    const r = await agent.client.from("contacts").update({ id: to }).eq("id", c);
    expectRefused(r, "contacts");
    await expectUnmoved("contacts", c, to);
  });

  it("an UPSERT on a non-key unique key that carries a different id is refused (ON CONFLICT … SET id = EXCLUDED.id)", async () => {
    const { rows } = await o.query<{ id: string }>("select id from districts where org_id = $1 and code = 'PAF'", [ORG]);
    const district = rows[0]!.id;
    const to = randomUUID();
    const r = await admin.client
      .from("districts")
      .upsert({ id: to, org_id: ORG, code: "PAF", name: { en: "Paphos", el: "Πάφος", ru: "Пафос" } }, { onConflict: "org_id,code" })
      .select("id");
    expectRefused(r, "districts");
    await expectUnmoved("districts", district, to);

    const p = await property();
    const key = (await o.query<{ id: string }>(
      "insert into property_keys (org_id, property_id, key_code) values ($1, $2, $3) returning id",
      [ORG, p, `K-${RUN}`],
    )).rows[0]!.id;
    const kto = randomUUID();
    const kr = await lm.client
      .from("property_keys")
      .upsert({ id: kto, org_id: ORG, property_id: p, key_code: `K-${RUN}` }, { onConflict: "org_id,key_code" })
      .select("id");
    expectRefused(kr, "property_keys");
    await expectUnmoved("property_keys", key, kto);
  });

  it("a row a foreign-key child pins gets the guard's answer, not a 23503 naming a table the caller cannot read", async () => {
    const c = await contact({ assigned: agent.id });
    // a task the agent can neither read nor knows of: the admin's own
    await o.query("insert into tasks (org_id, title, contact_id, assignee_id, created_by) values ($1, 'ZZTEST pinned', $2, $3, $3)", [
      ORG,
      c,
      admin.id,
    ]);
    const { r, to } = await rekey(agent.client, "contacts", c);
    expectRefused(r, "contacts");
    expect(JSON.stringify(r.error)).not.toMatch(/tasks/);
    await expectUnmoved("contacts", c, to);
  });

  // (an INSERT that chooses such an id still adopts it — BACKLOG, the
  // client-chosen primary key entry; 0132 ends only the re-key route)
  it("a re-key ONTO an id whose events outlived their row is refused — that history stays nobody's", async () => {
    // an orphaned history, as production holds after a deletion
    const orphan = randomUUID();
    await o.query(
      `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
       values ($1, $2, 'contact', $3, 'created', '{}'::jsonb)`,
      [ORG, admin.id, orphan],
    );
    const c = await contact({ assigned: agent.id });
    const r = await agent.client.from("contacts").update({ id: orphan }).eq("id", c).select("id");
    expectRefused(r, "contacts");
    await expectUnmoved("contacts", c, orphan);
    // the orphaned history is still nobody's
    const { rows } = await o.query("select event_type from events where entity_type = 'contact' and entity_id = $1", [orphan]);
    expect(rows.map((e) => e.event_type)).toEqual(["created"]);
    expect((await o.query("select public.verify_events_chain($1) as ok", [ORG])).rows[0].ok).toBe(true);
  });

  it("restating is not changing: a PATCH carrying the row's own id and an upsert on the key itself are accepted", async () => {
    const c = await contact({ assigned: agent.id });
    const p = await admin.client.from("contacts").update({ id: c, first_name: "ZZTEST restated" }).eq("id", c).select("id, first_name");
    expect(p.error, JSON.stringify(p.error)).toBeNull();
    expect(p.data).toEqual([{ id: c, first_name: "ZZTEST restated" }]);

    const u = await agent.client
      .from("contacts")
      .upsert({ id: c, org_id: ORG, first_name: "ZZTEST upserted" }, { onConflict: "id" })
      .select("id, first_name");
    expect(u.error, JSON.stringify(u.error)).toBeNull();
    expect(u.data).toEqual([{ id: c, first_name: "ZZTEST upserted" }]);

    const l = await lead({ assigned: agent.id });
    const lu = await agent.client
      .from("leads")
      .upsert({ id: l, org_id: ORG, source: "other", message: "ZZTEST upserted" }, { onConflict: "id" })
      .select("id");
    expect(lu.error, JSON.stringify(lu.error)).toBeNull();
    expect(lu.data).toEqual([{ id: l }]);
  });
});

// ---------------------------------------------------------------------------
describe("3. composite and text keys, and a listing manager's tables, through PostgREST", () => {
  it("price_list_items: a listing manager may reprice a line but not move it to another unit or another list", async () => {
    const project = await property();
    const [u1, u2] = [await property(), await property()];
    const pl = (await o.query<{ id: string }>(
      "insert into price_lists (org_id, project_id, version) values ($1, $2, 1) returning id",
      [ORG, project],
    )).rows[0]!.id;
    const pl2 = (await o.query<{ id: string }>(
      "insert into price_lists (org_id, project_id, version) values ($1, $2, 2) returning id",
      [ORG, project],
    )).rows[0]!.id;
    await o.query("insert into price_list_items (price_list_id, unit_id, list_price) values ($1, $2, 100)", [pl, u1]);
    const line = () => lm.client.from("price_list_items").select("price_list_id, unit_id, list_price").eq("price_list_id", pl);

    const toUnit = await lm.client.from("price_list_items").update({ unit_id: u2 }).eq("price_list_id", pl).eq("unit_id", u1).select();
    expectRefused(toUnit, "price_list_items", "unit_id");
    const toList = await lm.client.from("price_list_items").update({ price_list_id: pl2 }).eq("price_list_id", pl).eq("unit_id", u1).select();
    expectRefused(toList, "price_list_items", "price_list_id");

    const reprice = await lm.client.from("price_list_items").update({ list_price: 120 }).eq("price_list_id", pl).eq("unit_id", u1).select();
    expect(reprice.error, JSON.stringify(reprice.error)).toBeNull();
    expect((await line()).data).toEqual([{ price_list_id: pl, unit_id: u1, list_price: 120 }]);
  });

  it("cyprus_config: an admin may change a value but not rename the key every reader looks it up by", async () => {
    const rename = await admin.client.from("cyprus_config").update({ key: `${CONFIG_KEY}_renamed` }).eq("key", CONFIG_KEY).select("key");
    expectRefused(rename, "cyprus_config", "key");
    const value = await admin.client.from("cyprus_config").update({ value: { v: 2 } }).eq("key", CONFIG_KEY).select("key, value");
    expect(value.error, JSON.stringify(value.error)).toBeNull();
    expect(value.data).toEqual([{ key: CONFIG_KEY, value: { v: 2 } }]);
    expect((await o.query("select count(*)::int as n from cyprus_config where key = $1", [`${CONFIG_KEY}_renamed`])).rows[0].n).toBe(0);
  });

  it("a listing manager's own tables: a key and a unit type keep their ids; an ordinary edit still saves", async () => {
    const p = await property();
    const key = (await o.query<{ id: string }>(
      "insert into property_keys (org_id, property_id, key_code) values ($1, $2, $3) returning id",
      [ORG, p, `KL-${RUN}`],
    )).rows[0]!.id;
    const { r, to } = await rekey(lm.client, "property_keys", key);
    expectRefused(r, "property_keys");
    await expectUnmoved("property_keys", key, to);
    const edit = await lm.client.from("property_keys").update({ key_code: `KL2-${RUN}` }).eq("id", key).select("id");
    expect(edit.error, JSON.stringify(edit.error)).toBeNull();
    expect(edit.data).toEqual([{ id: key }]);

    const ut = (await o.query<{ id: string }>(
      "insert into unit_types (org_id, project_id, code) values ($1, $2, 'ZZ1') returning id",
      [ORG, p],
    )).rows[0]!.id;
    const u = await rekey(lm.client, "unit_types", ut);
    expectRefused(u.r, "unit_types");
    await expectUnmoved("unit_types", ut, u.to);
  });
});

// ---------------------------------------------------------------------------
describe("4. every guarded table refuses every role its policy admits (rolled back)", () => {
  for (const c of CASES) {
    for (const role of c.roles) {
      it(`${c.table}.${c.col} — ${role}`, async () => {
        const f = fx();
        await rolledBack(async () => {
          await o.query(fixtureSql(f));
          const t = c.target(f, role);
          if (t) await o.query(t);
          await asSession(f[role]);
          await expect(o.query(c.update(f, role))).rejects.toMatchObject({ code: "42501", message: refusal(c.table, c.col) });
        });
      });
    }
  }

  it("the cases cover every guarded table and every key column", () => {
    const covered = new Set(CASES.map((c) => `${c.table}.${c.col}`));
    for (const [table, key] of GUARDED) for (const col of key) expect(covered.has(`${table}.${col}`), `${table}.${col}`).toBe(true);
  });

  it("the probe is not vacuous: as the same session, an ordinary edit of the same row is accepted", async () => {
    const f = fx();
    await rolledBack(async () => {
      await o.query(fixtureSql(f));
      await o.query(`insert into public.contacts (id, org_id, first_name, assigned_agent_id) values ('${f.T}', '${f.org}', 'T', '${f.agent}')`);
      await asSession(f.agent);
      const r = await o.query(`update public.contacts set first_name = 'T2' where id = '${f.T}'`);
      expect(r.rowCount).toBe(1);
    });
  });

  it("trusted paths, deliberately (parity with 0118 / 0127 / 0131): postgres and the service role are not bound", async () => {
    for (const role of ["postgres", "service_role"]) {
      const f = fx();
      await rolledBack(async () => {
        await o.query(fixtureSql(f));
        await o.query(`insert into public.contacts (id, org_id, first_name) values ('${f.T}', '${f.org}', 'T')`);
        if (role !== "postgres") await o.query(`set local role ${role}`);
        const r = await o.query(`update public.contacts set id = '${f.NEW}' where id = '${f.T}'`);
        expect(r.rowCount, role).toBe(1);
      });
    }
  });
});

// ---------------------------------------------------------------------------
describe("5. the catalogue: every key an API role may update is guarded — now and for any future table", () => {
  const unguarded = async () => (await o.query<{ table: string; key: string }>(UNGUARDED_SQL)).rows;

  it("the only table whose key an API role may update without this guard is deals — and deals' own guard refuses", async () => {
    expect(await unguarded()).toEqual([{ table: "deals", key: "id" }]);
    const { rows } = await o.query<{ src: string }>(
      `select regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') as src from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'public.deals'::regclass and t.tgname = 'deals_closed_guard' and t.tgenabled = 'O'`,
    );
    expect(rows[0]?.src).toMatch(/new\.id is distinct from old\.id/);
  });

  it("the guard: 25 triggers named for their tables; an invoker owned by postgres, pg_temp last, callable by no role", async () => {
    const { rows } = await o.query<{ t: string }>(
      `select t.tgrelid::regclass::text as t from pg_trigger t
        where t.tgfoid = to_regprocedure('public.trg_primary_key_immutable()') and not t.tgisinternal
          and t.tgname = (t.tgrelid::regclass::text || '_pk_immutable') order by 1`,
    );
    expect(rows.map((r) => r.t)).toEqual(GUARDED.map(([table]) => table));
    const fn = (
      await o.query(
        `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
                has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('service_role', p.oid, 'execute') as svc
           from pg_proc p where p.oid = to_regprocedure('public.trg_primary_key_immutable()')`,
      )
    ).rows[0];
    expect(fn).toEqual({ prosecdef: false, owner: "postgres", proconfig: ["search_path=public, pg_temp"], pub: false, anon: false, auth: false, svc: false });
  });

  const drifts: Array<[string, string, { table: string; key: string }]> = [
    ["a disabled guard", "alter table public.tasks disable trigger tasks_pk_immutable", { table: "tasks", key: "id" }],
    [
      "a NEW table a migration grants UPDATE on (the repository grants per table, 0002)",
      "create table public.zz_pk_probe (id uuid primary key); grant update on public.zz_pk_probe to authenticated",
      { table: "zz_pk_probe", key: "id" },
    ],
    [
      "a guard that covers only part of a composite key",
      `drop trigger price_list_items_pk_immutable on public.price_list_items;
       create trigger price_list_items_pk_immutable before update of price_list_id on public.price_list_items
         for each row execute function public.trg_primary_key_immutable('price_list_id')`,
      { table: "price_list_items", key: "price_list_id,unit_id" },
    ],
    [
      "a guard with no UPDATE OF list",
      `drop trigger tasks_pk_immutable on public.tasks;
       create trigger tasks_pk_immutable before update on public.tasks
         for each row execute function public.trg_primary_key_immutable('id')`,
      { table: "tasks", key: "id" },
    ],
    [
      "a guard with an extra, empty argument",
      `drop trigger tasks_pk_immutable on public.tasks;
       create trigger tasks_pk_immutable before update of id on public.tasks
         for each row execute function public.trg_primary_key_immutable('id', '')`,
      { table: "tasks", key: "id" },
    ],
    [
      "a composite key passed as ONE comma-joined argument",
      `drop trigger price_list_items_pk_immutable on public.price_list_items;
       create trigger price_list_items_pk_immutable before update of price_list_id, unit_id on public.price_list_items
         for each row execute function public.trg_primary_key_immutable('price_list_id,unit_id')`,
      { table: "price_list_items", key: "price_list_id,unit_id" },
    ],
    [
      "a guard with a WHEN that never holds (fails OPEN)",
      `drop trigger contacts_pk_immutable on public.contacts;
       create trigger contacts_pk_immutable before update of id on public.contacts
         for each row when (false) execute function public.trg_primary_key_immutable('id')`,
      { table: "contacts", key: "id" },
    ],
    [
      "a guard whose argument is not the key",
      `drop trigger contacts_pk_immutable on public.contacts;
       create trigger contacts_pk_immutable before update of id on public.contacts
         for each row execute function public.trg_primary_key_immutable('org_id')`,
      { table: "contacts", key: "id" },
    ],
  ];
  for (const [label, drift, expected] of drifts) {
    it(`the catalogue test sees ${label}`, async () => {
      await rolledBack(async () => {
        await o.query(drift);
        expect(await unguarded()).toContainEqual(expected);
      });
    });
  }

  /** The restore pack's 0132 row, exactly as scripts/backup/verify-restore.sql carries it. */
  const packRow = () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'SECURITY: no session can change a record''s primary key");
    const to = pack.indexOf("\n  union all\n", from);
    expect(from, "the pack carries the 0132 row").toBeGreaterThan(0);
    return `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
  };
  it("the restore pack's 0132 row passes now, and reads a misshapen guard, a re-opened table and an unbound body", async () => {
    const now = (await o.query<{ expected: string; actual: string }>(packRow())).rows[0]!;
    expect(now.actual).toBe(now.expected);
    expect(now.expected).toBe("0 25 true");
    for (const drift of [
      `drop trigger contacts_pk_immutable on public.contacts;
       create trigger contacts_pk_immutable before update of id on public.contacts
         for each row when (false) execute function public.trg_primary_key_immutable('id')`,
      "create table public.zz_pk_probe3 (id uuid primary key); grant update on public.zz_pk_probe3 to authenticated",
      `create or replace function public.trg_primary_key_immutable() returns trigger language plpgsql
         set search_path = public, pg_temp as $f$ begin return new; end $f$`,
    ]) {
      await rolledBack(async () => {
        await o.query(drift);
        const r = (await o.query<{ expected: string; actual: string }>(packRow())).rows[0]!;
        expect(r.actual, drift).not.toBe(r.expected);
      });
    }
  });

  it("a misattached guard fails closed for a session: a bad argument refuses the statement (42703), never lets it through", async () => {
    const f = fx();
    await rolledBack(async () => {
      await o.query(fixtureSql(f));
      await o.query(`insert into public.contacts (id, org_id, first_name, assigned_agent_id) values ('${f.T}', '${f.org}', 'T', '${f.agent}')`);
      await o.query(`drop trigger contacts_pk_immutable on public.contacts;
        create trigger contacts_pk_immutable before update of id on public.contacts
          for each row execute function public.trg_primary_key_immutable('no_such_column')`);
      await asSession(f.agent);
      await expect(o.query(`update public.contacts set id = '${f.NEW}' where id = '${f.T}'`)).rejects.toMatchObject({ code: "42703" });
    });
  });

  it("…and attached any other way than BEFORE UPDATE FOR EACH ROW with arguments, it refuses to run", async () => {
    const f = fx();
    await rolledBack(async () => {
      await o.query(fixtureSql(f));
      await o.query(`create trigger zz_pk_misattached before insert on public.contacts
        for each row execute function public.trg_primary_key_immutable('id')`);
      await expect(o.query(`insert into public.contacts (org_id, first_name) values ('${f.org}', 'T')`)).rejects.toThrow(
        /trg_primary_key_immutable runs only as a BEFORE UPDATE row trigger/,
      );
    });
    // a statement-level attachment would see OLD / NEW as NULL and pass every
    // change; an AFTER one would refuse too late; one with no argument would
    // fail on an opaque 22004 (TG_ARGV is NULL), not on a refusal that names
    // the mistake — each refuses instead, with the guard's own message, for the
    // session it is meant to bind
    for (const attach of [
      "before update of id on public.zz_pk_attach for each statement execute function public.trg_primary_key_immutable('id')",
      "after update of id on public.zz_pk_attach for each row execute function public.trg_primary_key_immutable('id')",
      "before update of id on public.zz_pk_attach for each row execute function public.trg_primary_key_immutable()",
    ]) {
      await rolledBack(async () => {
        await o.query("create table public.zz_pk_attach (id int primary key); insert into public.zz_pk_attach values (1)");
        await o.query("grant select, update on public.zz_pk_attach to authenticated");
        await o.query(`create trigger zz_pk_attach_guard ${attach}`);
        await o.query("set local role authenticated");
        await expect(o.query("update public.zz_pk_attach set id = 2 where id = 1"), attach).rejects.toThrow(
          /trg_primary_key_immutable runs only as a BEFORE UPDATE row trigger/,
        );
      });
    }
  });

  it("the anon arm binds too: if anon is ever granted UPDATE on a guarded key, its change is refused and a restatement passes", async () => {
    await rolledBack(async () => {
      await o.query("create table public.zz_pk_attach (id int primary key); insert into public.zz_pk_attach values (1)");
      await o.query("grant select, update on public.zz_pk_attach to anon");
      await o.query(`create trigger zz_pk_attach_guard before update of id on public.zz_pk_attach
        for each row execute function public.trg_primary_key_immutable('id')`);
      await o.query("set local role anon");
      expect((await o.query("update public.zz_pk_attach set id = 1 where id = 1")).rowCount, "restating").toBe(1);
      await o.query("savepoint s");
      await expect(o.query("update public.zz_pk_attach set id = 2 where id = 1")).rejects.toMatchObject({
        code: "42501",
        message: refusal("zz_pk_attach"),
      });
      await o.query("rollback to savepoint s");
    });
  });
});

// ---------------------------------------------------------------------------
describe("6. the migration: it replays over 0131, refuses what it was not written against, and its rollback restores 0131", () => {
  const unguarded = async () => (await o.query<{ table: string; key: string }>(UNGUARDED_SQL)).rows;

  it("over the rollback's 0131 state, the file's preflight and postflight pass and its last row names the 25 tables", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0132_SQL);
      expect((await unguarded()).map((r) => r.table)).toHaveLength(26);
      const results = [(await o.query(readMigration0132()))].flat();
      expect(notices.some((m) => m.startsWith("0132: preflight passed")), notices.join("\n")).toBe(true);
      expect(notices.some((m) => m.startsWith("0132: postflight passed")), notices.join("\n")).toBe(true);
      const last = results[results.length - 1] as { rows: Array<{ guarded_tables: string; tables: string }> };
      expect(Number(last.rows[0]!.guarded_tables)).toBe(25);
      expect(last.rows[0]!.tables.split(", ").sort()).toEqual(GUARDED.map(([t]) => t).sort());
      expect(await unguarded()).toEqual([{ table: "deals", key: "id" }]);
    });
  });

  it("the file refuses before it changes anything, and takes every lock before its first change", () => {
    const sql = readMigration0132().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.indexOf("0132 aborted"), "every refusal sits in the preflight, before the first change").toBeGreaterThan(0);
    expect(sql.lastIndexOf("0132 aborted")).toBeLessThan(firstChange);
    expect(sql.search(/\block table\b/i)).toBeGreaterThan(0);
    expect(sql.search(/\block table\b/i)).toBeLessThan(firstChange);
    // its one LOCK statement names exactly the guarded tables, in the order
    // the rollback reverses (revert-0132.ts keeps that order in one place)
    const lock = /lock table([\s\S]*?)in share row exclusive mode/i.exec(sql)![1]!;
    const locked = lock.split(",").map((t) => t.trim().replace(/^public\./, ""));
    expect(locked).toEqual([...LOCK_ORDER_0132]);
    expect([...locked].sort()).toEqual(GUARDED.map(([t]) => t).sort());
  });

  const refusals: Array<[string, string, RegExp]> = [
    [
      "a 27th table whose key an API role may update",
      "create table public.zz_pk_probe2 (id uuid primary key); grant update on public.zz_pk_probe2 to authenticated;",
      /0132 aborted: the tables whose primary key an API role may update are not the 26/,
    ],
    ["a deals guard that no longer refuses a re-key (0118's body)", GUARD_0118, /0132 aborted: deals_closed_guard does not refuse/],
    [
      "a function of its name already there",
      "create function public.trg_primary_key_immutable() returns trigger language plpgsql as $f$ begin return new; end $f$;",
      /0132 aborted: public\.trg_primary_key_immutable\(\) already exists/,
    ],
    [
      "a trigger of its naming already there",
      "create trigger tasks_pk_immutable before update on public.tasks for each row execute function public.set_updated_at();",
      /0132 aborted: a trigger named \*_pk_immutable already exists/,
    ],
  ];
  for (const [label, drift, refused] of refusals) {
    it(`the preflight refuses ${label}`, async () => {
      await rolledBack(async () => {
        await o.query(REVERT_0132_SQL);
        await o.query(drift);
        await expect(o.query(readMigration0132())).rejects.toThrow(refused);
      });
    });
  }

  it("the postflight refuses the file's own text if a guard is misshapen (here: tasks without UPDATE OF)", async () => {
    const bad = readMigration0132().replace(
      "create trigger tasks_pk_immutable before update of id on public.tasks",
      "create trigger tasks_pk_immutable before update on public.tasks",
    );
    expect(bad, "the edit really went in").not.toBe(readMigration0132());
    await rolledBack(async () => {
      await o.query(REVERT_0132_SQL);
      await expect(o.query(bad)).rejects.toThrow(/0132 postflight: not BEFORE UPDATE OF exactly the primary key/);
    });
  });

  it("the rollback recipe restores 0131's behaviour: an admin session may re-key a contact again", async () => {
    const f = fx();
    await rolledBack(async () => {
      await o.query(REVERT_0132_SQL);
      expect((await o.query("select to_regprocedure('public.trg_primary_key_immutable()') as f")).rows[0].f).toBeNull();
      await o.query(fixtureSql(f));
      await o.query(`insert into public.contacts (id, org_id, first_name) values ('${f.T}', '${f.org}', 'T')`);
      await asSession(f.admin);
      const r = await o.query(`update public.contacts set id = '${f.NEW}' where id = '${f.T}'`);
      expect(r.rowCount).toBe(1);
    });
  });
});
