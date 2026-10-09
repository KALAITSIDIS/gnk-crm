import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
 * Applying a unit type through the REAL server action, against the REAL stack
 * (T-unit-type-apply-atomic).
 *
 * Nothing below the action is stubbed except the Next.js request plumbing, as
 * in price-uplift-actions.test.ts: `createClient` hands the action a
 * supabase-js client signed in (aal2 unless the test says otherwise) as a
 * fixture user, so every read and write goes through PostgREST, RLS, the
 * triggers (trg_price_history, the events hash chain) as in production.
 *
 * WHAT IT PINS (each scenario prints one `[evidence]` line of what the
 * database holds afterwards):
 *   1. a successful stamp changes exactly the units in scope — beds, baths,
 *      area, veranda, and the price only when the type has a rate — with one
 *      price_history row and ONE price_changed event per actual price change
 *      and one unit-type `updated` line per stamped unit; other blocks,
 *      projects, phases and organisations are untouched;
 *   2. a failure on a later unit, on the unit-type audit line or on the
 *      trigger's own trail leaves NOTHING (no unit, history or event), and a
 *      row the database silently skips is refused rather than reported as
 *      applied; the same submission then succeeds once;
 *   3. a type without a rate never writes back a price read earlier: a
 *      concurrent price edit survives; concurrent stamps never mix;
 *   4. a repeated, concurrent or lost-response retry applies once; a reused id
 *      with other inputs or from another user is refused;
 *   5. who may: admin and listing manager; an agent, an aal1 session, a
 *      deactivated account, another organisation and a type from another
 *      project change nothing.
 *
 * FAILURE INJECTION IS REAL: BEFORE triggers that refuse (or silently skip)
 * ONE write for ONE row of this file's throwaway organisation, removed in
 * `finally` (stale copies are dropped in beforeAll by the `zz_ut_fail_`
 * prefix). `trg_events_hash` and `trg_price_history` are never touched.
 *
 * A THROWAWAY ORGANISATION (plus a second one as the isolation control),
 * deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const RPC = "apply_unit_type";

// ---------------------------------------------------------------------------
// Which session an action gets: the one the test bound to this async context.
// ---------------------------------------------------------------------------
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

import { revalidatePath } from "next/cache";
import { applyUnitType, type UnitActionState } from "@/lib/actions/units";
import { priceFromType } from "@/lib/services/unit-type";

// ---------------------------------------------------------------------------
// The gate: holds a client's first stamp write; can drop the answer of the RPC.
// ---------------------------------------------------------------------------
type Held = { release: () => void; done: Promise<void> };

const gate = {
  holding: new Set<string>(),
  held: new Map<string, Held>(),
  /** names whose next RPC answer is thrown away AFTER the database answered */
  dropping: new Set<string>(),
  hold(...names: string[]) {
    for (const n of names) this.holding.add(n);
  },
  arrived(name: string) {
    return this.held.has(name);
  },
  release(name: string) {
    const h = this.held.get(name);
    if (!h) throw new Error(`gate: nothing held for ${name}`);
    h.release();
    return h.done;
  },
  reset() {
    for (const h of this.held.values()) h.release();
    this.holding.clear();
    this.held.clear();
    this.dropping.clear();
  },
};

const isRpc = (url: string, method: string) =>
  method === "POST" && new RegExp(`/rest/v1/rpc/${RPC}(\\?|$)`).test(url);

/** The first write of either generation of the action: the RPC, or (before it) a unit PATCH. */
function isStampWrite(url: string, method: string): boolean {
  return isRpc(url, method) || (method === "PATCH" && /\/rest\/v1\/properties(\?|$)/.test(url));
}

function gatedFetch(name: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (isStampWrite(url, method) && gate.holding.has(name)) {
      gate.holding.delete(name);
      let release!: () => void;
      let finish!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const done = new Promise<void>((r) => (finish = r));
      gate.held.set(name, { release, done });
      await released;
      try {
        return await passOrDrop(name, url, method, input, init);
      } finally {
        finish();
      }
    }
    return passOrDrop(name, url, method, input, init);
  };
}

async function passOrDrop(
  name: string,
  url: string,
  method: string,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  const res = await fetch(input, init);
  if (isRpc(url, method) && gate.dropping.has(name)) {
    gate.dropping.delete(name);
    await res.text(); // the database has answered and committed; the answer never arrives
    throw new TypeError("fetch failed (test: the answer was lost after the database replied)");
  }
  return res;
}

/** A fresh client carrying `user`'s session, whose stamp writes pass the gate as `name`. */
async function sessionClient(user: TestUser, name: string): Promise<SupabaseClient> {
  const { data } = await user.client.auth.getSession();
  const session = data.session;
  if (!session) throw new Error(`no session for ${user.email}`);
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: gatedFetch(name) },
  });
  const { error } = await c.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  return c;
}

type Outcome = { result: UnitActionState | null; thrown: string | null };

/** Run the action as `user` under the gate name `name`; a throw is data, not a crash. */
async function act(user: TestUser, name: string, fields: Record<string, string>): Promise<Outcome> {
  const client = await sessionClient(user, name);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    const result = await ctx.als.run(client, () => applyUnitType({ error: null, savedAt: null }, fd));
    return { result, thrown: null };
  } catch (e) {
    return { result: null, thrown: e instanceof Error ? e.message : String(e) };
  }
}

async function until(label: string, cond: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`barrier timed out: ${label}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let manager: TestUser;
let agent: TestUser;
let otherAdmin: TestUser;
let retired: TestUser;
const userIds: string[] = [];
let fixtureN = 0;

type UnitSpec = {
  code: string;
  block: string | null;
  price: number | null;
  beds?: number | null;
  baths?: number | null;
  archived?: boolean;
  assignedTo?: string;
};
type Project = {
  id: string;
  reference: string;
  org: string;
  /** code → id; ids ascend in the order the spec lists the units */
  units: Record<string, string>;
  phaseUnitId: string | null;
};
type TypeSpec = {
  code: string;
  bedrooms: number | null;
  bathrooms: number | null;
  covered: number | string | null;
  veranda: number | string | null;
  rate: number | string | null;
};

/**
 * The standard fixture: two blocks, a blockless unit, an unpriced unit, an
 * ARCHIVED unit (in scope today: the stamp has always reached every direct
 * unit), a unit already at the type's price, and a unit under a phase (not a
 * direct child, so never in a project's scope).
 */
const STANDARD: UnitSpec[] = [
  { code: "A101", block: "A", price: 200000, beds: 1, baths: 1 },
  { code: "A102", block: "A", price: null, beds: 3, baths: 2 },
  { code: "A103", block: "A", price: 250000, beds: null, baths: null },
  { code: "A104", block: "A", price: 180000, archived: true },
  { code: "B201", block: "B", price: 300000, beds: 2, baths: 2 },
  { code: "B202", block: "B", price: 310000, beds: 3, baths: 2 },
  { code: "C301", block: null, price: 400000, beds: 4, baths: 3 },
];

/** 85 m² × €2941 = €249.985 → €250.000; two beds, ONE bath, a veranda. */
const A1: TypeSpec = { code: "A1", bedrooms: 2, bathrooms: 1, covered: 85, veranda: 12, rate: 2941 };
/** The same layout with no rate and no bathroom count. */
const N1: TypeSpec = { code: "N1", bedrooms: 2, bathrooms: null, covered: 85, veranda: 12, rate: null };

/** `n` fresh ids in ascending order, so "later" means later in insertion AND id order. */
const ascendingIds = (n: number) => Array.from({ length: n }, () => randomUUID()).sort();

async function newProject(units: UnitSpec[] = STANDARD, opts: { org?: string; phase?: boolean } = {}): Promise<Project> {
  fixtureN += 1;
  const org = opts.org ?? ORG;
  const reference = `ZZUT${TAG}${fixtureN}`;
  const { rows } = await pg.query<{ id: string }>(
    `insert into properties (org_id, reference, kind, property_type, status, title)
     values ($1, $2, 'project', 'apartment', 'available', jsonb_build_object('en', 'ZZTEST unit type ' || $2))
     returning id`,
    [org, reference],
  );
  const projectId = rows[0]!.id;
  const ids: Record<string, string> = {};
  const fresh = ascendingIds(units.length);
  for (const [i, u] of units.entries()) {
    const { rows: r } = await pg.query<{ id: string }>(
      `insert into properties (id, org_id, reference, kind, parent_id, property_type, status, visibility,
                               block, unit_number, asking_price, bedrooms, bathrooms, assigned_agent_id)
       values ($1, $2, $3, 'unit', $4, 'apartment', 'available', $5::visibility_level, $6, $7, $8, $9, $10, $11)
       returning id`,
      [
        fresh[i],
        org,
        `${reference}-${u.code}`,
        projectId,
        u.archived ? "archived" : "private",
        u.block,
        u.code,
        u.price,
        u.beds ?? null,
        u.baths ?? null,
        u.assignedTo ?? null,
      ],
    );
    ids[u.code] = r[0]!.id;
  }
  let phaseUnitId: string | null = null;
  if (opts.phase !== false) {
    const { rows: ph } = await pg.query<{ id: string }>(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status)
       values ($1, $2, 'phase', $3, 'apartment', 'available') returning id`,
      [org, `${reference}-P1`, projectId],
    );
    const { rows: pu } = await pg.query<{ id: string }>(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status, block, unit_number, asking_price, bedrooms)
       values ($1, $2, 'unit', $3, 'apartment', 'available', 'A', 'A1', 500000, 5) returning id`,
      [org, `${reference}-P1-A1`, ph[0]!.id],
    );
    phaseUnitId = pu[0]!.id;
  }
  return { id: projectId, reference, org, units: ids, phaseUnitId };
}

async function newType(p: Project, t: TypeSpec): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `insert into unit_types (org_id, project_id, code, bedrooms, bathrooms, covered_area_sqm, veranda_sqm, price_per_sqm)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [p.org, p.id, t.code, t.bedrooms, t.bathrooms, t.covered, t.veranda, t.rate],
  );
  return rows[0]!.id;
}

const fieldsOf = (p: Project, typeId: string, block: string | null, op: string = randomUUID()) => ({
  project_id: p.id,
  unit_type_id: typeId,
  block: block ?? "",
  operation_id: op,
});

type UnitRow = { beds: number | null; baths: number | null; covered: string | null; veranda: string | null; price: string | null };
type State = {
  units: Record<string, UnitRow>;
  history: Record<string, number>;
  changed: Record<string, number>;
  stamped: Record<string, number>;
  /** every payload of a unit-type line, by unit */
  stampPayloads: Record<string, Record<string, unknown>[]>;
};

/** What the database holds for a project — read as postgres, so nothing is filtered. */
async function stateOf(p: Project): Promise<State> {
  const all = [...Object.entries(p.units), ...(p.phaseUnitId ? [["P1-A1", p.phaseUnitId] as [string, string]] : [])];
  const s: State = { units: {}, history: {}, changed: {}, stamped: {}, stampPayloads: {} };
  for (const [code, id] of all) {
    const { rows } = await pg.query<UnitRow & { h: string; e: string }>(
      `select bedrooms as beds, bathrooms as baths, covered_area_sqm::text as covered, veranda_sqm::text as veranda,
              asking_price::text as price,
              (select count(*) from price_history where property_id = $1)::text as h,
              (select count(*) from events where org_id = $2 and entity_type = 'property'
                  and entity_id = $1 and event_type = 'price_changed')::text as e
         from properties where id = $1`,
      [id, p.org],
    );
    const r = rows[0]!;
    s.units[code] = { beds: r.beds, baths: r.baths, covered: r.covered, veranda: r.veranda, price: r.price };
    s.history[code] = Number(r.h);
    s.changed[code] = Number(r.e);
    const { rows: ev } = await pg.query<{ payload: Record<string, unknown> }>(
      `select payload from events where org_id = $1 and entity_type = 'property' and entity_id = $2
          and event_type = 'updated' and payload ->> 'section' = 'unit_type' order by id`,
      [p.org, id],
    );
    s.stamped[code] = ev.length;
    s.stampPayloads[code] = ev.map((e) => e.payload);
  }
  return s;
}

function evidence(label: string, s: State, outcomes: Record<string, Outcome>) {
  const nonzero = (m: Record<string, number>) =>
    Object.entries(m)
      .filter(([, n]) => n > 0)
      .map(([c, n]) => `${c}×${n}`)
      .join(", ") || "(none)";
  console.log(
    `[evidence] ${label}\n` +
      `  units: ${JSON.stringify(s.units)}\n` +
      `  price_history: ${nonzero(s.history)} · price_changed: ${nonzero(s.changed)} · unit-type lines: ${nonzero(s.stamped)}\n` +
      Object.entries(outcomes)
        .map(([k, o]) => `  ${k}: ${o.thrown ? `THREW ${JSON.stringify(o.thrown)}` : JSON.stringify(o.result)}`)
        .join("\n"),
  );
}

/** Nothing at all happened to this project's units since `before`. */
async function expectUntouched(p: Project, before: State) {
  const after = await stateOf(p);
  expect(after.units, "no unit field moved").toEqual(before.units);
  expect(after.history, "no price_history row").toEqual(before.history);
  expect(after.changed, "no price_changed event").toEqual(before.changed);
  expect(after.stamped, "no unit-type line").toEqual(before.stamped);
}

const STAMPED_A1: UnitRow = { beds: 2, baths: 1, covered: "85.00", veranda: "12.00", price: "250000.00" };

// ---------------------------------------------------------------------------
// Failure injection: one write, one row, this organisation only.
// ---------------------------------------------------------------------------
async function inject(table: string, timing: "before update" | "before insert", predicate: string, effect: "raise" | "skip" = "raise") {
  fixtureN += 1;
  const fn = `zz_ut_fail_${RUN}_${fixtureN}`;
  const body =
    effect === "raise"
      ? `raise exception 'injected failure: % on %', tg_op, tg_table_name;`
      : `return null; -- the row is silently skipped, no error`;
  await pg.query(
    `create function public.${fn}() returns trigger language plpgsql as $f$
     begin
       if ${predicate} then
         ${body}
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
const failUnitUpdate = (unitId: string, effect: "raise" | "skip" = "raise") =>
  inject("properties", "before update", `new.id = '${uuidOk(unitId)}'::uuid`, effect);
const failStampLine = (unitId: string) =>
  inject(
    "events",
    "before insert",
    `new.entity_id = '${uuidOk(unitId)}'::uuid and new.event_type = 'updated' and new.payload ->> 'section' = 'unit_type'`,
  );
const failPriceLine = (unitId: string) =>
  inject("events", "before insert", `new.entity_id = '${uuidOk(unitId)}'::uuid and new.event_type = 'price_changed'`);

/** A session's own transaction, as PostgREST would open it: role authenticated, the user's claims. */
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

/** Some backend is waiting on a lock `holderPid` holds. */
async function blockedBy(holderPid: number): Promise<boolean> {
  const { rows } = await pg.query<{ n: string }>(
    "select count(*)::text as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
    [holderPid],
  );
  return Number(rows[0]!.n) > 0;
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  for (const table of ["events", "properties"]) {
    const { rows: stale } = await pg.query<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid = ('public.' || $1)::regclass and tgname like 'zz_ut_fail_%'`,
      [table],
    );
    for (const t of stale) {
      await pg.query(`drop trigger if exists ${t.tgname} on public.${table}`);
      await pg.query(`drop function if exists public.${t.tgname}()`);
    }
  }

  await ensureTestOrg(svc, ORG, `Unit type ${RUN}`, `unit-type-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `Unit type other ${RUN}`, `unit-type-other-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `ut-admin-${RUN}@test.local`, "admin", ORG);
  manager = await createTestUser(svc, `ut-lm-${RUN}@test.local`, "listing_manager", ORG);
  agent = await createTestUser(svc, `ut-agent-${RUN}@test.local`, "agent", ORG);
  otherAdmin = await createTestUser(svc, `ut-other-${RUN}@test.local`, "admin", OTHER_ORG);
  retired = await createTestUser(svc, `ut-retired-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id, manager.id, agent.id, otherAdmin.id, retired.id);
});

afterEach(() => {
  gate.reset();
});

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await pg.query("delete from unit_types where org_id = $1", [org]);
    await pg.query("delete from tasks where org_id = $1", [org]);
    await pg.query("delete from price_history where org_id = $1", [org]);
    // children before parents: properties.parent_id is ON DELETE RESTRICT
    await pg.query("delete from properties where org_id = $1 and kind = 'unit'", [org]);
    await pg.query("delete from properties where org_id = $1 and kind = 'phase'", [org]);
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
describe("1. a successful stamp through the real action", () => {
  it("block A with a rated type: exactly block A's units change, one trail line per actual price change, one unit-type line per unit", async () => {
    const p = await newProject();
    const q = await newProject(); // the same organisation's other project: the control
    const typeId = await newType(p, A1);
    const before = await stateOf(p);
    const beforeQ = await stateOf(q);
    vi.mocked(revalidatePath).mockClear();
    const out = await act(admin, "A", fieldsOf(p, typeId, "A"));
    const s = await stateOf(p);
    evidence("block A, rated type", s, { A: out });

    expect(out.thrown, "the action never throws").toBeNull();
    expect(out.result?.error ?? null).toBeNull();
    expect(out.result?.savedAt).toBeTruthy();
    // every direct block-A unit — the archived one included, as it always was
    for (const code of ["A101", "A102", "A103", "A104"]) {
      expect(s.units[code], `${code}: stamped`).toEqual(STAMPED_A1);
      expect(s.stamped[code], `${code}: one unit-type line`).toBe(1);
    }
    // the price trail: one row and ONE event per unit whose price actually moved
    expect(s.history).toEqual({ ...before.history, A101: 1, A102: 1, A104: 1 });
    expect(s.changed).toEqual({ ...before.changed, A101: 1, A102: 1, A104: 1 });
    expect(s.history.A103, "already at €250.000: no history").toBe(0);
    // other blocks, the blockless unit and the phase's own block-A unit: untouched
    for (const code of ["B201", "B202", "C301", "P1-A1"]) {
      expect(s.units[code]).toEqual(before.units[code]);
      expect(s.stamped[code]).toBe(0);
    }
    await expectUntouched(q, beforeQ);
    expect(s.stampPayloads.A101![0]).toMatchObject({
      section: "unit_type",
      source: "type_applied",
      unit_type: "A1",
      scope: "A",
      project: p.reference,
    });
    // ids and codes only — the payload privacy scan reads lib/actions, not SQL,
    // so the key set is pinned here
    expect(Object.keys(s.stampPayloads.A101![0]!).sort()).toEqual(
      ["operation_id", "project", "scope", "section", "source", "unit_type"],
    );
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([`/properties/${p.id}/units`, "/properties"]),
    );
  });

  it("all units with a type that has no rate: prices are left exactly as they are, blank fields clear", async () => {
    const p = await newProject();
    const typeId = await newType(p, N1);
    const before = await stateOf(p);
    const out = await act(manager, "M", fieldsOf(p, typeId, null));
    const s = await stateOf(p);
    evidence("all units, no rate", s, { M: out });

    expect(out.result?.error ?? null).toBeNull();
    for (const code of ["A101", "A102", "A103", "A104", "B201", "B202", "C301"]) {
      expect(s.units[code], code).toEqual({
        beds: 2,
        baths: null, // blank on the type: a stamp, not a merge
        covered: "85.00",
        veranda: "12.00",
        price: before.units[code]!.price, // no rate: the price is not the type's to say
      });
      expect(s.stamped[code]).toBe(1);
    }
    expect(s.history, "no price moved").toEqual(before.history);
    expect(s.changed, "no price_changed").toEqual(before.changed);
    expect(s.units["P1-A1"]).toEqual(before.units["P1-A1"]);
  });

  it("the €100 rule is exact: 64.35 m² × €1000 = €64.350 rounds UP to €64.400, and the preview says the same", async () => {
    const p = await newProject([{ code: "X1", block: "X", price: 100000 }], { phase: false });
    const t: TypeSpec = { code: "X", bedrooms: 1, bathrooms: 1, covered: "64.35", veranda: null, rate: "1000.00" };
    const typeId = await newType(p, t);
    const out = await act(admin, "A", fieldsOf(p, typeId, "X"));
    const s = await stateOf(p);
    evidence("exact half", s, { A: out });
    expect(out.result?.error ?? null).toBeNull();
    expect(s.units.X1!.price).toBe("64400.00");
    expect(s.units.X1!.veranda, "a blank veranda clears").toBeNull();
    // what the picker showed before the stamp (the row as PostgREST returns it: numbers)
    expect(priceFromType({ covered_area_sqm: 64.35, price_per_sqm: 1000 })).toBe(64400);
    // and the veranda never prices: covered area only
    expect(priceFromType({ covered_area_sqm: 85, price_per_sqm: 2941 })).toBe(250000);
  });
});

describe("1b. rules the stamp now carries only in SQL", () => {
  it("a type WITH a rate but no covered area: the area clears and every price stays exactly as it was", async () => {
    const p = await newProject();
    const typeId = await newType(p, { code: "R0", bedrooms: 1, bathrooms: 1, covered: null, veranda: null, rate: 3000 });
    const before = await stateOf(p);
    const out = await act(admin, "A", fieldsOf(p, typeId, null));
    const s = await stateOf(p);
    evidence("rated, no area", s, { A: out });
    expect(out.result?.error ?? null).toBeNull();
    for (const code of ["A101", "A102", "A103", "A104", "B201", "B202", "C301"]) {
      expect(s.units[code]!.covered, `${code}: area cleared`).toBeNull();
      expect(s.units[code]!.price, `${code}: price untouched`).toBe(before.units[code]!.price);
    }
    expect(s.history).toEqual(before.history);
    expect(s.changed).toEqual(before.changed);
  });

  it("the block filter is exact: 'A' stamps block A only — not 'a', not 'A ' (as the old action matched)", async () => {
    const p = await newProject(
      [
        { code: "U1", block: "A", price: 100000 },
        { code: "U2", block: "a", price: 100000 },
        { code: "U3", block: "A ", price: 100000 },
        { code: "U4", block: null, price: 100000 },
      ],
      { phase: false },
    );
    const typeId = await newType(p, A1);
    const before = await stateOf(p);
    const out = await act(admin, "A", fieldsOf(p, typeId, "A"));
    const s = await stateOf(p);
    evidence("exact block", s, { A: out });
    expect(out.result?.error ?? null).toBeNull();
    expect(s.units.U1).toEqual(STAMPED_A1);
    for (const code of ["U2", "U3", "U4"]) {
      expect(s.units[code], code).toEqual(before.units[code]);
      expect(s.stamped[code], code).toBe(0);
    }
  });

  it("a phase is a container: its own direct units are stamped; the parent project's and a sibling phase's are not", async () => {
    const p = await newProject([{ code: "P101", block: "A", price: 100000 }], { phase: false });
    const phases: Record<string, { id: string; unit: string }> = {};
    for (const ph of ["P1", "P2"]) {
      const { rows } = await pg.query<{ id: string }>(
        `insert into properties (org_id, reference, kind, parent_id, property_type, status)
         values ($1, $2, 'phase', $3, 'apartment', 'available') returning id`,
        [ORG, `${p.reference}-${ph}`, p.id],
      );
      const { rows: u } = await pg.query<{ id: string }>(
        `insert into properties (org_id, reference, kind, parent_id, property_type, status, block, unit_number, asking_price)
         values ($1, $2, 'unit', $3, 'apartment', 'available', 'A', 'A1', 100000) returning id`,
        [ORG, `${p.reference}-${ph}-A1`, rows[0]!.id],
      );
      phases[ph] = { id: rows[0]!.id, unit: u[0]!.id };
    }
    const phase = { ...p, id: phases.P1!.id, units: { PH1: phases.P1!.unit, PH2: phases.P2!.unit, PROJ: p.units.P101! }, phaseUnitId: null };
    const typeId = await newType(phase, A1);
    const before = await stateOf(phase);
    const out = await act(admin, "A", fieldsOf(phase, typeId, "A"));
    const s = await stateOf(phase);
    evidence("phase container", s, { A: out });
    expect(out.result?.error ?? null).toBeNull();
    expect(s.units.PH1).toEqual(STAMPED_A1);
    expect(s.units.PH2, "a sibling phase's unit").toEqual(before.units.PH2);
    expect(s.units.PROJ, "the parent project's unit").toEqual(before.units.PROJ);
    const { rows } = await pg.query<{ project_id: string }>(
      "select project_id from unit_type_applications where org_id = $1 and unit_type_id = $2",
      [ORG, typeId],
    );
    expect(rows.map((r) => r.project_id)).toEqual([phases.P1!.id]);
  });
});

// ---------------------------------------------------------------------------
describe("2. a failure anywhere leaves nothing, and the same submission then succeeds once", () => {
  const stages: Array<[string, (p: Project) => Promise<() => Promise<void>>]> = [
    ["a later unit's UPDATE", (p) => failUnitUpdate(p.units.A104!)],
    ["a later unit's unit-type audit line", (p) => failStampLine(p.units.A104!)],
    ["a later unit's canonical price_changed line", (p) => failPriceLine(p.units.A104!)],
  ];
  for (const [label, arm] of stages) {
    it(`${label} fails: no unit, price history or event survives`, async () => {
      const p = await newProject();
      const typeId = await newType(p, A1);
      const before = await stateOf(p);
      const fields = fieldsOf(p, typeId, "A");
      const disarm = await arm(p);
      let out: Outcome;
      try {
        out = await act(admin, "A", fields);
      } finally {
        await disarm();
      }
      evidence(`injected: ${label}`, await stateOf(p), { A: out });
      expect(out.thrown, "the action never throws").toBeNull();
      expect(out.result?.error).toBeTruthy();
      expect(out.result?.savedAt ?? null).toBeNull();
      await expectUntouched(p, before);

      // the injector is gone: the SAME submission now lands, once
      const retry = await act(admin, "A", fields);
      const s = await stateOf(p);
      expect(retry.result?.error ?? null).toBeNull();
      expect(retry.result?.replayed ?? false).toBe(false);
      for (const code of ["A101", "A102", "A103", "A104"]) {
        expect(s.units[code]).toEqual(STAMPED_A1);
        expect(s.stamped[code]).toBe(1);
      }
      expect(s.changed.A101).toBe(1);
    });
  }

  it("a unit the database silently skips (0 rows, no error) is not reported as a stamped scope: refused, nothing kept", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const before = await stateOf(p);
    const disarm = await failUnitUpdate(p.units.A102!, "skip");
    let out: Outcome;
    try {
      out = await act(admin, "A", fieldsOf(p, typeId, "A"));
    } finally {
      await disarm();
    }
    evidence("silently skipped row", await stateOf(p), { A: out });
    expect(out.thrown).toBeNull();
    expect(out.result?.error).toBeTruthy();
    expect(out.result?.savedAt ?? null).toBeNull();
    await expectUntouched(p, before);
  });
});

// ---------------------------------------------------------------------------
describe("3. concurrent price edits and concurrent stamps", () => {
  it("no rate: a price edited (and committed) between the action's start and its write survives", async () => {
    const p = await newProject();
    const typeId = await newType(p, N1);
    gate.hold("A");
    const pending = act(admin, "A", fieldsOf(p, typeId, "A"));
    await until("the stamp reached its first write", () => gate.arrived("A"));
    // another desk member reprices A103 through PostgREST meanwhile
    const { error } = await manager.client.from("properties").update({ asking_price: 300000 }).eq("id", p.units.A103!);
    expect(error).toBeNull();
    gate.release("A");
    const out = await pending;
    const s = await stateOf(p);
    evidence("no rate, price edited mid-flight", s, { A: out });
    expect(out.result?.error ?? null).toBeNull();
    expect(s.units.A103!.price, "the newer price stands").toBe("300000.00");
    expect(s.units.A103!.beds).toBe(2);
    expect(s.history.A103, "one history row: the edit, not a write-back").toBe(1);
    expect(s.changed.A103).toBe(1);
  });

  it("no rate: a price edit still uncommitted when the stamp arrives — the stamp waits, and the edit survives", async () => {
    const p = await newProject();
    const typeId = await newType(p, N1);
    const tx = await sessionTx(manager);
    let out: Outcome;
    try {
      await tx.query("update properties set asking_price = 300000 where id = $1", [p.units.A103]);
      const { rows } = await tx.query<{ pid: number }>("select pg_backend_pid() as pid");
      const pending = act(admin, "A", fieldsOf(p, typeId, "A"));
      await until("the stamp waits on the edit's row lock", () => blockedBy(rows[0]!.pid));
      await tx.query("commit");
      out = await pending;
    } finally {
      await tx.end();
    }
    const s = await stateOf(p);
    evidence("no rate, price edit holding the row", s, { A: out });
    expect(out.result?.error ?? null).toBeNull();
    expect(s.units.A103!.price, "the committed edit stands").toBe("300000.00");
    expect(s.units.A103!.beds).toBe(2);
    expect(s.history.A103).toBe(1);
  });

  it("with a rate: the stamp's price follows a committed concurrent edit, and the trail records the true old price", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const tx = await sessionTx(manager);
    let out: Outcome;
    try {
      await tx.query("update properties set asking_price = 300000 where id = $1", [p.units.A103]);
      const { rows } = await tx.query<{ pid: number }>("select pg_backend_pid() as pid");
      const pending = act(admin, "A", fieldsOf(p, typeId, "A"));
      await until("the stamp waits on the edit's row lock", () => blockedBy(rows[0]!.pid));
      await tx.query("commit");
      out = await pending;
    } finally {
      await tx.end();
    }
    const s = await stateOf(p);
    evidence("rated, price edit holding the row", s, { A: out });
    expect(out.result?.error ?? null).toBeNull();
    expect(s.units.A103).toEqual(STAMPED_A1);
    const { rows: trail } = await pg.query<{ old_price: string | null; new_price: string }>(
      "select old_price::text, new_price::text from price_history where property_id = $1 order by changed_at, id",
      [p.units.A103],
    );
    expect(trail).toEqual([
      { old_price: "250000.00", new_price: "300000.00" },
      { old_price: "300000.00", new_price: "250000.00" },
    ]);
  });

  it("two different types stamped onto the same block at once: every unit ends as ONE of them, never a mix", async () => {
    const p = await newProject();
    const t1 = await newType(p, A1);
    const t2 = await newType(p, { code: "B2", bedrooms: 3, bathrooms: 2, covered: 120, veranda: 20, rate: 3000 });
    gate.hold("A", "B");
    const pA = act(admin, "A", fieldsOf(p, t1, "A"));
    const pB = act(manager, "B", fieldsOf(p, t2, "A"));
    await until("both reached their first write", () => gate.arrived("A") && gate.arrived("B"));
    gate.release("A");
    gate.release("B");
    const [a, b] = await Promise.all([pA, pB]);
    const s = await stateOf(p);
    evidence("two types at once", s, { A: a, B: b });
    for (const o of [a, b]) expect(o.result?.error ?? null).toBeNull();
    const finals = new Set(["A101", "A102", "A103", "A104"].map((c) => JSON.stringify(s.units[c])));
    expect(finals.size, "one consistent stamp across the block").toBe(1);
    for (const code of ["A101", "A102", "A103", "A104"]) expect(s.stamped[code]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("4. retries and duplicates", () => {
  it("the same submission twice: applied once, the second answer replays the first", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const fields = fieldsOf(p, typeId, "A");
    const first = await act(admin, "A", fields);
    const second = await act(admin, "A", fields);
    const s = await stateOf(p);
    evidence("same submission twice", s, { first, second });
    expect(first.result?.error ?? null).toBeNull();
    expect(second.result?.error ?? null).toBeNull();
    expect(second.result?.replayed).toBe(true);
    for (const code of ["A101", "A102", "A103", "A104"]) expect(s.stamped[code], code).toBe(1);
    expect(s.changed.A101).toBe(1);
  });

  it("the same submission twice AT ONCE (a double submit): applied once", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const fields = fieldsOf(p, typeId, "A");
    gate.hold("A", "B");
    const pA = act(admin, "A", fields);
    const pB = act(admin, "B", fields);
    await until("both submissions reached their first write", () => gate.arrived("A") && gate.arrived("B"));
    gate.release("A");
    gate.release("B");
    const [a, b] = await Promise.all([pA, pB]);
    const s = await stateOf(p);
    evidence("double submit", s, { A: a, B: b });
    for (const o of [a, b]) {
      expect(o.thrown).toBeNull();
      expect(o.result?.error ?? null).toBeNull();
    }
    expect([a, b].filter((o) => o.result?.replayed).length, "exactly one answer is a replay").toBe(1);
    for (const code of ["A101", "A102", "A103", "A104"]) expect(s.stamped[code], code).toBe(1);
  });

  it("the answer is lost after the database committed: 'could not confirm', then pressing again replays — nothing applies twice", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const fields = fieldsOf(p, typeId, "A");
    gate.dropping.add("A");
    vi.mocked(revalidatePath).mockClear();
    const lost = await act(admin, "A", fields);
    const refreshedAfterLost = vi.mocked(revalidatePath).mock.calls.length;
    const retry = await act(admin, "A", fields);
    const s = await stateOf(p);
    evidence("lost answer, then retry", s, { lost, retry });
    expect(lost.thrown).toBeNull();
    expect(lost.result?.error ?? "", "an unconfirmed outcome never claims nothing changed").toMatch(/could not confirm/i);
    expect(lost.result?.error ?? "").not.toMatch(/nothing was changed/i);
    expect(lost.result?.unconfirmed, "flagged, so the form keeps the submission's id").toBe(true);
    expect(refreshedAfterLost, "no redraw on an unknown outcome").toBe(0);
    expect(retry.result?.error ?? null).toBeNull();
    expect(retry.result?.replayed).toBe(true);
    for (const code of ["A101", "A102", "A103", "A104"]) expect(s.stamped[code], code).toBe(1);
    expect(s.changed.A101).toBe(1);
  });

  it("an operation id reused with another scope, another type, or by another user is refused and changes nothing", async () => {
    const p = await newProject();
    const t1 = await newType(p, A1);
    const t2 = await newType(p, N1);
    const op = randomUUID();
    const first = await act(admin, "A", fieldsOf(p, t1, "A", op));
    expect(first.result?.error ?? null).toBeNull();
    const after = await stateOf(p);
    const otherScope = await act(admin, "A", fieldsOf(p, t1, "B", op));
    const otherType = await act(admin, "A", fieldsOf(p, t2, "A", op));
    const byManager = await act(manager, "M", fieldsOf(p, t1, "A", op));
    evidence("reused operation id", await stateOf(p), { first, otherScope, otherType, byManager });
    for (const o of [otherScope, otherType, byManager]) {
      expect(o.thrown).toBeNull();
      expect(o.result?.error ?? "").toMatch(/already used for a different change/);
    }
    await expectUntouched(p, after);
  });

  it("a genuinely new submission of the same stamp applies again (an audit line each time; no price moves twice)", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const first = await act(admin, "A", fieldsOf(p, typeId, "A"));
    const second = await act(admin, "A", fieldsOf(p, typeId, "A"));
    const s = await stateOf(p);
    evidence("two intentional stamps", s, { first, second });
    expect(second.result?.error ?? null).toBeNull();
    expect(second.result?.replayed ?? false).toBe(false);
    expect(s.stamped.A101).toBe(2);
    expect(s.changed.A101, "the second stamp moved no price").toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("5. who may stamp — and a refusal changes nothing", () => {
  it("an agent may not — not even onto the units assigned to them", async () => {
    const p = await newProject(STANDARD.map((u) => (u.code === "A101" ? { ...u, assignedTo: agent.id } : u)));
    const typeId = await newType(p, A1);
    const before = await stateOf(p);
    const out = await act(agent, "G", fieldsOf(p, typeId, "A"));
    evidence("agent", await stateOf(p), { G: out });
    expect(out.thrown, "the action never throws").toBeNull();
    expect(out.result?.error ?? "").toMatch(/only admins and listing managers/i);
    await expectUntouched(p, before);
  });

  it("an aal1 session of an admin changes nothing", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const before = await stateOf(p);
    const c = anonClient();
    const { error } = await c.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD });
    expect(error).toBeNull();
    const out = await act({ ...admin, client: c }, "L", fieldsOf(p, typeId, "A"));
    evidence("aal1 admin", await stateOf(p), { L: out });
    expect(out.thrown, "the action never throws").toBeNull();
    expect(out.result?.error).toBeTruthy();
    await expectUntouched(p, before);
  });

  it("a deactivated admin (session still valid) changes nothing", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const before = await stateOf(p);
    await pg.query("update profiles set is_active = false where id = $1", [retired.id]);
    let out: Outcome;
    try {
      out = await act(retired, "R", fieldsOf(p, typeId, "A"));
    } finally {
      await pg.query("update profiles set is_active = true where id = $1", [retired.id]);
    }
    evidence("deactivated admin", await stateOf(p), { R: out });
    expect(out.thrown, "the action never throws").toBeNull();
    expect(out.result?.error ?? "").toMatch(/deactivated/i);
    await expectUntouched(p, before);
  });

  it("a type from ANOTHER project of the same organisation is refused, nothing changes", async () => {
    const p = await newProject();
    const q = await newProject();
    const foreignType = await newType(q, A1);
    const before = await stateOf(p);
    const out = await act(admin, "A", fieldsOf(p, foreignType, "A"));
    expect(out.result?.error ?? "").toMatch(/not found/i);
    await expectUntouched(p, before);
  });

  it("another organisation's admin cannot reach the project; their own stamp leaves this one alone", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const q = await newProject(undefined, { org: OTHER_ORG });
    const theirType = await newType(q, A1);
    const before = await stateOf(p);
    const out = await act(otherAdmin, "O", fieldsOf(p, typeId, "A"));
    expect(out.result?.error ?? "").toMatch(/not found/i);
    const own = await act(otherAdmin, "O", fieldsOf(q, theirType, "A"));
    expect(own.result?.error ?? null).toBeNull();
    expect((await stateOf(q)).units.A101).toEqual(STAMPED_A1);
    await expectUntouched(p, before);
  });

  it("the function itself: anon may not call it; a direct call with no operation id is refused", async () => {
    const p = await newProject();
    const typeId = await newType(p, A1);
    const before = await stateOf(p);
    const anon = await anonClient().rpc(RPC, {
      p_project_id: p.id,
      p_unit_type_id: typeId,
      p_block: "A",
      p_operation_id: randomUUID(),
    });
    expect(anon.error?.code).toBe("42501");
    const noOp = await admin.client.rpc(RPC, { p_project_id: p.id, p_unit_type_id: typeId, p_block: "A", p_operation_id: null });
    expect(noOp.error?.code).toBe("P0001");
    await expectUntouched(p, before);
  });
});

// ---------------------------------------------------------------------------
describe("6. the chain", () => {
  it("verifies for both organisations after everything above", async () => {
    for (const org of [ORG, OTHER_ORG]) {
      const { rows } = await pg.query("select ok, reason from verify_events_chain($1::uuid, null::bigint)", [org]);
      expect(rows[0]).toMatchObject({ ok: true });
    }
  });
});
