import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  TEST_PASSWORD,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";
import { REVERT_0141_SQL, readMigration0141 } from "./revert-0141";
import { previewUplift, type UpliftSpec, type UpliftTarget } from "@/lib/services/price-uplift";

/**
 * record_price_list_version (0141) at the database: direct calls, the way any
 * PostgREST client — not just the app — can make them (T-price-uplift-atomic).
 *
 *   1. who may call it: every persona the policies know, through PostgREST,
 *      each refusal checked to leave nothing behind;
 *   2. what it accepts: the form's rules restated in SQL, NULL refusing;
 *   3. the operation id: replay, refusal of reuse, scoping by organisation;
 *   4. ordered races on real row locks, each wait OBSERVED in
 *      pg_stat_activity — a price edit, a unit created, a second version,
 *      a demotion and a reused id against a call in flight;
 *   5. the canonical-trail tripwire (a disabled trg_price_history refuses);
 *   6. parity: the form's preview (lib/services/price-uplift.ts) and the
 *      database agree digit for digit, boundaries and cuts included;
 *   7. the migration: replay over the state before it, its refusals, its
 *      diagnostic, its rollback.
 *
 * Every probe runs in a throwaway organisation (plus a second, the isolation
 * control); sections 5 and 7 run inside rolled-back transactions. Barriers are
 * conditions, never sleeps.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SIG = "public.record_price_list_version(uuid,uuid,text,text,numeric,text,jsonb)";

let svc: SupabaseClient;
let o: Client; // observer / postgres
let a: Client; // racer A
let b: Client; // racer B
let admin: TestUser;
let manager: TestUser;
let agent: TestUser;
let otherAdmin: TestUser;
let inactive: TestUser;
const userIds: string[] = [];
let n = 0;

type Project = { id: string; reference: string; org: string; units: Record<string, string> };
type UnitSpec = { code: string; block: string | null; price: number | string | null; archived?: boolean };

async function newProject(units: UnitSpec[], org = ORG): Promise<Project> {
  n += 1;
  const reference = `ZZPL${TAG}${n}`;
  const { rows } = await o.query<{ id: string }>(
    `insert into properties (org_id, reference, kind, property_type, status)
     values ($1, $2, 'project', 'apartment', 'available') returning id`,
    [org, reference],
  );
  const ids: Record<string, string> = {};
  for (const u of units) {
    const { rows: r } = await o.query<{ id: string }>(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status, visibility, block, unit_number, asking_price)
       values ($1, $2, 'unit', $3, 'apartment', 'available', $4::visibility_level, $5, $6, $7) returning id`,
      [org, `${reference}-${u.code}`, rows[0]!.id, u.archived ? "archived" : "private", u.block, u.code, u.price],
    );
    ids[u.code] = r[0]!.id;
  }
  return { id: rows[0]!.id, reference, org, units: ids };
}

const BASIC: UnitSpec[] = [
  { code: "A1", block: "A", price: 200000 },
  { code: "A2", block: "A", price: 300000 },
  { code: "B1", block: "B", price: 400000 },
];

/** The scope a page would review — direct, not archived, the block or all — as the form sends it. */
async function reviewed(p: Project, block: string | null = null): Promise<{ id: string; price: number | null }[]> {
  const { rows } = await o.query<{ id: string; price: string | null }>(
    `select id, asking_price::text as price from properties
      where parent_id = $1 and kind = 'unit' and visibility <> 'archived' and ($2::text is null or block = $2)
      order by id`,
    [p.id, block],
  );
  return rows.map((r) => ({ id: r.id, price: r.price === null ? null : Number(r.price) }));
}

type Snap = { prices: Record<string, string | null>; history: number; events: number; versions: number; items: number };
async function snap(p: Project): Promise<Snap> {
  const prices: Snap["prices"] = {};
  for (const [code, id] of Object.entries(p.units)) {
    prices[code] = (await o.query<{ p: string | null }>("select asking_price::text as p from properties where id = $1", [id])).rows[0]!.p;
  }
  const { rows } = await o.query<{ h: string; e: string; v: string; i: string }>(
    `select (select count(*) from price_history where property_id in (select id from properties where parent_id = $1))::text as h,
            (select count(*) from events where org_id = $2 and (entity_id = $1 or entity_id in (select id from properties where parent_id = $1)))::text as e,
            (select count(*) from price_lists where project_id = $1)::text as v,
            (select count(*) from price_list_items i join price_lists l on l.id = i.price_list_id where l.project_id = $1)::text as i`,
    [p.id, p.org],
  );
  return { prices, history: Number(rows[0]!.h), events: Number(rows[0]!.e), versions: Number(rows[0]!.v), items: Number(rows[0]!.i) };
}

type Args = {
  p_project_id: string;
  p_operation_id: string;
  p_notes?: string | null;
  p_mode?: string | null;
  p_amount?: number | string | null;
  p_block?: string | null;
  p_expected?: unknown;
};
type Answer = Record<string, unknown> & { result?: string; version?: number };

async function call(user: TestUser | SupabaseClient, args: Args) {
  const client = "client" in user ? user.client : user;
  return client.rpc("record_price_list_version", args as never) as unknown as Promise<{
    data: Answer | null;
    error: { code?: string; message?: string } | null;
  }>;
}

async function reprice(user: TestUser, p: Project, spec: { amount: number | string; mode?: string; block?: string | null }, op = randomUUID()) {
  return call(user, {
    p_project_id: p.id,
    p_operation_id: op,
    p_mode: spec.mode ?? "percent",
    p_amount: spec.amount,
    p_block: spec.block ?? null,
    p_expected: await reviewed(p, spec.block ?? null),
  });
}

/** A pg session acting as `uid` (role authenticated, aal claims) — inside a transaction, or it runs as postgres. */
async function asUser(c: Client, uid: string, aal: "aal1" | "aal2" = "aal2") {
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal })]);
}
const RPC_SQL =
  "select public.record_price_list_version($1::uuid, $2::uuid, $3::text, $4::text, $5::numeric, $6::text, $7::jsonb) as r";
const rpcParams = (a: Args) => [
  a.p_project_id,
  a.p_operation_id,
  a.p_notes ?? null,
  a.p_mode ?? null,
  a.p_amount ?? null,
  a.p_block ?? null,
  a.p_expected === undefined ? null : JSON.stringify(a.p_expected),
];

type Settled = { value: { rows: { r: Answer }[] } | null; error: Error | null };
/** A query whose rejection is observed at once (an unobserved one fails the run), resolved later. */
function settled(q: Promise<{ rows: { r: Answer }[] }>): Promise<Settled> {
  return q.then(
    (value) => ({ value, error: null }),
    (error: Error) => ({ value: null, error }),
  );
}
async function pidOf(c: Client) {
  return (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
}
async function waitsOnLock(pid: number) {
  const { rows } = await o.query<{ w: string | null }>("select wait_event_type as w from pg_stat_activity where pid = $1", [pid]);
  return rows[0]?.w === "Lock";
}
/** Some backend (PostgREST's, whose pid we cannot know) waits on a lock running a statement that matches. */
async function someoneWaitsOn(pattern: string) {
  const { rows } = await o.query<{ c: string }>(
    "select count(*)::text as c from pg_stat_activity where wait_event_type = 'Lock' and query ilike $1",
    [pattern],
  );
  return Number(rows[0]!.c) > 0;
}
async function until(label: string, cond: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`barrier timed out: ${label}`);
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  a = new Client({ connectionString: DB_URL });
  b = new Client({ connectionString: DB_URL });
  await Promise.all([o.connect(), a.connect(), b.connect()]);
  await ensureTestOrg(svc, ORG, `Price list ${RUN}`, `price-list-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `Price list other ${RUN}`, `price-list-other-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `pl-admin-${RUN}@test.local`, "admin", ORG);
  manager = await createTestUser(svc, `pl-lm-${RUN}@test.local`, "listing_manager", ORG);
  agent = await createTestUser(svc, `pl-agent-${RUN}@test.local`, "agent", ORG);
  otherAdmin = await createTestUser(svc, `pl-other-${RUN}@test.local`, "admin", OTHER_ORG);
  inactive = await createTestUser(svc, `pl-inactive-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id, manager.id, agent.id, otherAdmin.id, inactive.id);
  await o.query("update profiles set is_active = false where id = $1", [inactive.id]);
});

afterEach(async () => {
  // a racer left mid-transaction by a failed test must not hold its locks into the next
  await Promise.all([a.query("rollback"), b.query("rollback")]);
});

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from properties where org_id = $1 and kind = 'unit'", [org]);
    await o.query("delete from properties where org_id = $1", [org]);
  }
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from profiles where org_id = $1", [org]);
    await o.query("delete from events where org_id = $1", [org]);
    await o.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await o.query("delete from chain_checks where org_id = $1", [org]);
    await o.query("delete from deal_stages where org_id = $1", [org]);
    await o.query("delete from districts where org_id = $1", [org]);
    await o.query("delete from organizations where id = $1", [org]);
  }
  await Promise.all([o.end(), a.end(), b.end()]);
});

// ---------------------------------------------------------------------------
describe("1. who may call it — through PostgREST, and a refusal writes nothing", () => {
  it("admin and listing manager may: one version, one history row and one price_changed event per moved unit", async () => {
    for (const user of [admin, manager]) {
      const p = await newProject(BASIC);
      const res = await reprice(user, p, { amount: 10 });
      expect(res.error).toBeNull();
      expect(res.data).toMatchObject({ result: "applied", kind: "reprice", version: 1, units: 3, changed: 3, actor_id: user.id, org_id: ORG });
      const s = await snap(p);
      expect(s).toMatchObject({ prices: { A1: "220000.00", A2: "330000.00", B1: "440000.00" }, history: 3, versions: 1, items: 3 });
      // three trigger lines + the version's own
      expect(s.events).toBe(4);
    }
  });

  it("anon and service_role cannot execute it at all (42501)", async () => {
    const p = await newProject(BASIC);
    const before = await snap(p);
    for (const client of [anonClient(), serviceClient()]) {
      const res = await call(client, { p_project_id: p.id, p_operation_id: randomUUID() });
      expect(res.error?.code).toBe("42501");
    }
    expect(await snap(p)).toEqual(before);
  });

  it("an agent, an aal1 session, a deactivated admin and another organisation's admin are refused with their own sentence", async () => {
    const p = await newProject(BASIC);
    const before = await snap(p);
    const aal1Client = anonClient();
    expect((await aal1Client.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD })).error).toBeNull();
    const cases: Array<[string, TestUser | SupabaseClient, RegExp]> = [
      ["agent", agent, /^Only admins and listing managers manage price lists\.$/],
      ["aal1 admin", aal1Client, /^Second factor required\.$/],
      ["deactivated admin", inactive, /^Account deactivated\.$/],
      ["other organisation's admin", otherAdmin, /^Project not found$/],
    ];
    for (const [label, who, msg] of cases) {
      for (const args of [
        { p_project_id: p.id, p_operation_id: randomUUID() },
        { p_project_id: p.id, p_operation_id: randomUUID(), p_mode: "percent", p_amount: 10, p_expected: await reviewed(p) },
      ]) {
        const res = await call(who, args);
        expect(res.error?.message, label).toMatch(msg);
        expect(res.error?.code, label).toBe("P0001");
      }
    }
    expect(await snap(p)).toEqual(before);
  });

  it("a unit, a missing id and another organisation's project all read 'Project not found' — no existence oracle", async () => {
    const p = await newProject(BASIC);
    const q = await newProject(BASIC, OTHER_ORG);
    for (const id of [p.units.A1!, randomUUID(), q.id]) {
      const res = await call(admin, { p_project_id: id, p_operation_id: randomUUID() });
      expect(res.error?.message).toBe("Project not found");
    }
    expect((await snap(q)).versions).toBe(0);
  });

  it("the role is checked before any row is read: an agent asking about a missing id gets the role sentence, not 'not found'", async () => {
    const res = await call(agent, { p_project_id: randomUUID(), p_operation_id: randomUUID() });
    expect(res.error?.message).toBe("Only admins and listing managers manage price lists.");
  });
});

// ---------------------------------------------------------------------------
describe("2. what it accepts — the form's rules, in the database, NULL refusing", () => {
  const read = /^The reviewed prices could not be read/;
  it("refuses malformed requests before it writes anything", async () => {
    const p = await newProject(BASIC);
    const before = await snap(p);
    const ok = await reviewed(p);
    const base = { p_project_id: p.id, p_mode: "percent", p_amount: 10, p_expected: ok } as const;
    const cases: Array<[string, Args, RegExp]> = [
      ["no operation id", { ...base, p_operation_id: null as unknown as string }, /^This form is out of date/],
      ["unknown mode", { ...base, p_operation_id: randomUUID(), p_mode: "double" }, /^Unknown change/],
      ["zero", { ...base, p_operation_id: randomUUID(), p_amount: 0 }, /^Enter a change other than zero$/],
      ["no amount", { ...base, p_operation_id: randomUUID(), p_amount: null }, /^Enter a change other than zero$/],
      ["NaN", { ...base, p_operation_id: randomUUID(), p_amount: "NaN" }, /^Enter a change other than zero$/],
      ["Infinity", { ...base, p_operation_id: randomUUID(), p_amount: "Infinity" }, /^Enter a change other than zero$/],
      ["no reviewed prices", { ...base, p_operation_id: randomUUID(), p_expected: null }, read],
      ["reviewed prices not an array", { ...base, p_operation_id: randomUUID(), p_expected: { id: p.units.A1 } }, read],
      ["an element without a price", { ...base, p_operation_id: randomUUID(), p_expected: [{ id: p.units.A1 }] }, read],
      ["a price that is text", { ...base, p_operation_id: randomUUID(), p_expected: [{ id: p.units.A1, price: "200000" }] }, read],
      ["an id that is not one", { ...base, p_operation_id: randomUUID(), p_expected: [{ id: "A1", price: 200000 }] }, read],
      ["a unit twice", { ...base, p_operation_id: randomUUID(), p_expected: [...ok, ok[0]] }, read],
      ["a snapshot with a change attached", { p_project_id: p.id, p_operation_id: randomUUID(), p_amount: 10 }, /^A plain price list version takes no price change\.$/],
      ["a snapshot with reviewed prices", { p_project_id: p.id, p_operation_id: randomUUID(), p_expected: ok }, /^A plain price list version takes no price change\.$/],
      ["a 2001-character note", { p_project_id: p.id, p_operation_id: randomUUID(), p_notes: "x".repeat(2001) }, /^Keep the version note under 2000 characters\.$/],
      ["a 21-character block", { ...base, p_operation_id: randomUUID(), p_block: "B".repeat(21), p_expected: [] }, /^No units in that scope$/],
      ["a price past numeric(14,2)", { ...base, p_operation_id: randomUUID(), p_mode: "fixed", p_amount: "999999999999" }, /^That change would take a price past/],
    ];
    for (const [label, args, msg] of cases) {
      const res = await call(admin, args);
      expect(res.error?.message ?? `answered ${JSON.stringify(res.data)}`, label).toMatch(msg);
    }
    expect(await snap(p)).toEqual(before);
  });

  it("an empty scope, an all-unpriced scope and a change that rounds to nothing keep the form's sentences", async () => {
    const p = await newProject([
      { code: "N1", block: "N", price: null },
      { code: "M1", block: "M", price: 250000 },
    ]);
    const before = await snap(p);
    expect((await reprice(admin, p, { amount: 10, block: "Z" })).error?.message).toBe("No units in that scope");
    expect((await reprice(admin, p, { amount: 10, block: "N" })).error?.message).toBe("None of those units has a price to change.");
    expect((await reprice(admin, p, { amount: 10, mode: "fixed", block: "M" })).error?.message).toBe(
      "That change rounds to nothing — no price would move.",
    );
    expect(await snap(p)).toEqual(before);
  });

  it("a plain snapshot of a project with no priced unit is refused as before", async () => {
    const p = await newProject([{ code: "N1", block: null, price: null }]);
    const res = await call(admin, { p_project_id: p.id, p_operation_id: randomUUID() });
    expect(res.error?.message).toBe("No units with prices to snapshot");
    expect((await snap(p)).versions).toBe(0);
  });

  it("the default note is the action's old wording; a typed note is kept on the row and never in the event", async () => {
    const p = await newProject(BASIC);
    expect((await reprice(admin, p, { amount: 3, block: "A" })).error).toBeNull();
    expect((await call(admin, { p_project_id: p.id, p_operation_id: randomUUID(), p_notes: "  ZZTEST typed note  " })).error).toBeNull();
    const { rows } = await o.query<{ version: number; notes: string | null }>(
      "select version, notes from price_lists where project_id = $1 order by version",
      [p.id],
    );
    expect(rows).toEqual([
      { version: 1, notes: "+3% on block A (2 units)" },
      { version: 2, notes: "ZZTEST typed note" },
    ]);
    const { rows: ev } = await o.query<{ payload: Record<string, unknown> }>(
      "select payload from events where org_id = $1 and entity_id = $2 and event_type = 'price_list_created' order by id",
      [ORG, p.id],
    );
    expect(ev.map((e) => e.payload)).toEqual([
      expect.objectContaining({ version: 1, units: 3, source: "bulk_uplift", mode: "percent", amount: 3, scope: "A", changed: 2 }),
      expect.not.objectContaining({ source: expect.anything() }),
    ]);
    expect(JSON.stringify(ev)).not.toMatch(/ZZTEST typed note/);
  });
});

// ---------------------------------------------------------------------------
describe("3. the operation id", () => {
  it("a replay answers the original version and counts — even after a newer version exists — and writes nothing", async () => {
    const p = await newProject(BASIC);
    const op = randomUUID();
    const args: Args = { p_project_id: p.id, p_operation_id: op, p_mode: "percent", p_amount: 10, p_expected: await reviewed(p) };
    const first = await call(admin, args);
    expect(first.data).toMatchObject({ result: "applied", version: 1, changed: 3 });
    expect((await call(admin, { p_project_id: p.id, p_operation_id: randomUUID() })).data).toMatchObject({ result: "applied", version: 2 });
    const before = await snap(p);
    const again = await call(admin, args);
    expect(again.data).toMatchObject({ result: "replayed", kind: "reprice", version: 1, changed: 3, units: 3, price_list_id: first.data!.price_list_id });
    // the changes it committed, read back from price_history — what the bulk
    // price-drop alert needs if the committing request lost its answer
    expect(again.data!.changes).toEqual(first.data!.changes);
    expect(await snap(p)).toEqual(before);
  });

  it("the same id on another project, with another amount or from another user is refused; in another organisation it is its own", async () => {
    const p = await newProject(BASIC);
    const p2 = await newProject(BASIC);
    const q = await newProject(BASIC, OTHER_ORG);
    const op = randomUUID();
    const original: Args = { p_project_id: p.id, p_operation_id: op, p_mode: "percent", p_amount: 10, p_expected: await reviewed(p) };
    expect((await call(admin, original)).data?.result).toBe("applied");
    const before = await snap(p);
    const before2 = await snap(p2);
    for (const res of [
      await reprice(admin, p2, { amount: 10 }, op),
      await reprice(admin, p, { amount: 11 }, op),
      await call(admin, { p_project_id: p.id, p_operation_id: op }),
      // the admin's EXACT request from another user: only the creator check refuses it
      // (the request's md5 names no user)
      await call(manager, original),
    ]) {
      expect(res.error?.message).toBe("This submission was already used for a different change — reload the page and review it again.");
    }
    expect(await snap(p)).toEqual(before);
    expect(await snap(p2)).toEqual(before2);
    // ids are scoped per organisation: another organisation's same id is a different submission
    expect((await reprice(otherAdmin, q, { amount: 10 }, op)).data).toMatchObject({ result: "applied", version: 1 });
  });
});

// ---------------------------------------------------------------------------
describe("4. ordered races on real locks — each wait observed", () => {
  it("a price edit in flight: the call waits for it, then finds the review stale and changes nothing", async () => {
    const p = await newProject(BASIC);
    const args: Args = { p_project_id: p.id, p_operation_id: randomUUID(), p_mode: "percent", p_amount: 10, p_expected: await reviewed(p) };
    await asUser(a, admin.id);
    await a.query("update properties set asking_price = 210000 where id = $1", [p.units.A1]);
    await asUser(b, manager.id);
    const pidB = await pidOf(b);
    const pB = settled(b.query(RPC_SQL, rpcParams(args)));
    await until("the call waits on the edited unit", () => waitsOnLock(pidB));
    await a.query("commit");
    const r = await pB;
    expect(r.error).toBeNull();
    expect(r.value!.rows[0]!.r).toMatchObject({ result: "stale" });
    await b.query("commit");
    const s = await snap(p);
    expect(s.prices).toEqual({ A1: "210000.00", A2: "300000.00", B1: "400000.00" });
    expect(s.versions).toBe(0);
  });

  it("a call in flight: a price edit waits for it, and the version holds the prices it committed", async () => {
    const p = await newProject(BASIC);
    await asUser(a, admin.id);
    const r = await a.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: randomUUID(), p_mode: "percent", p_amount: 10, p_expected: await reviewed(p) }));
    expect(r.rows[0]!.r).toMatchObject({ result: "applied", version: 1 });
    // a supabase-js builder is lazy: Promise.resolve sends it NOW, so it can be seen waiting
    const edit = Promise.resolve(
      manager.client.from("properties").update({ asking_price: 999900 }).eq("id", p.units.A1!).select("id"),
    );
    await until("the edit waits on the repriced unit", () => someoneWaitsOn("%update%properties%"));
    await a.query("commit");
    const e = await edit;
    expect(e.error).toBeNull();
    expect(e.data).toHaveLength(1);
    const { rows } = await o.query<{ p: string }>(
      "select i.list_price::text as p from price_list_items i join price_lists l on l.id = i.price_list_id where l.project_id = $1 and i.unit_id = $2",
      [p.id, p.units.A1],
    );
    expect(rows[0]!.p, "the version is the state it committed").toBe("220000.00");
    expect((await snap(p)).prices.A1, "the later edit applied after it").toBe("999900.00");
  });

  it("a call in flight: a unit created under the project does not wait for it (no foreign-key coupling), and reads as created after the version", async () => {
    const p = await newProject(BASIC);
    await asUser(a, admin.id);
    const r = await a.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: randomUUID() }));
    expect(r.rows[0]!.r).toMatchObject({ result: "applied", units: 3 });
    // completes while the call still holds its locks: the container is locked FOR NO KEY
    // UPDATE, which the insert's KEY SHARE does not wait for
    const create = await admin.client
      .from("properties")
      .insert({
        org_id: ORG,
        reference: `${p.reference}-C9`,
        kind: "unit",
        parent_id: p.id,
        property_type: "apartment",
        status: "available",
        unit_number: "C9",
        asking_price: 123400,
      })
      .select("id");
    expect(create.error).toBeNull();
    await a.query("commit");
    expect((await snap(p)).items, "the version is the state before the unit existed").toBe(3);
  });

  it("the nightly sweeps' order — an event first, then a row that references the project — does not deadlock with a call", async () => {
    // create_followup_nudges / expire_mandates write events (taking the
    // organisation's chain lock) and then insert tasks naming a property (a
    // foreign-key check: KEY SHARE on it). A call holding the project FOR
    // UPDATE while waiting for that chain lock would deadlock them (review)
    const p = await newProject(BASIC);
    await a.query("begin");
    await a.query(
      "insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload) values ($1, null, 'property', $2, 'zz_sweep_probe', '{}'::jsonb)",
      [ORG, p.id],
    );
    await asUser(b, admin.id);
    const pidB = await pidOf(b);
    const pB = settled(
      b.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: randomUUID(), p_mode: "percent", p_amount: 10, p_expected: await reviewed(p) })),
    );
    await until("the call waits for the sweep's chain lock", () => waitsOnLock(pidB));
    // the sweep's second step must not wait on the call
    await a.query("insert into tasks (org_id, title, property_id) values ($1, 'ZZTEST sweep probe', $2)", [ORG, p.id]);
    await a.query("rollback");
    const r = await pB;
    expect(r.error).toBeNull();
    expect(r.value!.rows[0]!.r).toMatchObject({ result: "applied", changed: 3 });
    await b.query("commit");
    expect((await snap(p)).prices.A1).toBe("220000.00");
  });

  it("two versions at once: the second waits on the project, then takes the next number", async () => {
    const p = await newProject(BASIC);
    await asUser(a, admin.id);
    expect((await a.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: randomUUID() }))).rows[0]!.r).toMatchObject({ version: 1 });
    await asUser(b, manager.id);
    const pidB = await pidOf(b);
    const pB = settled(b.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: randomUUID() })));
    await until("the second call waits on the project", () => waitsOnLock(pidB));
    await a.query("commit");
    const r = await pB;
    expect(r.error).toBeNull();
    expect(r.value!.rows[0]!.r).toMatchObject({ result: "applied", version: 2, units: 3 });
    await b.query("commit");
  });

  it("demoted while waiting: the call is refused under the lock and writes nothing", async () => {
    const p = await newProject(BASIC);
    await asUser(a, admin.id);
    await a.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: randomUUID() }));
    await asUser(b, manager.id);
    const pidB = await pidOf(b);
    const pB = settled(
      b.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: randomUUID(), p_mode: "percent", p_amount: 10, p_expected: await reviewed(p) })),
    );
    await until("the manager's call waits", () => waitsOnLock(pidB));
    await o.query("update profiles set role = 'agent' where id = $1", [manager.id]);
    try {
      await a.query("commit");
      const r = await pB;
      expect(r.error?.message).toBe("Only admins and listing managers manage price lists.");
      await b.query("rollback");
      const s = await snap(p);
      expect(s.prices).toEqual({ A1: "200000.00", A2: "300000.00", B1: "400000.00" });
      expect(s.versions).toBe(1);
    } finally {
      await o.query("update profiles set role = 'listing_manager' where id = $1", [manager.id]);
    }
  });

  it("the same id twice at once: the second waits, then replays the first", async () => {
    const p = await newProject(BASIC);
    const args: Args = { p_project_id: p.id, p_operation_id: randomUUID(), p_mode: "percent", p_amount: 10, p_expected: await reviewed(p) };
    await asUser(a, admin.id);
    expect((await a.query(RPC_SQL, rpcParams(args))).rows[0]!.r).toMatchObject({ result: "applied" });
    await asUser(b, admin.id);
    const pidB = await pidOf(b);
    const pB = settled(b.query(RPC_SQL, rpcParams(args)));
    await until("the repeat waits", () => waitsOnLock(pidB));
    await a.query("commit");
    const r = await pB;
    expect(r.value!.rows[0]!.r).toMatchObject({ result: "replayed", version: 1 });
    await b.query("commit");
    const s = await snap(p);
    expect(s.prices.A1).toBe("220000.00");
    expect(s.history).toBe(3);
  });

  it("the same id on two projects at once (a plain version): the second waits on the first's operation key, then is refused", async () => {
    const p = await newProject(BASIC);
    const q = await newProject(BASIC);
    const op = randomUUID();
    await asUser(a, admin.id);
    expect((await a.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: op }))).rows[0]!.r).toMatchObject({ result: "applied" });
    await asUser(b, admin.id);
    const pidB = await pidOf(b);
    // a plain version writes no event before its header, so what it waits on IS
    // the uncommitted (org_id, operation_id) entry: a transaction id, not the chain lock
    const pB = settled(b.query(RPC_SQL, rpcParams({ p_project_id: q.id, p_operation_id: op })));
    await until("the second waits on the first's operation key", async () => {
      const { rows } = await o.query<{ e: string | null }>("select wait_event as e from pg_stat_activity where pid = $1", [pidB]);
      return rows[0]?.e === "transactionid";
    });
    await a.query("commit");
    const r = await pB;
    expect(r.error?.message).toBe("This submission was already used for a different change — reload the page and review it again.");
    await b.query("rollback");
    expect((await snap(q)).versions).toBe(0);
  });

  it("the same id on two projects at once (a reprice): the second waits (on the chain lock), is refused at its header and keeps none of its repricing", async () => {
    const p = await newProject(BASIC);
    const q = await newProject(BASIC);
    const op = randomUUID();
    await asUser(a, admin.id);
    expect((await a.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: op, p_mode: "percent", p_amount: 10, p_expected: await reviewed(p) }))).rows[0]!.r).toMatchObject({
      result: "applied",
    });
    await asUser(b, admin.id);
    const pidB = await pidOf(b);
    const pB = settled(b.query(RPC_SQL, rpcParams({ p_project_id: q.id, p_operation_id: op, p_mode: "percent", p_amount: 10, p_expected: await reviewed(q) })));
    // its first trigger event waits for the organisation's chain lock, which the first holds
    await until("the second waits on the first", () => waitsOnLock(pidB));
    await a.query("commit");
    const r = await pB;
    expect(r.error?.message).toBe("This submission was already used for a different change — reload the page and review it again.");
    await b.query("rollback");
    expect((await snap(q)).prices).toEqual({ A1: "200000.00", A2: "300000.00", B1: "400000.00" });
  });
});

// ---------------------------------------------------------------------------
describe("5. the canonical trail is counted, not assumed", () => {
  it("with trg_price_history disabled the reprice is refused (rolled back)", async () => {
    const p = await newProject(BASIC);
    const expected = await reviewed(p);
    await o.query("begin");
    try {
      await o.query("alter table public.properties disable trigger properties_price_history");
      await o.query("set local role authenticated");
      await o.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin.id, role: "authenticated", aal: "aal2" })]);
      await expect(
        o.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: randomUUID(), p_mode: "percent", p_amount: 10, p_expected: expected })),
      ).rejects.toThrow(/^The price history was not written for every unit — nothing was changed\.$/);
    } finally {
      await o.query("rollback");
    }
    expect((await snap(p)).prices.A1).toBe("200000.00");
  });

  it("with one unit's price_changed line silently dropped (its history kept) the reprice is refused (rolled back)", async () => {
    const p = await newProject(BASIC);
    const expected = await reviewed(p);
    await o.query("begin");
    try {
      // returns NULL for ONE unit's line: the row is skipped without an error,
      // so only the function's own count can notice
      await o.query(
        `create function public.zz_pl_drop_line() returns trigger language plpgsql as $f$
         begin
           if new.event_type = 'price_changed' and new.entity_id = '${p.units.A1}'::uuid then return null; end if;
           return new;
         end $f$`,
      );
      await o.query("create trigger zz_pl_drop_line before insert on public.events for each row execute function public.zz_pl_drop_line()");
      await o.query("set local role authenticated");
      await o.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin.id, role: "authenticated", aal: "aal2" })]);
      await expect(
        o.query(RPC_SQL, rpcParams({ p_project_id: p.id, p_operation_id: randomUUID(), p_mode: "percent", p_amount: 10, p_expected: expected })),
      ).rejects.toThrow(/^The timeline was not written for every unit — nothing was changed\.$/);
    } finally {
      await o.query("rollback");
    }
    expect((await snap(p)).prices.A1).toBe("200000.00");
  });
});

// ---------------------------------------------------------------------------
describe("6. parity: the form's preview and the database, digit for digit", () => {
  /** A deterministic generator: the same cases on every run (no Math.random). */
  function* lcg(seed: number) {
    let s = seed >>> 0;
    for (;;) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      yield s / 2 ** 32;
    }
  }

  const BOUNDARY_PRICES: Array<number | string> = [
    50000, 150000, 250000, 250050, 1250000, 999.99, 1000, 100, 101, 149.99, 150, 1234.56, 40000, 49999.99, 3333.33, 777777.77,
  ];
  const SPECS: UpliftSpec[] = [
    { mode: "percent", amount: 0.1 },
    { mode: "percent", amount: 0.02 },
    { mode: "percent", amount: -0.1 },
    { mode: "percent", amount: 3 },
    { mode: "percent", amount: -3 },
    { mode: "percent", amount: 2.5 },
    { mode: "percent", amount: 7.77 },
    { mode: "percent", amount: 33.333 },
    { mode: "percent", amount: -99.99 },
    { mode: "percent", amount: -100 },
    { mode: "percent", amount: -150 },
    { mode: "percent", amount: 1000 },
    { mode: "fixed", amount: 10 },
    { mode: "fixed", amount: 49.99 },
    { mode: "fixed", amount: 50 },
    { mode: "fixed", amount: 50.01 },
    { mode: "fixed", amount: -50 },
    { mode: "fixed", amount: -25000 },
    { mode: "fixed", amount: -999999 },
    { mode: "fixed", amount: 123.45 },
  ];

  async function compare(p: Project, spec: UpliftSpec) {
    const targets: UpliftTarget[] = (
      await o.query<{ id: string; reference: string; block: string | null; price: string | null }>(
        "select id, reference, block, asking_price::text as price from properties where parent_id = $1 and kind = 'unit' order by id",
        [p.id],
      )
    ).rows.map((r) => ({ id: r.id, reference: r.reference, block: r.block, asking_price: r.price }));
    const preview = previewUplift(targets, spec);
    const res = await call(admin, {
      p_project_id: p.id,
      p_operation_id: randomUUID(),
      p_mode: spec.mode,
      p_amount: spec.amount,
      p_expected: targets.map((t) => ({ id: t.id, price: t.asking_price === null ? null : Number(t.asking_price) })),
    });
    if (preview.rows.length === 0) {
      expect(res.error?.message, JSON.stringify(spec)).toMatch(/rounds to nothing|has a price to change/);
      return;
    }
    expect(res.error, JSON.stringify(spec)).toBeNull();
    expect(res.data, JSON.stringify(spec)).toMatchObject({
      changed: preview.rows.length,
      unchanged: preview.unchanged,
      skipped: preview.skipped,
    });
    const want = new Map(targets.map((t) => [t.id, t.asking_price === null ? null : Number(t.asking_price)]));
    for (const row of preview.rows) want.set(row.id, row.to);
    const { rows } = await o.query<{ id: string; price: string | null }>(
      "select id, asking_price::text as price from properties where parent_id = $1 and kind = 'unit'",
      [p.id],
    );
    for (const r of rows) {
      expect(r.price === null ? null : Number(r.price), `${JSON.stringify(spec)} on ${r.id}`).toBe(want.get(r.id));
    }
  }

  it("every boundary price under every spec, applied in turn", { timeout: 120_000 }, async () => {
    const p = await newProject(BOUNDARY_PRICES.map((price, i) => ({ code: `X${i}`, block: null, price })));
    for (const spec of SPECS) await compare(p, spec);
  });

  it("300 generated prices (cents included) under 40 generated specs", { timeout: 300_000 }, async () => {
    const g = lcg(20261005);
    const next = () => g.next().value as number;
    const units: UnitSpec[] = Array.from({ length: 300 }, (_, i) => ({
      code: `R${i}`,
      block: null,
      price: (Math.floor(next() * 200_000_000) + 1) / 100, // €0.01 – €2.000.000,00, cents included
    }));
    const p = await newProject(units);
    for (let i = 0; i < 40; i++) {
      const percent = next() < 0.6;
      const raw = percent ? (next() - 0.4) * 40 : (next() - 0.4) * 60000;
      const decimals = Math.floor(next() * 4);
      const amount = Number(raw.toFixed(decimals)) || 1;
      await compare(p, { mode: percent ? "percent" : "fixed", amount });
    }
  });
});

// ---------------------------------------------------------------------------
describe("7. the migration (rolled back)", () => {
  async function rolledBack(body: (notices: string[]) => Promise<void>) {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
    o.on("notice", onNotice);
    await o.query("begin");
    await o.query("set local lock_timeout = '5s'");
    try {
      await body(notices);
    } finally {
      await o.query("rollback");
      o.off("notice", onNotice);
    }
  }
  const lastRow = (res: unknown) => {
    const results = (Array.isArray(res) ? res : [res]) as { rows: Record<string, unknown>[] }[];
    return results[results.length - 1]!.rows[0]!;
  };

  it("replays over the state before it: preflight, postflight, the diagnostic as its last row", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0141_SQL);
      expect((await o.query("select to_regprocedure($1) as f", [SIG])).rows[0].f).toBeNull();
      const row = lastRow(await o.query(readMigration0141()));
      expect(row).toMatchObject({ migration: "0141" });
      expect(Object.keys(row)).toEqual(["migration", "duplicate_price_lines", "empty_versions"]);
      expect(notices.some((m) => m.startsWith("0141: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0141: postflight passed"))).toBe(true);
    });
  });

  it("the diagnostic counts the old path's duplicates and empty versions — and repairs nothing", async () => {
    const p = await newProject(BASIC);
    await rolledBack(async () => {
      await o.query(REVERT_0141_SQL);
      const before = lastRow(await o.query(readMigration0141()));
      await o.query(REVERT_0141_SQL);
      await o.query(
        `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
         values ($1, null, 'property', $2, 'price_changed', '{"source":"bulk_uplift","from":1,"to":2}'::jsonb)`,
        [ORG, p.units.A1],
      );
      await o.query("insert into price_lists (org_id, project_id, version) values ($1, $2, 99)", [ORG, p.id]);
      const after = lastRow(await o.query(readMigration0141()));
      expect(Number(after.duplicate_price_lines)).toBe(Number(before.duplicate_price_lines) + 1);
      expect(Number(after.empty_versions)).toBe(Number(before.empty_versions) + 1);
      expect((await o.query("select count(*)::int as c from price_lists where project_id = $1", [p.id])).rows[0].c, "nothing repaired").toBe(1);
    });
  });

  it("the preflight refuses a second application, changing nothing", async () => {
    await rolledBack(async () => {
      await expect(o.query(readMigration0141())).rejects.toThrow(/0141 aborted: a function named record_price_list_version already exists — nothing was changed/);
    });
  });

  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "the container locked FOR SHARE",
      (s) => s.replace("p.kind in ('project', 'phase')\n     for no key update;", "p.kind in ('project', 'phase')\n     for share;"),
      /0141 postflight: the container and its units \(in id order\) are no longer locked FOR NO KEY UPDATE/,
    ],
    [
      "the container locked FOR UPDATE (blocks foreign-key checks: the sweeps' deadlock)",
      (s) => s.replace("p.kind in ('project', 'phase')\n     for no key update;", "p.kind in ('project', 'phase')\n     for update;"),
      /0141 postflight: the container and its units \(in id order\) are no longer locked FOR NO KEY UPDATE/,
    ],
    [
      "the units not locked",
      (s) => s.replace("    order by u.id\n      for no key update;", "    order by u.id;"),
      /0141 postflight: the container and its units \(in id order\) are no longer locked FOR NO KEY UPDATE/,
    ],
    [
      "the caller's re-read under the lock parked in a block comment",
      (s) => s.replace("  -- 3b. the caller, read AGAIN", "  /*").replace("  -- 4. has this submission already committed?", "  */\n  -- 4. has this submission"),
      /0141 postflight: the caller is no longer read before the lock AND again under it/,
    ],
    [
      "the caller's re-read under the lock deleted",
      (s) => {
        const from = s.indexOf("  -- 3b. the caller, read AGAIN");
        const to = s.indexOf("  -- 4. has this submission already committed?");
        return from > 0 && to > from ? s.slice(0, from) + s.slice(to) : s;
      },
      /0141 postflight: the caller is no longer read before the lock AND again under it/,
    ],
    [
      "an unchecked UPDATE",
      (s) => s.replace("    get diagnostics v_rows = row_count;\n    if v_rows <> v_changed then", "    v_rows := v_changed;\n    if v_rows <> v_changed then"),
      /0141 postflight: a write's row count is no longer checked/,
    ],
    [
      "a second per-unit line",
      (s) =>
        s.replace(
          "    -- the note a reprice records when none was typed",
          "    insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)\n    select v_org, v_uid, 'property', c.id, 'price_changed', '{}'::jsonb from jsonb_to_recordset(v_changes) as c(id uuid);\n    -- the note a reprice records when none was typed",
        ),
      /0141 postflight: record_price_list_version writes a per-unit line trg_price_history already writes/,
    ],
    [
      "a second per-unit line, written without the schema",
      (s) =>
        s.replace(
          "    -- the note a reprice records when none was typed",
          "    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)\n    select v_org, v_uid, 'property', c.id, 'price_changed', '{}'::jsonb from jsonb_to_recordset(v_changes) as c(id uuid);\n    -- the note a reprice records when none was typed",
        ),
      /0141 postflight: record_price_list_version writes a per-unit line trg_price_history already writes/,
    ],
    [
      "the price_changed lines no longer counted",
      (s) => s.replace("e.event_type = 'price_changed'\n       and e.occurred_at = now()", "e.event_type = 'price_changed'"),
      /0141 postflight: the per-unit trail \(history and price_changed line\) is no longer counted/,
    ],
    [
      "the note in the event",
      (s) => s.replace("            'version',      v_version,\n            'units',", "            'version',      v_version,\n            'notes',        v_notes,\n            'units',"),
      /0141 postflight: the price_list_created event carries the note/,
    ],
    [
      "executable by anon",
      (s) => s.replace("from public, anon, service_role;\ngrant  execute", "from public, service_role;\ngrant  execute on function public.record_price_list_version(uuid, uuid, text, text, numeric, text, jsonb) to anon;\ngrant  execute"),
      /0141 postflight: record_price_list_version grants are wrong/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`the postflight refuses the file with ${label}`, async () => {
      const bad = mutate(readMigration0141());
      expect(bad, "the mutation installed").not.toBe(readMigration0141());
      await rolledBack(async () => {
        await o.query(REVERT_0141_SQL);
        await expect(o.query(bad)).rejects.toThrow(refusal);
      });
    });
  }

  it("the file refuses before it changes anything", () => {
    const sql = readMigration0141().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0141 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0141 postflight")).toBeGreaterThan(firstChange);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0141();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0141 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("the rollback recipe leaves the pre-0141 path working: a session's direct version insert", async () => {
    const p = await newProject(BASIC);
    await rolledBack(async () => {
      await o.query(REVERT_0141_SQL);
      expect((await o.query("select to_regprocedure($1) as f", [SIG])).rows[0].f).toBeNull();
      const cols = await o.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'price_lists' and column_name like 'operation%'");
      expect(cols.rows).toEqual([]);
      await o.query("set local role authenticated");
      await o.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin.id, role: "authenticated", aal: "aal2" })]);
      const ins = await o.query("insert into price_lists (org_id, project_id, version) values ($1, $2, 1) returning version", [ORG, p.id]);
      expect(ins.rows[0].version).toBe(1);
    });
  });

  it("with 0141 applied, the deployed app's direct insert still works, and a half-written operation record is refused", async () => {
    const p = await newProject(BASIC);
    const direct = await admin.client.from("price_lists").insert({ org_id: ORG, project_id: p.id, version: 1 }).select("operation_id, operation").single();
    expect(direct.error).toBeNull();
    expect(direct.data).toEqual({ operation_id: null, operation: null });
    const half = await admin.client.from("price_lists").insert({ org_id: ORG, project_id: p.id, version: 2, operation_id: randomUUID() });
    expect(half.error?.code).toBe("23514");
  });
});

// ---------------------------------------------------------------------------
describe("8. the shape", () => {
  it("SECURITY INVOKER, owned by postgres, pg_temp last, authenticated only, commented", async () => {
    const { rows } = await o.query(
      `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
              has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('service_role', p.oid, 'execute') as svc,
              obj_description(p.oid, 'pg_proc') is not null as commented
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [SIG],
    );
    expect(rows[0]).toEqual({
      prosecdef: false,
      owner: "postgres",
      proconfig: ["search_path=public, pg_temp"],
      pub: false,
      anon: false,
      auth: true,
      svc: false,
      commented: true,
    });
  });

  it("the restore pack's two 0141 rows pass now, and read a body without its locks and a missing operation key", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const rowOf = (start: string) => {
      const from = pack.indexOf(start);
      expect(from, `the pack carries ${start}`).toBeGreaterThan(0);
      const to = pack.indexOf("\n  union all\n", from);
      return `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    };
    const rows = [
      rowOf("  select 'INTEGRITY: a price-list version and the reprice it records commit together"),
      rowOf("  select 'INTEGRITY: a price-list operation id is unique per organisation"),
    ];
    for (const row of rows) {
      const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
      expect(now.actual).toBe(now.expected);
    }
    const drifts: Array<[string, number]> = [
      [
        `create or replace function public.record_price_list_version(
           p_project_id uuid, p_operation_id uuid, p_notes text default null, p_mode text default null,
           p_amount numeric default null, p_block text default null, p_expected jsonb default null) returns jsonb
           language plpgsql security invoker set search_path = public, pg_temp as $f$ begin return '{}'::jsonb; end $f$`,
        0,
      ],
      ["drop index public.price_lists_org_operation_key", 1],
    ];
    for (const [drift, i] of drifts) {
      await o.query("begin");
      try {
        await o.query(drift);
        const r = (await o.query<{ expected: string; actual: string }>(rows[i]!)).rows[0]!;
        expect(r.actual, drift).not.toBe(r.expected);
      } finally {
        await o.query("rollback");
      }
    }
  });

  it("the chain verifies for both organisations after everything above", async () => {
    for (const org of [ORG, OTHER_ORG]) {
      const { rows } = await o.query("select ok, reason from verify_events_chain($1::uuid, null::bigint)", [org]);
      expect(rows[0]).toMatchObject({ ok: true });
    }
  });
});
