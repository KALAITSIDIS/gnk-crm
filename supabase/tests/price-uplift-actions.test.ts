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
 * Bulk repricing and price-list versions through the REAL server actions,
 * against the REAL stack (T-price-uplift-atomic).
 *
 * Nothing below the action is stubbed except the Next.js request plumbing,
 * exactly as in deal-close-actions.test.ts: `createClient` hands the action a
 * supabase-js client signed in (aal2 unless the test says otherwise) as a
 * fixture user, so every read and write goes through PostgREST, RLS, the
 * triggers and the events hash chain as it does in production. The client is
 * resolved from an AsyncLocalStorage context rather than a queue, so an action
 * that calls `createClient` twice (the pre-0141 uplift reached
 * `createPriceListVersion` with a second call) still gets its own session, even
 * while another action is in flight.
 *
 * WHAT IT PINS (each scenario prints one `[evidence]` line of what the database
 * holds afterwards):
 *   1. a reprice changes exactly the units the reviewed preview showed, writes
 *      one price_history row and ONE price_changed event per actual change,
 *      and records the complete project price list and its event with them;
 *   2. a failure at any write stage leaves nothing — no price, history, event,
 *      header or item — and a retry of the same submission then succeeds once;
 *   3. a repeated, concurrent or lost-response retry of one submission applies
 *      once; a reused id with other inputs or another user is refused; a price
 *      that moved since the review is never overwritten; concurrent versions
 *      do not collide;
 *   4. who may do it: admin and listing manager; an agent, an aal1 session
 *      and another organisation's admin change nothing;
 *   5. the target set is complete past PostgREST's 1000-row page.
 *
 * FAILURE INJECTION IS REAL: entity-scoped BEFORE triggers that refuse ONE
 * write for ONE row of this file's throwaway organisation, removed in
 * `finally` (stale copies are dropped in beforeAll by the `zz_pu_fail_`
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
const RPC = "record_price_list_version";

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

import { applyPriceUplift, createPriceListVersion, type UnitActionState } from "@/lib/actions/units";
import { previewUplift, type UpliftTarget } from "@/lib/services/price-uplift";

// ---------------------------------------------------------------------------
// The gate: holds a client's next price write; can drop the answer of the RPC.
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

/** The first write of either generation of the actions: the RPC, or (pre-0141) a version header or a unit PATCH. */
function isPriceWrite(url: string, method: string): boolean {
  return (
    isRpc(url, method) ||
    (method === "POST" && /\/rest\/v1\/price_lists(\?|$)/.test(url)) ||
    (method === "PATCH" && /\/rest\/v1\/properties(\?|$)/.test(url))
  );
}

function gatedFetch(name: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (isPriceWrite(url, method) && gate.holding.has(name)) {
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

/** A fresh client carrying `user`'s session, whose price writes pass the gate as `name`. */
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
type Action = typeof applyPriceUplift;

/** Run an action as `user` under the gate name `name`; a throw is data, not a crash. */
async function act(user: TestUser, name: string, action: Action, fields: Record<string, string>): Promise<Outcome> {
  const client = await sessionClient(user, name);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    const result = await ctx.als.run(client, () => action({ error: null, savedAt: null }, fd));
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
const userIds: string[] = [];
let fixtureN = 0;

type UnitSpec = {
  code: string;
  block: string | null;
  price: number | null;
  archived?: boolean;
  assignedTo?: string;
};
type Project = {
  id: string;
  reference: string;
  org: string;
  units: Record<string, string>;
  phaseUnitId: string | null;
};

/**
 * The standard fixture: two blocks, a blockless unit, an unpriced unit, a
 * zero-priced unit, an ARCHIVED priced unit (hidden from the page's preview),
 * and a unit under a phase (not a direct child, so outside a project-level
 * reprice and snapshot today).
 */
const STANDARD: UnitSpec[] = [
  { code: "A101", block: "A", price: 200000 },
  { code: "A102", block: "A", price: null },
  { code: "A103", block: "A", price: 0 },
  { code: "B201", block: "B", price: 300000 },
  { code: "B202", block: "B", price: 310000, archived: true },
  { code: "B204", block: "B", price: 50000 },
  { code: "B206", block: "B", price: 40000 },
  { code: "C301", block: null, price: 400000 },
];

async function newProject(
  units: UnitSpec[] = STANDARD,
  opts: { org?: string; phase?: boolean } = {},
): Promise<Project> {
  fixtureN += 1;
  const org = opts.org ?? ORG;
  const reference = `ZZPU${TAG}${fixtureN}`;
  const { rows } = await pg.query<{ id: string }>(
    `insert into properties (org_id, reference, kind, property_type, status, title)
     values ($1, $2, 'project', 'apartment', 'available', jsonb_build_object('en', 'ZZTEST uplift ' || $2))
     returning id`,
    [org, reference],
  );
  const projectId = rows[0]!.id;
  const ids: Record<string, string> = {};
  for (const u of units) {
    const { rows: r } = await pg.query<{ id: string }>(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status, visibility,
                               block, unit_number, asking_price, assigned_agent_id)
       values ($1, $2, 'unit', $3, 'apartment', 'available', $4::visibility_level, $5, $6, $7, $8)
       returning id`,
      [
        org,
        `${reference}-${u.code}`,
        projectId,
        u.archived ? "archived" : "private",
        u.block,
        u.code,
        u.price,
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
      `insert into properties (org_id, reference, kind, parent_id, property_type, status, block, unit_number, asking_price)
       values ($1, $2, 'unit', $3, 'apartment', 'available', 'A', 'A1', 500000) returning id`,
      [org, `${reference}-P1-A1`, ph[0]!.id],
    );
    phaseUnitId = pu[0]!.id;
  }
  return { id: projectId, reference, org, units: ids, phaseUnitId };
}

/** What the units page would hand the form: direct, non-archived units, ordered as the page orders them. */
async function reviewed(p: Project, block: string | null): Promise<UpliftTarget[]> {
  const { rows } = await pg.query<{ id: string; reference: string; block: string | null; price: string | null }>(
    `select id, reference, block, asking_price::text as price
       from properties
      where parent_id = $1 and kind = 'unit' and visibility <> 'archived'
        and ($2::text is null or block = $2)
      order by block nulls first, unit_number`,
    [p.id, block],
  );
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    block: r.block,
    asking_price: r.price === null ? null : Number(r.price),
  }));
}

const expectedOf = (targets: UpliftTarget[]) =>
  JSON.stringify(targets.map((t) => ({ id: t.id, price: t.asking_price === null ? null : Number(t.asking_price) })));

async function upliftFields(
  p: Project,
  spec: { block?: string | null; mode?: "percent" | "fixed"; amount: number; notes?: string; op?: string },
): Promise<Record<string, string>> {
  const block = spec.block ?? null;
  return {
    project_id: p.id,
    block: block ?? "",
    mode: spec.mode ?? "percent",
    amount: String(spec.amount),
    ...(spec.notes ? { notes: spec.notes } : {}),
    operation_id: spec.op ?? randomUUID(),
    expected: expectedOf(await reviewed(p, block)),
  };
}

type State = {
  prices: Record<string, string | null>;
  history: Record<string, number>;
  changed: Record<string, number>;
  lists: { version: number; items: Record<string, string> }[];
  listEvents: { payload: Record<string, unknown> }[];
};

/** What the database holds for a project — read as postgres, so nothing is filtered. */
async function stateOf(p: Project): Promise<State> {
  const codes = Object.entries(p.units);
  const prices: State["prices"] = {};
  const history: State["history"] = {};
  const changed: State["changed"] = {};
  const all = [...codes, ...(p.phaseUnitId ? [["P1-A1", p.phaseUnitId] as [string, string]] : [])];
  for (const [code, id] of all) {
    const { rows } = await pg.query<{ price: string | null; h: string; e: string }>(
      `select (select asking_price::text from properties where id = $1) as price,
              (select count(*) from price_history where property_id = $1)::text as h,
              (select count(*) from events where org_id = $2 and entity_type = 'property'
                  and entity_id = $1 and event_type = 'price_changed')::text as e`,
      [id, p.org],
    );
    prices[code] = rows[0]!.price;
    history[code] = Number(rows[0]!.h);
    changed[code] = Number(rows[0]!.e);
  }
  const byId = new Map(all.map(([code, id]) => [id, code]));
  const { rows: lists } = await pg.query<{ id: string; version: number }>(
    "select id, version from price_lists where project_id = $1 order by version",
    [p.id],
  );
  const out: State["lists"] = [];
  for (const l of lists) {
    const { rows: items } = await pg.query<{ unit_id: string; price: string }>(
      "select unit_id, list_price::text as price from price_list_items where price_list_id = $1",
      [l.id],
    );
    out.push({
      version: l.version,
      items: Object.fromEntries(items.map((i) => [byId.get(i.unit_id) ?? i.unit_id, i.price])),
    });
  }
  const { rows: listEvents } = await pg.query<{ payload: Record<string, unknown> }>(
    `select payload from events where org_id = $1 and entity_type = 'property' and entity_id = $2
        and event_type = 'price_list_created' order by id`,
    [p.org, p.id],
  );
  return { prices, history, changed, lists: out, listEvents };
}

function evidence(label: string, s: State, outcomes: Record<string, Outcome>) {
  const changedUnits = Object.entries(s.changed).filter(([, n]) => n > 0);
  console.log(
    `[evidence] ${label}\n` +
      `  prices: ${JSON.stringify(s.prices)}\n` +
      `  price_history rows: ${JSON.stringify(s.history)}\n` +
      `  price_changed events: ${changedUnits.map(([c, n]) => `${c}×${n}`).join(", ") || "(none)"}\n` +
      `  versions: ${s.lists.map((l) => `v${l.version}[${Object.keys(l.items).length} items]`).join(", ") || "(none)"}` +
      ` · price_list_created events: ${s.listEvents.length}\n` +
      Object.entries(outcomes)
        .map(([k, o]) => `  ${k}: ${o.thrown ? `THREW ${JSON.stringify(o.thrown)}` : JSON.stringify(o.result)}`)
        .join("\n"),
  );
}

/** Nothing at all happened to this project since `before`. */
async function expectUntouched(p: Project, before: State) {
  const after = await stateOf(p);
  expect(after.prices, "no price moved").toEqual(before.prices);
  expect(after.history, "no price_history row").toEqual(before.history);
  expect(after.changed, "no price_changed event").toEqual(before.changed);
  expect(after.lists, "no version, header or item").toEqual(before.lists);
  expect(after.listEvents, "no price_list_created event").toEqual(before.listEvents);
}

// ---------------------------------------------------------------------------
// Failure injection: one write, one row, this organisation only.
// ---------------------------------------------------------------------------
async function inject(table: string, timing: "before update" | "before insert", predicate: string) {
  fixtureN += 1;
  const fn = `zz_pu_fail_${RUN}_${fixtureN}`;
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
const failUnitUpdate = (unitId: string) =>
  inject("properties", "before update", `new.id = '${uuidOk(unitId)}'::uuid and new.asking_price is distinct from old.asking_price`);
const failEvent = (entityId: string, type: "price_changed" | "price_list_created") =>
  inject("events", "before insert", `new.entity_id = '${uuidOk(entityId)}'::uuid and new.event_type = '${type}'`);
const failHeader = (projectId: string) =>
  inject("price_lists", "before insert", `new.project_id = '${uuidOk(projectId)}'::uuid`);
const failItems = (projectId: string) =>
  inject(
    "price_list_items",
    "before insert",
    `exists (select 1 from public.price_lists pl where pl.id = new.price_list_id and pl.project_id = '${uuidOk(projectId)}'::uuid)`,
  );

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  for (const table of ["events", "properties", "price_lists", "price_list_items"]) {
    const { rows: stale } = await pg.query<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid = ('public.' || $1)::regclass and tgname like 'zz_pu_fail_%'`,
      [table],
    );
    for (const t of stale) {
      await pg.query(`drop trigger if exists ${t.tgname} on public.${table}`);
      await pg.query(`drop function if exists public.${t.tgname}()`);
    }
  }

  await ensureTestOrg(svc, ORG, `Price uplift ${RUN}`, `price-uplift-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `Price uplift other ${RUN}`, `price-uplift-other-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `pu-admin-${RUN}@test.local`, "admin", ORG);
  manager = await createTestUser(svc, `pu-lm-${RUN}@test.local`, "listing_manager", ORG);
  agent = await createTestUser(svc, `pu-agent-${RUN}@test.local`, "agent", ORG);
  otherAdmin = await createTestUser(svc, `pu-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(admin.id, manager.id, agent.id, otherAdmin.id);
});

afterEach(() => {
  gate.reset();
});

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await pg.query("delete from tasks where org_id = $1", [org]);
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
describe("1. a successful reprice through the real action", () => {
  it("every unit +10%: exactly the previewed units move, one history row and ONE price_changed event each, and the complete version with its event", async () => {
    const p = await newProject();
    const before = await stateOf(p);
    const out = await act(admin, "A", applyPriceUplift, await upliftFields(p, { amount: 10 }));
    const s = await stateOf(p);
    evidence("all units +10%", s, { A: out });

    expect(out.thrown, "the action never throws").toBeNull();
    expect(out.result?.error ?? null).toBeNull();
    expect(out.result?.savedAt).toBeTruthy();
    expect(s.prices).toEqual({
      ...before.prices,
      A101: "220000.00",
      B201: "330000.00",
      B204: "55000.00",
      B206: "44000.00",
      C301: "440000.00",
    });
    // unpriced, zero-priced, archived (never previewed) and the phase's unit: untouched
    for (const code of ["A102", "A103", "B202", "P1-A1"]) expect(s.prices[code]).toBe(before.prices[code]);
    for (const code of ["A101", "B201", "B204", "B206", "C301"]) {
      expect(s.history[code], `${code}: one price_history row`).toBe(1);
      expect(s.changed[code], `${code}: one canonical price_changed event`).toBe(1);
    }
    for (const code of ["A102", "A103", "B202", "P1-A1"]) {
      expect(s.history[code], `${code}: no history`).toBe(0);
      expect(s.changed[code], `${code}: no event`).toBe(0);
    }
    // the version is the COMPLETE price list (every priced direct unit, as before 0141)
    expect(s.lists).toEqual([
      {
        version: 1,
        items: { A101: "220000.00", A103: "0.00", B201: "330000.00", B202: "310000.00", B204: "55000.00", B206: "44000.00", C301: "440000.00" },
      },
    ]);
    expect(s.listEvents).toHaveLength(1);
    expect(s.listEvents[0]!.payload).toMatchObject({ version: 1, units: 7, changed: 5, source: "bulk_uplift" });
  });

  it("one block, +0.1%: the €100 rule is exact at a half — the preview and the database agree, unchanged units are not touched", async () => {
    const p = await newProject();
    const fields = await upliftFields(p, { block: "B", amount: 0.1 });
    const preview = previewUplift(await reviewed(p, "B"), { mode: "percent", amount: 0.1 });
    const out = await act(admin, "A", applyPriceUplift, fields);
    const s = await stateOf(p);
    evidence("block B +0.1%", s, { A: out });

    expect(out.result?.error ?? null).toBeNull();
    // 300000 → 300300; 50000 → exactly 50050 → half rounds UP to 50100; 40000 → 40040 → 40000 unchanged
    expect(s.prices.B201).toBe("300300.00");
    expect(s.prices.B204).toBe("50100.00");
    expect(s.prices.B206).toBe("40000.00");
    expect(s.prices.B202, "archived: never previewed, never written").toBe("310000.00");
    expect(s.changed.B206, "unchanged after rounding: no event").toBe(0);
    expect(s.history.B206, "unchanged after rounding: no history").toBe(0);
    // the preview the form shows says the same thing, unit for unit
    expect(Object.fromEntries(preview.rows.map((r) => [r.reference.split("-").pop(), r.to]))).toEqual({ B201: 300300, B204: 50100 });
    expect(preview.unchanged).toBe(1);
    // a block change still records the complete project list
    expect(Object.keys(s.lists[0]?.items ?? {}).sort()).toEqual(["A101", "A103", "B201", "B202", "B204", "B206", "C301"]);
    expect(s.lists[0]!.items.A101).toBe("200000.00");
  });

  it("negative adjustments: a cut, a fixed cut, and the €100 floor", async () => {
    const p = await newProject(
      [
        { code: "N1", block: "N", price: 250000 },
        { code: "N2", block: "N", price: 1000 },
        { code: "N3", block: "N", price: 120 },
      ],
      { phase: false },
    );
    const out = await act(admin, "A", applyPriceUplift, await upliftFields(p, { block: "N", mode: "fixed", amount: -25000 }));
    const s = await stateOf(p);
    evidence("fixed −25000", s, { A: out });
    expect(out.result?.error ?? null).toBeNull();
    expect(s.prices).toEqual({ N1: "225000.00", N2: "100.00", N3: "100.00" });
    const out2 = await act(admin, "A", applyPriceUplift, await upliftFields(p, { block: "N", mode: "percent", amount: -150 }));
    const s2 = await stateOf(p);
    expect(out2.result?.error ?? null).toBeNull();
    // N2 and N3 already sit on the floor: unchanged, so no second history row
    expect(s2.prices).toEqual({ N1: "100.00", N2: "100.00", N3: "100.00" });
    expect(s2.history).toEqual({ N1: 2, N2: 1, N3: 1 });
    expect(s2.changed).toEqual({ N1: 2, N2: 1, N3: 1 });
    expect(s2.lists.map((l) => l.version)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
describe("2. a failure at any write stage leaves nothing, and the same submission then succeeds once", () => {
  const stages: Array<[string, (p: Project) => Promise<() => Promise<void>>]> = [
    ["a later unit's UPDATE", (p) => failUnitUpdate(p.units.C301!)],
    ["a later unit's canonical price_changed event", (p) => failEvent(p.units.C301!, "price_changed")],
    ["the version header", (p) => failHeader(p.id)],
    ["the version's items", (p) => failItems(p.id)],
    ["the version's price_list_created event", (p) => failEvent(p.id, "price_list_created")],
  ];
  for (const [label, arm] of stages) {
    it(`${label} fails: no price, history, event, header or item survives`, async () => {
      const p = await newProject();
      const before = await stateOf(p);
      const fields = await upliftFields(p, { amount: 10 });
      const disarm = await arm(p);
      let out: Outcome;
      try {
        out = await act(admin, "A", applyPriceUplift, fields);
      } finally {
        await disarm();
      }
      evidence(`injected: ${label}`, await stateOf(p), { A: out });
      expect(out.thrown, "the action never throws").toBeNull();
      expect(out.result?.error).toBeTruthy();
      expect(out.result?.error ?? "").not.toMatch(/Prices updated/);
      await expectUntouched(p, before);

      // the injector is gone: the SAME submission (same id, same reviewed prices) now lands once
      const retry = await act(admin, "A", applyPriceUplift, fields);
      const s = await stateOf(p);
      expect(retry.result?.error ?? null).toBeNull();
      expect(retry.result?.replayed ?? false).toBe(false);
      expect(s.prices.A101).toBe("220000.00");
      expect(s.changed.A101).toBe(1);
      expect(s.lists.map((l) => l.version)).toEqual([1]);
      expect(s.listEvents).toHaveLength(1);
    });
  }

  for (const [label, arm] of [
    ["the items", (p: Project) => failItems(p.id)],
    ["the event", (p: Project) => failEvent(p.id, "price_list_created")],
  ] as const) {
    it(`a standalone version whose ${label} fail leaves no header behind`, async () => {
      const p = await newProject();
      const before = await stateOf(p);
      const fields = { project_id: p.id, notes: "ZZTEST snapshot", operation_id: randomUUID() };
      const disarm = await arm(p);
      let out: Outcome;
      try {
        out = await act(admin, "A", createPriceListVersion, fields);
      } finally {
        await disarm();
      }
      evidence(`standalone, injected: ${label}`, await stateOf(p), { A: out });
      expect(out.thrown, "the action never throws").toBeNull();
      expect(out.result?.error).toBeTruthy();
      await expectUntouched(p, before);
    });
  }
});

// ---------------------------------------------------------------------------
describe("3. retries, duplicates and concurrency", () => {
  it("the same submission twice: applied once, the second answer replays the first", async () => {
    const p = await newProject();
    const fields = await upliftFields(p, { amount: 10 });
    const first = await act(admin, "A", applyPriceUplift, fields);
    const second = await act(admin, "A", applyPriceUplift, fields);
    const s = await stateOf(p);
    evidence("same submission twice", s, { first, second });
    expect(first.result?.error ?? null).toBeNull();
    expect(second.result?.error ?? null).toBeNull();
    expect(second.result?.replayed).toBe(true);
    expect(second.result?.version).toBe(first.result?.version);
    expect(s.prices.A101).toBe("220000.00");
    expect(s.changed.A101).toBe(1);
    expect(s.lists.map((l) => l.version)).toEqual([1]);
  });

  it("the same submission twice AT ONCE (a double submit): applied once", async () => {
    const p = await newProject();
    const fields = await upliftFields(p, { amount: 10 });
    gate.hold("A", "B");
    const pA = act(admin, "A", applyPriceUplift, fields);
    const pB = act(admin, "B", applyPriceUplift, fields);
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
    expect(s.prices.A101).toBe("220000.00");
    expect(s.changed.A101).toBe(1);
    expect(s.lists.map((l) => l.version)).toEqual([1]);
  });

  it("the answer is lost after the database committed: pressing again returns the committed result, nothing applies twice", async () => {
    const p = await newProject();
    const fields = await upliftFields(p, { amount: 10 });
    gate.dropping.add("A");
    const lost = await act(admin, "A", applyPriceUplift, fields);
    const retry = await act(admin, "A", applyPriceUplift, fields);
    const s = await stateOf(p);
    evidence("lost answer, then retry", s, { lost, retry });
    expect(lost.thrown).toBeNull();
    expect(lost.result?.error ?? "", "an unconfirmed outcome never claims nothing changed").toMatch(/could not confirm/i);
    expect(lost.result?.unconfirmed, "flagged, so the form keeps the submission's id").toBe(true);
    expect(retry.result?.error ?? null).toBeNull();
    expect(retry.result?.replayed).toBe(true);
    expect(retry.result?.version).toBe(1);
    expect(s.prices.A101).toBe("220000.00");
    expect(s.changed.A101).toBe(1);
    expect(s.lists.map((l) => l.version)).toEqual([1]);
  });

  it("after a lost answer the form keeps the id even if the page redrew: the same id over the committed prices is refused, never applied twice", async () => {
    const p = await newProject();
    const fields = await upliftFields(p, { amount: 10 });
    gate.dropping.add("A");
    const lost = await act(admin, "A", applyPriceUplift, fields);
    expect(lost.result?.unconfirmed).toBe(true);
    // what a redrawn form would send under the pinned id: the committed prices as "reviewed"
    const redrawn = { ...(await upliftFields(p, { amount: 10 })), operation_id: fields.operation_id! };
    const retry = await act(admin, "A", applyPriceUplift, redrawn);
    const s = await stateOf(p);
    evidence("lost answer, redrawn retry", s, { lost, retry });
    expect(retry.result?.error ?? "").toMatch(/already used for a different change/);
    expect(s.prices.A101).toBe("220000.00");
    expect(s.changed.A101).toBe(1);
    expect(s.lists.map((l) => l.version)).toEqual([1]);
  });

  it("an operation id reused with different inputs, or by another user, is refused and changes nothing", async () => {
    const p = await newProject();
    const op = randomUUID();
    const original = await upliftFields(p, { amount: 10, op });
    const first = await act(admin, "A", applyPriceUplift, original);
    expect(first.result?.error ?? null).toBeNull();
    const after = await stateOf(p);
    const other = await act(admin, "A", applyPriceUplift, await upliftFields(p, { amount: 5, op }));
    // the admin's EXACT submission from another user: only the creator check refuses it
    const byManager = await act(manager, "M", applyPriceUplift, original);
    evidence("reused operation id", await stateOf(p), { first, other, byManager });
    for (const o of [other, byManager]) {
      expect(o.thrown).toBeNull();
      expect(o.result?.error ?? "").toMatch(/already used for a different change/);
    }
    await expectUntouched(p, after);
  });

  it("a genuinely new reprice (a new submission over the refreshed prices) applies again", async () => {
    const p = await newProject();
    const first = await act(admin, "A", applyPriceUplift, await upliftFields(p, { amount: 10 }));
    const second = await act(admin, "A", applyPriceUplift, await upliftFields(p, { amount: 10 }));
    const s = await stateOf(p);
    evidence("two intentional reprices", s, { first, second });
    expect(second.result?.error ?? null).toBeNull();
    expect(second.result?.replayed ?? false).toBe(false);
    expect(s.prices.A101).toBe("242000.00");
    expect(s.changed.A101).toBe(2);
    expect(s.lists.map((l) => l.version)).toEqual([1, 2]);
  });

  it("a price edited after the review is never silently overwritten: the submission is refused and nothing changes", async () => {
    const p = await newProject();
    const fields = await upliftFields(p, { amount: 10 });
    // another desk member edits A101 between the review and the submit
    const { error } = await admin.client.from("properties").update({ asking_price: 210000 }).eq("id", p.units.A101!);
    expect(error).toBeNull();
    const before = await stateOf(p);
    const out = await act(admin, "A", applyPriceUplift, fields);
    evidence("stale review", await stateOf(p), { A: out });
    expect(out.thrown).toBeNull();
    expect(out.result?.error ?? "").toMatch(/changed since you reviewed/i);
    await expectUntouched(p, before);
    expect(before.prices.A101).toBe("210000.00");
  });

  it("a unit added to the scope after the review: refused, nothing changes", async () => {
    const p = await newProject();
    const fields = await upliftFields(p, { block: "A", amount: 10 });
    await pg.query(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status, block, unit_number, asking_price)
       values ($1, $2, 'unit', $3, 'apartment', 'available', 'A', 'A109', 111000)`,
      [ORG, `${p.reference}-A109`, p.id],
    );
    const before = await stateOf(p);
    const out = await act(admin, "A", applyPriceUplift, fields);
    evidence("scope grew after review", await stateOf(p), { A: out });
    expect(out.result?.error ?? "").toMatch(/changed since you reviewed/i);
    await expectUntouched(p, before);
  });

  it("two different submissions over the same review, at once: exactly one applies, the other is told to refresh", async () => {
    const p = await newProject();
    const f1 = await upliftFields(p, { amount: 10 });
    const f2 = await upliftFields(p, { amount: 10 });
    gate.hold("A", "B");
    const pA = act(admin, "A", applyPriceUplift, f1);
    const pB = act(manager, "B", applyPriceUplift, f2);
    await until("both reached their first write", () => gate.arrived("A") && gate.arrived("B"));
    gate.release("A");
    gate.release("B");
    const [a, b] = await Promise.all([pA, pB]);
    const s = await stateOf(p);
    evidence("two reprices at once", s, { A: a, B: b });
    expect([a, b].filter((o) => !o.result?.error).length, "exactly one applies").toBe(1);
    expect([a, b].filter((o) => /changed since you reviewed/i.test(o.result?.error ?? "")).length).toBe(1);
    expect(s.prices.A101).toBe("220000.00");
    expect(s.changed.A101).toBe(1);
    expect(s.lists.map((l) => l.version)).toEqual([1]);
  });

  it("two standalone versions at once: two complete versions, no collision", async () => {
    const p = await newProject();
    gate.hold("A", "B");
    const pA = act(admin, "A", createPriceListVersion, { project_id: p.id, operation_id: randomUUID() });
    const pB = act(manager, "B", createPriceListVersion, { project_id: p.id, operation_id: randomUUID() });
    await until("both reached their first write", () => gate.arrived("A") && gate.arrived("B"));
    gate.release("A");
    gate.release("B");
    const [a, b] = await Promise.all([pA, pB]);
    const s = await stateOf(p);
    evidence("two snapshots at once", s, { A: a, B: b });
    for (const o of [a, b]) {
      expect(o.thrown).toBeNull();
      expect(o.result?.error ?? null).toBeNull();
    }
    expect(s.lists.map((l) => l.version)).toEqual([1, 2]);
    for (const l of s.lists) expect(Object.keys(l.items)).toHaveLength(7);
    expect(s.listEvents.map((e) => e.payload.version)).toEqual([1, 2]);
  });

  it("a reprice and a standalone version at once: both complete, and each version is one consistent set of prices", async () => {
    const p = await newProject();
    const fields = await upliftFields(p, { amount: 10 });
    gate.hold("A", "B");
    const pA = act(admin, "A", applyPriceUplift, fields);
    const pB = act(manager, "B", createPriceListVersion, { project_id: p.id, operation_id: randomUUID() });
    await until("both reached their first write", () => gate.arrived("A") && gate.arrived("B"));
    gate.release("A");
    gate.release("B");
    const [a, b] = await Promise.all([pA, pB]);
    const s = await stateOf(p);
    evidence("reprice + snapshot at once", s, { A: a, B: b });
    for (const o of [a, b]) expect(o.result?.error ?? null).toBeNull();
    expect(s.lists.map((l) => l.version)).toEqual([1, 2]);
    const old = { A101: "200000.00", B201: "300000.00", C301: "400000.00" };
    const raised = { A101: "220000.00", B201: "330000.00", C301: "440000.00" };
    for (const l of s.lists) {
      const picked = { A101: l.items.A101, B201: l.items.B201, C301: l.items.C301 };
      expect([old, raised], `v${l.version} is all-before or all-after, never mixed`).toContainEqual(picked);
    }
    expect(s.changed.A101).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("4. who may reprice — and a refusal changes nothing", () => {
  it("a listing manager may", async () => {
    const p = await newProject();
    const out = await act(manager, "M", applyPriceUplift, await upliftFields(p, { amount: 10 }));
    expect(out.result?.error ?? null).toBeNull();
    expect((await stateOf(p)).prices.A101).toBe("220000.00");
  });

  it("an agent may not — not even on the units assigned to them", async () => {
    // A101 is the agent's own listing: properties_update lets them edit it directly
    const p = await newProject(STANDARD.map((u) => (u.code === "A101" ? { ...u, assignedTo: agent.id } : u)));
    const before = await stateOf(p);
    const out = await act(agent, "G", applyPriceUplift, await upliftFields(p, { amount: 10 }));
    evidence("agent reprice", await stateOf(p), { G: out });
    expect(out.thrown, "the action never throws").toBeNull();
    expect(out.result?.error ?? "").toMatch(/Only admins and listing managers/);
    await expectUntouched(p, before);
    const snap = await act(agent, "G", createPriceListVersion, { project_id: p.id, operation_id: randomUUID() });
    expect(snap.result?.error ?? "").toMatch(/Only admins and listing managers/);
    await expectUntouched(p, before);
  });

  it("an aal1 session of an admin changes nothing", async () => {
    const p = await newProject();
    const before = await stateOf(p);
    const c = anonClient();
    const { error } = await c.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD });
    expect(error).toBeNull();
    const aal1: TestUser = { ...admin, client: c };
    const out = await act(aal1, "L", applyPriceUplift, await upliftFields(p, { amount: 10 }));
    evidence("aal1 admin", await stateOf(p), { L: out });
    expect(out.thrown, "the action never throws").toBeNull();
    expect(out.result?.error ?? "").toMatch(/Second factor required/);
    await expectUntouched(p, before);
  });

  it("another organisation's admin cannot reach the project, and their own reprice leaves this one alone", async () => {
    const p = await newProject();
    const q = await newProject(undefined, { org: OTHER_ORG });
    const before = await stateOf(p);
    const out = await act(otherAdmin, "O", applyPriceUplift, await upliftFields(p, { amount: 10 }));
    expect(out.result?.error ?? "").toMatch(/Project not found/);
    // the isolation control: their own reprice works and touches only their units
    const own = await act(otherAdmin, "O", applyPriceUplift, await upliftFields(q, { amount: 10 }));
    expect(own.result?.error ?? null).toBeNull();
    expect((await stateOf(q)).prices.A101).toBe("220000.00");
    await expectUntouched(p, before);
  });
});

// ---------------------------------------------------------------------------
describe("5. the target set does not depend on PostgREST's page size", () => {
  it("1200 units: every one is repriced and snapshotted", { timeout: 600_000 }, async () => {
    const p = await newProject([], { phase: false });
    await pg.query(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status, block, unit_number, asking_price)
       select $1, $2 || '-L' || g, 'unit', $3, 'apartment', 'available', 'L', 'L' || lpad(g::text, 4, '0'), 100000 + g * 100
         from generate_series(1, 1200) g`,
      [ORG, p.reference, p.id],
    );
    const out = await act(admin, "A", applyPriceUplift, await upliftFields(p, { amount: 10 }));
    const { rows } = await pg.query<{ moved: string; events: string; items: string }>(
      `select (select count(*) from properties u where u.parent_id = $1 and u.asking_price <> round((100000 + substr(u.unit_number, 2)::int * 100) * 1.1, -2))::text as moved,
              (select count(*) from events e where e.org_id = $2 and e.event_type = 'price_changed'
                  and e.entity_id in (select id from properties where parent_id = $1))::text as events,
              (select count(*) from price_list_items i join price_lists l on l.id = i.price_list_id where l.project_id = $1)::text as items`,
      [p.id, ORG],
    );
    console.log(`[evidence] 1200 units: ${JSON.stringify(rows[0])} ${JSON.stringify(out)}`);
    expect(out.result?.error ?? null).toBeNull();
    expect(Number(rows[0]!.moved), "units NOT at their +10% price").toBe(0);
    expect(Number(rows[0]!.events)).toBe(1200);
    expect(Number(rows[0]!.items)).toBe(1200);
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
