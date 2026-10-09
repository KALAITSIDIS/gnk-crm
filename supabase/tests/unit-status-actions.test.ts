import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ANON_KEY,
  SUPABASE_URL,
  TEST_PASSWORD,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * A unit's status change and its audit lines commit TOGETHER — through the
 * REAL action, against the REAL stack (T-unit-status-atomic, 0143).
 *
 * Nothing below `updateUnitStatus` is stubbed except the Next.js request
 * plumbing (as in unit-site-revalidate-actions.test.ts): every read and write
 * goes through PostgREST, RLS, the triggers and the events hash chain; the
 * site notifier is the real one, knocking on a local door. Failures are
 * INJECTED in the database (a trigger planted on one row of this file's
 * throwaway organisation, dropped straight after), so what a refused write
 * leaves behind is the database's own answer. A lost answer is a response
 * the database produced and committed that never reaches the action.
 *
 * WHAT IT PINS (each scenario prints one `[evidence]` line):
 *   1. a refused `status_changed` line keeps the status — nothing committed,
 *      no knock, the follow-up untouched — and the action SAYS nothing
 *      changed; the same press then applies once;
 *   2. a refused `status_regression_override` line does the same for an
 *      admin's move back to market;
 *   3. a follow-up that fails after the commit (the task update, or its
 *      `superseded` line) never reports the committed change as failed; the
 *      same press again finishes the follow-up without a second status line;
 *      a check raised while the change waited on the unit's lock closes with it;
 *   4. an answer lost after the commit is reported as UNKNOWN, never as
 *      refused or saved; the same press again answers "replayed" — one line;
 *   5. a competing change between the page's read and the write is refused —
 *      a listing manager cannot regress a unit an admin sold meanwhile, nor
 *      move one an admin reserved meanwhile; an operation id is never reused
 *      for another status; a unit already in the asked status writes nothing;
 *   6. a double submit writes one line;
 *   7. role, tenant and second-factor refusals write nothing;
 *   8. a plain change writes exactly one line carrying from, to, reference
 *      and the operation id; a regression writes its override line too;
 *   9–13. the migration replays over the state before it (rolled back), its
 *      postflight refuses a weakened body, its rollback recipe leaves the
 *      pre-0143 path working, and the function has the shape it claims;
 *  14–17. queued on the unit's lock: a twin is answered "replayed" by the
 *      lookup under the lock; a check raised during the wait closes with the
 *      change; a wait is bounded (55P03, nothing written); a
 *      demotion during the wait refuses; a line a session forged closes no
 *      check on a unit that never moved;
 *  18. the events chain verifies afterwards.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `unit-status-${RUN}`;
const KEY = `db-test-key-${RUN}`;

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});

import { updateUnitStatus } from "@/lib/actions/units";
import { resetSiteRevalidateLatch } from "@/lib/services/site-revalidate";
import { REVERT_0143_SQL, readMigration0143 } from "./revert-0143";

// ---------------------------------------------------------------------------
// The door: a local stand-in for the site's /api/revalidate.
// ---------------------------------------------------------------------------
type Knock = { body: unknown };
const door = { knocks: [] as Knock[], server: null as Server | null };

async function knocked(n: number): Promise<Knock[]> {
  const t0 = Date.now();
  while (door.knocks.length < n && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 80)); // and nothing more arrives after it
  return [...door.knocks];
}

// ---------------------------------------------------------------------------
// Sessions: a client per call. The status WRITE — the RPC, or the PATCH the
// action sent before 0143 — can be held (something else runs first) or have
// its answer lost after the database replied.
// ---------------------------------------------------------------------------
const steer = {
  dropNextWriteAnswer: false,
  beforeNextWrite: null as null | (() => Promise<void>),
};
const isStatusWrite = (url: string, init?: RequestInit) =>
  /\/rest\/v1\/rpc\/set_unit_status\b/.test(url) ||
  (/\/rest\/v1\/properties\?/.test(url) && (init?.method ?? "GET").toUpperCase() === "PATCH");

async function sessionClient(user: TestUser, session?: { access_token: string; refresh_token: string }): Promise<SupabaseClient> {
  const s = session ?? (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const write = isStatusWrite(url, init);
        if (write && steer.beforeNextWrite) {
          const run = steer.beforeNextWrite;
          steer.beforeNextWrite = null;
          await run();
        }
        const res = await fetch(input, init);
        if (write && steer.dropNextWriteAnswer) {
          steer.dropNextWriteAnswer = false;
          await res.text(); // the database has answered and committed; the answer never arrives
          throw new TypeError("fetch failed (test: the answer was lost after the database replied)");
        }
        return res;
      },
    },
  });
  const { error } = await c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  return c;
}

async function as<T>(user: TestUser, run: () => Promise<T>): Promise<T> {
  const client = await sessionClient(user);
  return ctx.als.run(client, run);
}

type Outcome = { result?: Awaited<ReturnType<typeof updateUnitStatus>>; thrown?: string };
/** The action's answer, or what it threw — a thrown action is an outcome too. */
async function press(user: TestUser, unitId: string, to: string, expected: string, operationId: string): Promise<Outcome> {
  try {
    return { result: await as(user, () => updateUnitStatus(unitId, to, expected, operationId)) };
  } catch (e) {
    return { thrown: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let manager: TestUser;
let agent: TestUser;
let outsider: TestUser;
const userIds: string[] = [];
let fixtureN = 0;

type Unit = { id: string; reference: string };

/** A project with one PUBLISHED unit (a listing of its own on the site) in `status`. */
async function newUnit(status = "available", visibility: "public" | "private" = "public"): Promise<Unit> {
  fixtureN += 1;
  const reference = `ZZUS${TAG}${fixtureN}`;
  const { rows } = await pg.query<{ id: string }>(
    `insert into properties (org_id, reference, kind, property_type, status, title)
     values ($1, $2, 'project', 'apartment', 'available', jsonb_build_object('en', 'ZZTEST unit status ' || $2)) returning id`,
    [ORG, reference],
  );
  const ref = `${reference}-A1`;
  const { rows: u } = await pg.query<{ id: string }>(
    `insert into properties (org_id, reference, kind, parent_id, property_type, status, visibility, block, unit_number,
                             asking_price, bedrooms, covered_area_sqm, title)
     values ($1, $2, 'unit', $3, 'apartment', $4::property_status, $5::visibility_level, 'A', '1', 200000, 2, 80,
             jsonb_build_object('en', 'ZZTEST unit ' || $2)) returning id`,
    [ORG, ref, rows[0]!.id, status, visibility],
  );
  return { id: u[0]!.id, reference: ref };
}

/** An open `listing_status_check` on the unit — what a won deal leaves behind. */
async function openCheck(unit: Unit, assignee: TestUser, createdAt?: string): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `insert into tasks (org_id, title, due_at, assignee_id, property_id, created_by, kind, created_at)
     values ($1, 'ZZTEST set the listing status', now(), $2, $3, $2, 'listing_status_check', coalesce($4::timestamptz, now()))
     returning id`,
    [ORG, assignee.id, unit.id, createdAt ?? null],
  );
  return rows[0]!.id;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pg.query<{ n: string }>(sql, params);
  return Number(rows[0]!.n);
}
const lines = (u: Unit, type: string) =>
  count(`select count(*)::text as n from events where org_id = $1 and entity_id = $2 and event_type = $3`, [ORG, u.id, type]);
const statusOf = async (u: Unit) =>
  (await pg.query<{ s: string }>(`select status::text as s from properties where id = $1`, [u.id])).rows[0]!.s;
const taskDone = async (id: string) =>
  (await pg.query<{ d: boolean }>(`select is_done as d from tasks where id = $1`, [id])).rows[0]!.d;
const supersededLines = (taskId: string) =>
  count(`select count(*)::text as n from events where org_id = $1 and entity_id = $2 and event_type = 'superseded'`, [ORG, taskId]);

async function stateOf(u: Unit, taskId?: string) {
  return {
    status: await statusOf(u),
    status_changed: await lines(u, "status_changed"),
    regression: await lines(u, "status_regression_override"),
    ...(taskId ? { task_done: await taskDone(taskId), superseded: await supersededLines(taskId) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Failure injection: one write, one row, this organisation only.
// ---------------------------------------------------------------------------
const PLANT = `zz_us_fail_${RUN}`;
async function inject(table: string, timing: "before update" | "before insert", predicate: string) {
  fixtureN += 1;
  const fn = `${PLANT}_${fixtureN}`;
  await pg.query(
    `create function public.${fn}() returns trigger language plpgsql as $f$
     begin
       if ${predicate} then
         raise exception 'injected failure: % on %', tg_op, tg_table_name;
       end if;
       return new;
     end $f$`,
  );
  await pg.query(`revoke all on function public.${fn}() from public, anon, authenticated, service_role`);
  await pg.query(`create trigger ${fn} ${timing} on public.${table} for each row execute function public.${fn}()`);
  return async () => {
    await pg.query(`drop trigger if exists ${fn} on public.${table}`);
    await pg.query(`drop function if exists public.${fn}()`);
  };
}
const uuidOk = (s: string) => {
  if (!/^[0-9a-f-]{36}$/.test(s)) throw new Error("bad uuid");
  return s;
};
const failLine = (entityId: string, type: string) =>
  inject("events", "before insert", `new.entity_id = '${uuidOk(entityId)}'::uuid and new.event_type = '${type.replace(/[^a-z_]/g, "")}'`);
const failTaskUpdate = (taskId: string) => inject("tasks", "before update", `new.id = '${uuidOk(taskId)}'::uuid`);

function evidence(label: string, data: Record<string, unknown>) {
  console.log(`[evidence] ${label}\n${Object.entries(data).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n")}`);
}

beforeAll(async () => {
  door.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      door.knocks.push({ body: JSON.parse(raw || "null") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => door.server!.listen(0, "127.0.0.1", () => r()));
  process.env.SITE_REVALIDATE_URL = `http://127.0.0.1:${(door.server.address() as AddressInfo).port}/api/revalidate`;
  process.env.SITE_REVALIDATE_KEY = KEY;
  resetSiteRevalidateLatch();

  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  // a plant left by an interrupted run of this file
  for (const table of ["events", "tasks", "properties"]) {
    const { rows: stale } = await pg.query<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid = ('public.' || $1)::regclass and tgname like 'zz_us_fail_%'`,
      [table],
    );
    for (const t of stale) {
      await pg.query(`drop trigger if exists ${t.tgname} on public.${table}`);
      await pg.query(`drop function if exists public.${t.tgname}()`);
    }
  }
  await ensureTestOrg(svc, ORG, `Unit status ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER_ORG, `Unit status other ${RUN}`, `${SLUG}-other`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `us-admin-${RUN}@test.local`, "admin", ORG);
  manager = await createTestUser(svc, `us-lm-${RUN}@test.local`, "listing_manager", ORG);
  agent = await createTestUser(svc, `us-agent-${RUN}@test.local`, "agent", ORG);
  outsider = await createTestUser(svc, `us-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(admin.id, manager.id, agent.id, outsider.id);
});

afterEach(() => {
  door.knocks = [];
  steer.dropNextWriteAnswer = false;
  steer.beforeNextWrite = null;
});

afterAll(async () => {
  delete process.env.SITE_REVALIDATE_URL;
  delete process.env.SITE_REVALIDATE_KEY;
  await new Promise<void>((r) => (door.server ? door.server.close(() => r()) : r()));
  for (const org of [ORG, OTHER_ORG]) {
    await pg.query("delete from tasks where org_id = $1", [org]);
    await pg.query("delete from price_history where org_id = $1", [org]);
    // children before parents: properties.parent_id is ON DELETE RESTRICT
    await pg.query("delete from properties where org_id = $1 and kind = 'unit'", [org]);
    await pg.query("delete from properties where org_id = $1", [org]);
  }
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const org of [ORG, OTHER_ORG]) {
    await pg.query("delete from profiles where org_id = $1", [org]);
    await pg.query("delete from events where org_id = $1", [org]);
    await pg.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await pg.query("delete from chain_checks where org_id = $1", [org]);
    await pg.query("delete from deal_stages where org_id = $1", [org]);
    await pg.query("delete from districts where org_id = $1", [org]);
    await pg.query("delete from organizations where id = $1", [org]);
  }
  await pg.end();
});

// ---------------------------------------------------------------------------
describe("the required lines: refused → nothing committed", () => {
  it("1. a refused status_changed line keeps the status, the task and the site as they were; the same press then applies once", async () => {
    const unit = await newUnit("available");
    const task = await openCheck(unit, admin);
    const op = randomUUID();

    const undo = await failLine(unit.id, "status_changed");
    let first: Outcome;
    try {
      first = await press(admin, unit.id, "sold", "available", op);
    } finally {
      await undo();
    }
    const kFirst = await knocked(0);
    const afterFirst = await stateOf(unit, task);

    const retry = await press(admin, unit.id, "sold", "available", op);
    const kRetry = await knocked(1);
    const afterRetry = await stateOf(unit, task);

    evidence("1. status_changed refused, then the same press", { first, kFirst: kFirst.length, afterFirst, retry, kRetry: kRetry.length, afterRetry });
    expect(first.thrown, "the action answers; it does not throw").toBeUndefined();
    expect(first.result?.error, "a definite refusal").toBeTruthy();
    expect(first.result?.unconfirmed ?? false).toBe(false);
    expect(afterFirst, "nothing committed").toEqual({ status: "available", status_changed: 0, regression: 0, task_done: false, superseded: 0 });
    expect(kFirst, "an unchanged unit is not announced").toEqual([]);
    expect(retry.result).toMatchObject({ error: null });
    expect(afterRetry).toEqual({ status: "sold", status_changed: 1, regression: 0, task_done: true, superseded: 1 });
    expect(kRetry.map((k) => k.body)).toEqual([{ reference: unit.reference }]);
  });

  it("2. a refused status_regression_override line keeps an admin's move back to market from committing", async () => {
    const unit = await newUnit("sold");
    const op = randomUUID();
    const undo = await failLine(unit.id, "status_regression_override");
    let first: Outcome;
    try {
      first = await press(admin, unit.id, "available", "sold", op);
    } finally {
      await undo();
    }
    const afterFirst = await stateOf(unit);
    const retry = await press(admin, unit.id, "available", "sold", op);
    const afterRetry = await stateOf(unit);

    evidence("2. status_regression_override refused, then the same press", { first, afterFirst, retry, afterRetry });
    expect(first.thrown).toBeUndefined();
    expect(first.result?.error).toBeTruthy();
    expect(first.result?.unconfirmed ?? false).toBe(false);
    expect(afterFirst, "nothing committed").toEqual({ status: "sold", status_changed: 0, regression: 0 });
    expect(retry.result).toMatchObject({ error: null });
    expect(afterRetry).toEqual({ status: "available", status_changed: 1, regression: 1 });
  });
});

// ---------------------------------------------------------------------------
describe("the follow-up after the commit: visible, finishable, never a rollback", () => {
  it("3a. the task update fails: the change is reported saved with a notice; the same press closes the task — no second status line", async () => {
    const unit = await newUnit("available");
    const task = await openCheck(unit, admin);
    const op = randomUUID();
    const undo = await failTaskUpdate(task);
    let first: Outcome;
    try {
      first = await press(admin, unit.id, "sold", "available", op);
    } finally {
      await undo();
    }
    const kFirst = await knocked(1);
    const afterFirst = await stateOf(unit, task);

    const retry = await press(admin, unit.id, "sold", "available", op);
    const afterRetry = await stateOf(unit, task);

    evidence("3a. task update refused after the commit, then the same press", { first, kFirst: kFirst.length, afterFirst, retry, afterRetry });
    expect(first.thrown).toBeUndefined();
    expect(first.result?.error, "the committed change is not reported as failed").toBeNull();
    expect(first.result?.notice, "…and the unfinished follow-up is said").toBeTruthy();
    expect(afterFirst).toEqual({ status: "sold", status_changed: 1, regression: 0, task_done: false, superseded: 0 });
    expect(kFirst.map((k) => k.body), "the site is told").toEqual([{ reference: unit.reference }]);
    expect(retry.result).toMatchObject({ error: null, replayed: true });
    expect(retry.result?.notice ?? null).toBeNull();
    expect(afterRetry, "the follow-up finished; nothing recorded twice").toEqual({
      status: "sold",
      status_changed: 1,
      regression: 0,
      task_done: true,
      superseded: 1,
    });
  });

  it("3b. the task's superseded line fails: still reported saved, with a notice", async () => {
    const unit = await newUnit("available");
    const task = await openCheck(unit, admin);
    const undo = await failLine(task, "superseded");
    let first: Outcome;
    try {
      first = await press(admin, unit.id, "sold", "available", randomUUID());
    } finally {
      await undo();
    }
    const afterFirst = await stateOf(unit, task);
    evidence("3b. superseded line refused after the commit", { first, afterFirst });
    expect(first.thrown).toBeUndefined();
    expect(first.result?.error).toBeNull();
    expect(first.result?.notice).toBeTruthy();
    expect(afterFirst.status).toBe("sold");
    expect(afterFirst.status_changed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("a lost answer, a competing change, a double submit", () => {
  it("4. an answer lost after the commit is UNKNOWN; the same press answers replayed — one line, one knock", async () => {
    const unit = await newUnit("available");
    const op = randomUUID();
    steer.dropNextWriteAnswer = true;
    const lost = await press(admin, unit.id, "reserved", "available", op);
    const kLost = await knocked(0);
    const afterLost = await stateOf(unit);
    const retry = await press(admin, unit.id, "reserved", "available", op);
    const kRetry = await knocked(1);
    const afterRetry = await stateOf(unit);

    evidence("4. lost answer, then the same press", { lost, kLost: kLost.length, afterLost, retry, kRetry: kRetry.length, afterRetry });
    expect(lost.thrown).toBeUndefined();
    expect(lost.result).toMatchObject({ unconfirmed: true });
    expect(lost.result?.error, "never a definite answer").toBeTruthy();
    expect(kLost, "an unknown outcome is not announced").toEqual([]);
    expect(afterLost, "the lost answer DID commit, with its line").toEqual({ status: "reserved", status_changed: 1, regression: 0 });
    expect(retry.result).toMatchObject({ error: null, replayed: true });
    expect(afterRetry, "nothing written twice").toEqual(afterLost);
    expect(kRetry.map((k) => k.body)).toEqual([{ reference: unit.reference }]);
  });

  it("5. an admin sells the unit between a listing manager's read and write: the manager's change is refused, the sale stands", async () => {
    const unit = await newUnit("available");
    let sale: Outcome | null = null;
    steer.beforeNextWrite = async () => {
      sale = await press(admin, unit.id, "sold", "available", randomUUID());
    };
    const late = await press(manager, unit.id, "reserved", "available", randomUUID());
    const after = await stateOf(unit);
    const { rows } = await pg.query<{ payload: unknown; actor_id: string }>(
      `select payload, actor_id from events where org_id = $1 and entity_id = $2 and event_type = 'status_changed' order by id`,
      [ORG, unit.id],
    );

    evidence("5. a sale lands between the manager's read and write", { sale, late, after, lines: rows });
    expect(sale!.result).toMatchObject({ error: null });
    expect(late.result?.error, "refused — the unit is not what the page showed").toBeTruthy();
    expect(late.result?.unconfirmed ?? false).toBe(false);
    expect(after, "the sale stands; a manager never moves a sold unit back").toEqual({ status: "sold", status_changed: 1, regression: 0 });
    expect(rows.map((r) => r.actor_id)).toEqual([admin.id]);
  });

  it("5b. an admin reserves the unit meanwhile — no regression involved: only the expected status refuses the manager's move", async () => {
    const unit = await newUnit("available");
    steer.beforeNextWrite = async () => {
      await press(admin, unit.id, "reserved", "available", randomUUID());
    };
    const late = await press(manager, unit.id, "under_offer", "available", randomUUID());
    const after = await stateOf(unit);
    evidence("5b. a reservation lands between the manager's read and write", { late, after });
    expect(late.result?.error).toMatch(/^This unit is now reserved — it changed after this page was loaded/);
    expect(after).toEqual({ status: "reserved", status_changed: 1, regression: 0 });
  });

  it("5c. an operation id is never reused for another status; a unit already in the asked status writes nothing", async () => {
    const unit = await newUnit("available");
    const op = randomUUID();
    const first = await press(admin, unit.id, "sold", "available", op);
    const reused = await press(admin, unit.id, "reserved", "sold", op);
    const already = await press(admin, unit.id, "sold", "available", randomUUID());
    const k = await knocked(2);
    const after = await stateOf(unit);
    evidence("5c. a reused id, a unit already sold", { first, reused, already, knocks: k.length, after });
    expect(first.result).toMatchObject({ error: null });
    expect(reused.result?.error).toMatch(/already used for a different status/);
    expect(already.result).toMatchObject({ error: null, unchanged: true });
    expect(after, "one line: the sale").toEqual({ status: "sold", status_changed: 1, regression: 0 });
    expect(k.map((x) => x.body), "the sale and the unchanged answer knock; the refusal does not").toEqual([
      { reference: unit.reference },
      { reference: unit.reference },
    ]);
  });

  it("6. a double submit — the same press twice, the second arriving while the first is in flight — writes one line", async () => {
    const unit = await newUnit("available");
    const op = randomUUID();
    let twin: Outcome | null = null;
    steer.beforeNextWrite = async () => {
      twin = await press(admin, unit.id, "sold", "available", op);
    };
    const first = await press(admin, unit.id, "sold", "available", op);
    const after = await stateOf(unit);
    evidence("6. double submit", { twin, first, after });
    expect(twin!.result).toMatchObject({ error: null });
    expect(first.result, "answered from the twin's line, not as a new change").toMatchObject({ error: null, replayed: true });
    expect(after).toEqual({ status: "sold", status_changed: 1, regression: 0 });
  });
});

// ---------------------------------------------------------------------------
describe("who may: role, tenant, second factor", () => {
  it("7. an agent, an admin of another organisation, a manager regressing, an aal1 session — nothing written", async () => {
    const unit = await newUnit("available");
    const sold = await newUnit("sold");
    const byAgent = await press(agent, unit.id, "sold", "available", randomUUID());
    const byOutsider = await press(outsider, unit.id, "sold", "available", randomUUID());
    const byManager = await press(manager, sold.id, "available", "sold", randomUUID());

    // the admin again, signed in with the password only: aal1 over a verified factor
    const aal1 = anonClient();
    const { data: signIn, error: signInErr } = await aal1.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD });
    if (signInErr || !signIn.session) throw new Error(`aal1 sign-in: ${signInErr?.message}`);
    let byAal1: Outcome;
    try {
      const c = await sessionClient(admin, signIn.session);
      byAal1 = { result: await ctx.als.run(c, () => updateUnitStatus(unit.id, "sold", "available", randomUUID())) };
    } catch (e) {
      byAal1 = { thrown: e instanceof Error ? e.message : String(e) };
    }

    const afterUnit = await stateOf(unit);
    const afterSold = await stateOf(sold);
    const k = await knocked(0);
    evidence("7. refusals", { byAgent, byOutsider, byManager, byAal1, afterUnit, afterSold, knocks: k.length });
    for (const o of [byAgent, byOutsider, byManager]) {
      expect(o.thrown).toBeUndefined();
      expect(o.result?.error).toBeTruthy();
      expect(o.result?.unconfirmed ?? false).toBe(false);
    }
    expect(byAal1!.result?.error ?? byAal1!.thrown).toBeTruthy();
    expect(byManager.result?.error).toMatch(/Only an admin/);
    expect(afterUnit).toEqual({ status: "available", status_changed: 0, regression: 0 });
    expect(afterSold).toEqual({ status: "sold", status_changed: 0, regression: 0 });
    expect(k).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("what a change writes", () => {
  it("8. one line per change — from, to, reference, the operation id, the actor; a regression adds its override line", async () => {
    const unit = await newUnit("available", "private");
    const op1 = randomUUID();
    const op2 = randomUUID();
    const op3 = randomUUID();
    const r1 = await press(manager, unit.id, "reserved", "available", op1);
    const r2 = await press(manager, unit.id, "sold", "reserved", op2);
    const r3 = await press(admin, unit.id, "available", "sold", op3);
    const { rows } = await pg.query<{ event_type: string; actor_id: string; payload: Record<string, unknown> }>(
      `select event_type, actor_id, payload from events where org_id = $1 and entity_id = $2 order by id`,
      [ORG, unit.id],
    );
    const k = await knocked(0);
    evidence("8. three changes", { r1, r2, r3, lines: rows, knocks: k.length });
    for (const r of [r1, r2, r3]) expect(r.result).toMatchObject({ error: null });
    expect(rows).toEqual([
      { event_type: "status_changed", actor_id: manager.id, payload: { reference: unit.reference, from: "available", to: "reserved", operation_id: op1 } },
      { event_type: "status_changed", actor_id: manager.id, payload: { reference: unit.reference, from: "reserved", to: "sold", operation_id: op2 } },
      { event_type: "status_changed", actor_id: admin.id, payload: { reference: unit.reference, from: "sold", to: "available", operation_id: op3 } },
      { event_type: "status_regression_override", actor_id: admin.id, payload: { from: "sold", to: "available" } },
    ]);
    expect(k, "a private unit is never announced").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("the migration (rolled back) and the function's shape", () => {
  const SIG = "public.set_unit_status(uuid,text,text,uuid)";
  async function rolledBack(body: (notices: string[]) => Promise<void>) {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
    pg.on("notice", onNotice);
    await pg.query("begin");
    await pg.query("set local lock_timeout = '5s'");
    try {
      await body(notices);
    } finally {
      await pg.query("rollback");
      pg.off("notice", onNotice);
    }
  }
  const lastRow = (res: unknown) => {
    const results = (Array.isArray(res) ? res : [res]) as { rows: Record<string, unknown>[] }[];
    return results[results.length - 1]!.rows[0]!;
  };

  it("9. replays over the state before it — preflight, postflight, the read-only diagnostic last — and refuses a second application", async () => {
    await rolledBack(async (notices) => {
      await pg.query(REVERT_0143_SQL);
      expect((await pg.query("select to_regprocedure($1) as f", [SIG])).rows[0].f).toBeNull();
      const row = lastRow(await pg.query(readMigration0143()));
      expect(Object.keys(row)).toEqual(["migration", "units_status_unrecorded"]);
      expect(row.migration).toBe("0143");
      expect(notices.some((m) => m.startsWith("0143: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0143: postflight passed"))).toBe(true);
    });
    await rolledBack(async () => {
      await expect(pg.query(readMigration0143())).rejects.toThrow(/0143 aborted: a function named set_unit_status already exists — nothing was changed/);
    });
  });

  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "the operation id answered only under the lock (a check of a committed change would queue and time out)",
      (s) => {
        const from = s.indexOf("  -- 2. has this submission already committed?");
        const to = s.indexOf("  if not found then\n    -- 3. the unit, as the caller sees it");
        return from > 0 && to > from ? s.slice(0, from) + s.slice(to) : s;
      },
      /0143 postflight: the operation id is no longer answered before the lock and again under it/,
    ],
    [
      "the expected status no longer checked against the locked row",
      (s) => s.replace("      if v_unit.status <> v_expected then\n", "      if false then\n"),
      /0143 postflight: the expected status or the admin-only regression is no longer checked/,
    ],
    [
      "the unit read without a lock",
      (s) => s.replace("       and p.kind = 'unit'\n       for no key update;", "       and p.kind = 'unit';"),
      /0143 postflight: the unit is no longer locked FOR NO KEY UPDATE/,
    ],
    [
      "a line's row count unchecked",
      (s) => s.replace("        get diagnostics v_rows = row_count;\n        if v_rows <> 1 then\n          raise exception 'The timeline was not written — nothing was changed.';\n        end if;\n      end if;", "      end if;"),
      /0143 postflight: the status write's or a line's row count is no longer checked/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`10. the postflight refuses the file with ${label}`, async () => {
      const bad = mutate(readMigration0143());
      expect(bad, "the mutation installed").not.toBe(readMigration0143());
      await rolledBack(async () => {
        await pg.query(REVERT_0143_SQL);
        await expect(pg.query(bad)).rejects.toThrow(refusal);
      });
    });
  }

  it("11. the file refuses before it changes anything", () => {
    const sql = readMigration0143().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0143 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0143 postflight")).toBeGreaterThan(firstChange);
  });

  it("12. the rollback recipe removes exactly the function; a session's direct status edit still works as before 0143", async () => {
    const unit = await newUnit("available");
    await rolledBack(async () => {
      await pg.query(REVERT_0143_SQL);
      expect((await pg.query("select to_regprocedure($1) as f", [SIG])).rows[0].f).toBeNull();
      await pg.query("set local role authenticated");
      await pg.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin.id, role: "authenticated", aal: "aal2" })]);
      const upd = await pg.query("update properties set status = 'reserved' where id = $1", [unit.id]);
      expect(upd.rowCount).toBe(1);
    });
    expect(await statusOf(unit), "rolled back").toBe("available");
  });

  it("13. the shape: SECURITY INVOKER, owned by postgres, pg_temp last, a 3 s lock wait, authenticated only, commented", async () => {
    const { rows } = await pg.query(
      `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
              has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('service_role', p.oid, 'execute') as svc, has_function_privilege('authenticated', p.oid, 'execute') as auth,
              obj_description(p.oid, 'pg_proc') is not null as commented
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [SIG],
    );
    expect(rows[0]).toEqual({
      prosecdef: false,
      owner: "postgres",
      proconfig: ["search_path=public, pg_temp", "lock_timeout=3s"],
      pub: false,
      anon: false,
      svc: false,
      auth: true,
      commented: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Sessions as PostgREST opens them, for what one request cannot show: a call
// queued on the unit's lock.
// ---------------------------------------------------------------------------
async function sessionTx(user: TestUser): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("begin");
  await c.query("select set_config('role', 'authenticated', true)");
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: user.id, role: "authenticated", aal: "aal2" }),
  ]);
  return c;
}

/** Wait until some backend is waiting on a lock `holderPid` holds. */
async function queuedBehind(holderPid: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < 2000) {
    const { rows } = await pg.query<{ n: string }>(
      "select count(*)::text as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
      [holderPid],
    );
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("nothing queued behind the holder");
}

const pidOf = async (c: Client) => (await c.query<{ p: number }>("select pg_backend_pid() as p")).rows[0]!.p;

describe("queued on the unit's lock", () => {
  it("14. a twin queued behind its original is answered by the lookup UNDER the lock: replayed, one line", async () => {
    const unit = await newUnit("available");
    const op = randomUUID();
    const a = await sessionTx(admin);
    const b = await sessionTx(admin);
    try {
      const first = (await a.query("select public.set_unit_status($1, 'sold', 'available', $2) as r", [unit.id, op])).rows[0].r;
      const twin = b.query("select public.set_unit_status($1, 'sold', 'available', $2) as r", [unit.id, op]);
      await queuedBehind(await pidOf(a));
      await a.query("commit");
      const second = (await twin).rows[0].r;
      await b.query("commit");
      evidence("14. a queued twin", { first: first.result, second: second.result, after: await stateOf(unit) });
      expect(first.result).toBe("applied");
      expect(second).toMatchObject({ result: "replayed", operation_id: op, from: "available", to: "sold", status: "sold" });
      expect(await stateOf(unit)).toEqual({ status: "sold", status_changed: 1, regression: 0 });
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("14b. a check a won deal raises while the sale waits on the unit's lock closes with the sale (review: no time bound)", async () => {
    const unit = await newUnit("available");
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      // as a reprice or a stamp holds it (0141 / 0142): NO KEY, so the check's
      // foreign-key KEY SHARE onto the unit is not blocked — the sale is
      await holder.query("select 1 from properties where id = $1 for no key update", [unit.id]);
      const sale = press(admin, unit.id, "sold", "available", randomUUID());
      await queuedBehind(await pidOf(holder));
      // the deal is won NOW — after the sale's transaction began, before it commits
      const task = await openCheck(unit, admin);
      await holder.query("rollback");
      const r = await sale;
      const after = await stateOf(unit, task);
      evidence("14b. a check raised during the lock wait", { r, after });
      expect(r.result).toMatchObject({ error: null });
      expect(r.result?.notice ?? null).toBeNull();
      expect(after).toEqual({ status: "sold", status_changed: 1, regression: 0, task_done: true, superseded: 1 });
    } finally {
      await holder.end();
    }
  });

  it("15. a unit held longer than the function waits: 55P03 within its 3 s — nothing written", async () => {
    const unit = await newUnit("available");
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    const b = await sessionTx(manager);
    try {
      await holder.query("begin");
      await holder.query("select 1 from properties where id = $1 for update", [unit.id]);
      const t0 = Date.now();
      const err = await b
        .query("select public.set_unit_status($1, 'reserved', 'available', $2) as r", [unit.id, randomUUID()])
        .then(() => null, (e: { code?: string }) => e);
      const waited = Date.now() - t0;
      await b.query("rollback");
      await holder.query("rollback");
      evidence("15. a bounded wait", { code: err?.code, waited, after: await stateOf(unit) });
      expect(err?.code).toBe("55P03");
      expect(waited).toBeGreaterThanOrEqual(2500);
      expect(waited).toBeLessThan(6000);
      expect(await stateOf(unit)).toEqual({ status: "available", status_changed: 0, regression: 0 });
    } finally {
      await b.end();
      await holder.end();
    }
  });

  it("16. a manager demoted while queued is refused by the caller re-read under the lock", async () => {
    const unit = await newUnit("available");
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    const b = await sessionTx(manager);
    try {
      await holder.query("begin");
      await holder.query("select 1 from properties where id = $1 for update", [unit.id]);
      const queued = b
        .query("select public.set_unit_status($1, 'reserved', 'available', $2) as r", [unit.id, randomUUID()])
        .then(() => null, (e: { code?: string; message?: string }) => e);
      await queuedBehind(await pidOf(holder));
      await pg.query("update profiles set role = 'agent' where id = $1", [manager.id]);
      await holder.query("commit");
      const err = await queued;
      await b.query("rollback");
      evidence("16. demoted while queued", { code: err?.code, message: err?.message, after: await stateOf(unit) });
      expect(err).toMatchObject({ code: "P0001", message: "Only admins and listing managers manage units." });
      expect(await stateOf(unit)).toEqual({ status: "available", status_changed: 0, regression: 0 });
    } finally {
      await pg.query("update profiles set role = 'listing_manager' where id = $1", [manager.id]);
      await b.end();
      await holder.end();
    }
  });

  it("17. a line a session wrote itself is answered as a replay — and closes no check on a unit that never moved", async () => {
    const unit = await newUnit("available");
    const task = await openCheck(unit, admin);
    const op = randomUUID();
    // status_changed is not reserved: a manager may write one through PostgREST
    const forger = await sessionClient(manager);
    const { error } = await forger.from("events").insert({
      org_id: ORG,
      actor_id: manager.id,
      entity_type: "property",
      entity_id: unit.id,
      event_type: "status_changed",
      payload: { reference: unit.reference, from: "available", to: "sold", operation_id: op },
    });
    expect(error).toBeNull();
    const r = await press(manager, unit.id, "sold", "available", op);
    const after = await stateOf(unit, task);
    evidence("17. a forged line", { r, after });
    expect(r.result).toMatchObject({ error: null, replayed: true });
    expect(after, "the unit never moved, and the check stays open").toEqual({
      status: "available",
      status_changed: 1,
      regression: 0,
      task_done: false,
      superseded: 0,
    });
  });
});

// ---------------------------------------------------------------------------
describe("the chain", () => {
  it("18. verifies for both organisations after everything above — injected failures included", async () => {
    for (const org of [ORG, OTHER_ORG]) {
      const { rows } = await pg.query("select ok, reason from verify_events_chain($1::uuid, null::bigint)", [org]);
      expect(rows[0]).toMatchObject({ ok: true });
    }
  });
});
