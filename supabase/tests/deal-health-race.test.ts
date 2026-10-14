import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
 * A deal-health recompute writes only over the row it read
 * (T-deal-health-race) — the REAL recomputeDealHealth and the REAL budget
 * save, against the REAL local stack.
 *
 * `deals.health` holds one key a person enters, `budget_confirmed` (saved by
 * updateDealSection's health section), beside the two the recompute derives,
 * `factors` and `computed_at`. The recompute reads the deal, computes, and
 * writes `health: {...whatItRead, factors, computed_at}` with
 * `health_score`. Ten callers run it after their own mutation, so two of them
 * overlap whenever two people work one deal.
 *
 * THE RACE, FORCED — no sleeps, no timing. Each recompute here runs on a
 * client whose fetch can HOLD its first `PATCH /rest/v1/deals` (or its first
 * two) until the test releases it (the gate of deal-close-actions.test.ts and
 * unit-status-actions.test.ts). By the time the PATCH reaches the gate the
 * recompute has READ the deal; the database has not seen the write. Between
 * the two the test changes the flag — through the real budget save
 * (scenario 2) or a direct PATCH as the deal's own agent, with no trailing
 * recompute to tidy up after it (scenarios 3 and 5) — then releases.
 *
 * On the unguarded recompute (489c507) the held PATCH lands last and writes
 * the health object it read before the save: `budget_confirmed` gone for good
 * while the `updated` event says it changed, and a score 25 points short.
 * Scenarios 2 and 3 exist to fail there. With the guard the held PATCH is
 * predicated on the `updated_at` it read, matches nothing, and the recompute
 * reads again and computes FROM the new flag — which is why scenario 3 asserts
 * the score: a guard that merely dropped the stale write would leave the
 * direct PATCH's health_score (0) standing.
 *
 * Scenario 1 pins the other side: an uncontended recompute WRITES — the
 * predicate matches the timestamp exactly as PostgREST serialised it. A
 * predicate that never matched would make every recompute a silent no-op
 * (the unit tests cannot see that; they script the answer). Scenario 4 pins
 * that a listing manager's recompute (deals_update has no listing-manager
 * arm) stays the silent no-op it was: one re-read, no retry, no throw.
 * Scenario 5 pins the bound (HEALTH_WRITE_ATTEMPTS = 2): the row moves under
 * BOTH writes, and the recompute gives up without throwing and without a
 * third attempt — and its retry, computed from a flag that has since turned
 * off, never lands. Giving up leaves the newest row standing; it cannot put
 * an old value back. Scenario 6 pins that the write names the deal as well as
 * the timestamp: two deals stamped by one statement share one now() (as every
 * row of a multi-row UPDATE does), and a write predicated on `updated_at`
 * alone would land one deal's health and score on the other. Every other
 * fixture here is inserted on its own, with its own now(), so no other
 * scenario can tell the two predicates apart; the unit file pins the filter on
 * the write's own builder chain, this pins what it means on the real stack.
 *
 * Nothing below the service is stubbed except the Next.js request plumbing
 * (`createClient` hands updateDealSection a signed-in aal2 client; only
 * `revalidatePath` is a stub). Every deal here has no property and no buyer,
 * so the score is budget (25) + recent activity (30, the fixture's
 * last_activity_at is now()) and the mandate read never runs.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// The action under test (the budget save) gets whichever client is queued.
// ---------------------------------------------------------------------------
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

import { updateDealSection } from "@/lib/actions/deals";
import {
  HEALTH_WEIGHTS,
  recomputeDealHealth,
  type HealthFactor,
} from "@/lib/services/health-score";

// ---------------------------------------------------------------------------
// The probe: a session client that logs its requests on deals and can hold
// its first `holdWrites` PATCHes of deals at the gate, each until released.
// ---------------------------------------------------------------------------
type Gate = { arrived: Promise<void>; arrive: () => void; released: Promise<void>; release: () => void };

function gate(): Gate {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((r) => (arrive = r));
  const released = new Promise<void>((r) => (release = r));
  return { arrived, arrive, released, release };
}

type Probe = {
  client: SupabaseClient;
  /** the method of every PostgREST request on deals, in order */
  deals: string[];
  /** one gate per held PATCH of deals: gates[0] holds the first, gates[1] the second */
  gates: Gate[];
};

const opened: Probe[] = [];

async function probe(user: TestUser, opts: { holdWrites: number }): Promise<Probe> {
  const { data } = await user.client.auth.getSession();
  const session = data.session;
  if (!session) throw new Error(`no session for ${user.email}`);
  const gates = Array.from({ length: opts.holdWrites }, gate);
  let patches = 0;
  const deals: string[] = [];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (/\/rest\/v1\/deals(\?|$)/.test(url)) {
          deals.push(method);
          if (method === "PATCH") {
            const g = gates[patches];
            patches += 1;
            if (g) {
              g.arrive();
              await g.released;
            }
          }
        }
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  const p: Probe = { client, deals, gates };
  opened.push(p);
  return p;
}

/**
 * Which comes first: the recompute's write number `n` (from 0) held at the
 * gate, or the recompute finishing. The losing branch never rejects: a
 * rejection raised after the race has settled would be nobody's, and vitest
 * fails a run on an unhandled one.
 */
async function reached(p: Probe, running: Promise<void>, n: number): Promise<"held" | "finished"> {
  const g = p.gates[n];
  if (!g) throw new Error(`test harness: the probe holds no write number ${n}`);
  return Promise.race([
    g.arrived.then(() => "held" as const),
    running.then(
      () => "finished" as const,
      () => "finished" as const,
    ),
  ]);
}

/** Wait until the recompute's write number `n` is held — or fail if it finished without reaching it. */
async function heldAtTheGate(p: Probe, running: Promise<void>, n = 0): Promise<void> {
  if ((await reached(p, running, n)) !== "held") {
    throw new Error(`the recompute finished without reaching write number ${n}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let agent: TestUser;
let manager: TestUser;
let openStageId: string;
const userIds: string[] = [];
let fixtureN = 0;

/** An open sale deal of the agent's, no property, no buyer, health {} and score 0. */
async function newDeal(): Promise<string> {
  fixtureN += 1;
  const { data, error } = await svc
    .from("deals")
    .insert({
      org_id: ORG,
      deal_type: "sale",
      stage_id: openStageId,
      title: `ZZTEST health race ${RUN} ${fixtureN}`,
      agent_id: agent.id,
      created_by: agent.id,
    })
    .select("id")
    .single();
  if (error) throw new Error(`deal fixture: ${error.message}`);
  return (data as { id: string }).id;
}

/**
 * Two open sale deals of the agent's in ONE insert, so one now() stamps both
 * `updated_at`s — as one multi-row UPDATE does (mergeContacts' repoint of
 * buyer_contact_id). The twin carries a budget flag the target does not, so a
 * write meant for the target that lands on the twin shows.
 */
async function newDealPair(): Promise<{ target: string; twin: string }> {
  fixtureN += 1;
  const title = (role: string) => `ZZTEST health race ${RUN} ${fixtureN} ${role}`;
  const row = (role: string, health: Record<string, unknown>) => ({
    org_id: ORG,
    deal_type: "sale" as const,
    stage_id: openStageId,
    title: title(role),
    agent_id: agent.id,
    created_by: agent.id,
    health,
  });
  const { data, error } = await svc
    .from("deals")
    .insert([row("target", {}), row("twin", { budget_confirmed: true })])
    .select("id, title");
  if (error) throw new Error(`deal pair fixture: ${error.message}`);
  const rows = data as { id: string; title: string }[];
  const idOf = (role: string) => {
    const hit = rows.find((r) => r.title === title(role));
    if (!hit) throw new Error(`deal pair fixture: no ${role} row`);
    return hit.id;
  };
  return { target: idOf("target"), twin: idOf("twin") };
}

type HealthRow = { health: Record<string, unknown>; health_score: number; updated_at: string };

/** What the database holds — read as postgres; updated_at as text keeps its microseconds. */
async function healthRow(id: string): Promise<HealthRow> {
  const { rows } = await pg.query<HealthRow>(
    "select health, health_score, updated_at::text as updated_at from deals where id = $1",
    [id],
  );
  return rows[0]!;
}

const budgetFactor = (row: HealthRow) =>
  ((row.health.factors ?? []) as HealthFactor[]).find((f) => f.key === "budget");

async function updatedEvents(dealId: string) {
  const { rows } = await pg.query<{ payload: Record<string, unknown> }>(
    "select payload from events where org_id = $1 and entity_id = $2 and event_type = 'updated' order by id",
    [ORG, dealId],
  );
  return rows.map((r) => r.payload);
}

/**
 * The deal's own agent PATCHes `health` to just the flag, directly — no
 * trailing recompute, so `health_score` is left as it was. Returns the row.
 */
async function patchFlag(dealId: string, flag: boolean): Promise<HealthRow> {
  const { data, error } = await agent.client
    .from("deals")
    .update({ health: { budget_confirmed: flag } })
    .eq("id", dealId)
    .select("id");
  expect(error).toBeNull();
  expect(data, "the agent's PATCH wrote the row").toHaveLength(1);
  return healthRow(dealId);
}

/** The real budget save, as `user`: updateDealSection(section = 'health'). */
async function saveBudget(user: TestUser, dealId: string, confirmed: boolean) {
  const p = await probe(user, { holdWrites: 0 });
  state.queue.push(p.client);
  const fd = new FormData();
  fd.set("deal_id", dealId);
  fd.set("section", "health");
  if (confirmed) fd.set("budget_confirmed", "on");
  return updateDealSection({ error: null, savedAt: null }, fd);
}

function evidence(label: string, data: Record<string, unknown>) {
  console.log(
    `[evidence] ${label}\n${Object.entries(data)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join("\n")}`,
  );
}

/** budget confirmed (25) + activity within seven days (30) */
const WITH_BUDGET = HEALTH_WEIGHTS.budget + HEALTH_WEIGHTS.activity;
const WITHOUT_BUDGET = HEALTH_WEIGHTS.activity;

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Deal health race ${RUN}`, `deal-health-race-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  agent = await createTestUser(svc, `dhr-agent-${RUN}@test.local`, "agent", ORG);
  manager = await createTestUser(svc, `dhr-lm-${RUN}@test.local`, "listing_manager", ORG);
  userIds.push(agent.id, manager.id);

  const { data: stage, error } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", ORG)
    .eq("deal_type", "sale")
    .eq("sort_order", 1)
    .single();
  if (error || !stage) throw new Error(`stage fixture: ${error?.message ?? "missing"}`);
  openStageId = (stage as { id: string }).id;
});

afterEach(() => {
  // a failed scenario must not leave a write parked at the gate
  for (const p of opened) for (const g of p.gates) g.release();
  opened.length = 0;
  state.queue.length = 0;
});

afterAll(async () => {
  await pg.query("delete from tasks where org_id = $1", [ORG]);
  await pg.query("delete from deals where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await pg.query("delete from profiles where org_id = $1", [ORG]);
  await pg.query("delete from events where org_id = $1", [ORG]);
  await pg.query("delete from events_chain_checkpoint where org_id = $1", [ORG]);
  await pg.query("delete from chain_checks where org_id = $1", [ORG]);
  await pg.query("delete from deal_stages where org_id = $1", [ORG]);
  await pg.query("delete from districts where org_id = $1", [ORG]);
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
});

// ---------------------------------------------------------------------------
describe("a deal-health recompute writes only over the row it read", () => {
  it("1. an uncontended recompute writes, once — the guard matches the timestamp PostgREST served", async () => {
    const dealId = await newDeal();
    const before = await healthRow(dealId);
    const r = await probe(agent, { holdWrites: 0 });

    await expect(recomputeDealHealth(r.client, dealId)).resolves.toBeUndefined();

    const after = await healthRow(dealId);
    evidence("1. uncontended", { requests: r.deals, before: before.health_score, after: after.health_score });
    expect(after.health_score, "activity 30, no budget").toBe(WITHOUT_BUDGET);
    expect(budgetFactor(after)?.points).toBe(0);
    expect(after.health.computed_at, "the snapshot was written").toEqual(expect.any(String));
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(r.deals, "one read, one write — no re-read").toEqual(["GET", "PATCH"]);
  });

  it("2. a recompute that read before the REAL budget save cannot put the old flag back", async () => {
    const dealId = await newDeal();
    const r = await probe(agent, { holdWrites: 1 });
    const running = recomputeDealHealth(r.client, dealId);
    await heldAtTheGate(r, running);

    // the recompute has read budget_confirmed absent; now the person ticks it
    const saved = await saveBudget(agent, dealId, true);
    expect(saved.error, "the budget save itself succeeds").toBeNull();
    const afterSave = await healthRow(dealId);

    r.gates[0]!.release();
    await expect(running, "the recompute never throws into its caller").resolves.toBeUndefined();

    const after = await healthRow(dealId);
    const events = await updatedEvents(dealId);
    evidence("2. real budget save between read and write", {
      requests: r.deals,
      afterSave: { flag: afterSave.health.budget_confirmed, score: afterSave.health_score },
      after: { flag: after.health.budget_confirmed, score: after.health_score, budget: budgetFactor(after) },
      events,
    });
    expect(afterSave.health.budget_confirmed, "the save wrote the flag").toBe(true);
    expect(after.health.budget_confirmed, "and it SURVIVES the held recompute").toBe(true);
    expect(after.health_score, "the score counts it").toBe(WITH_BUDGET);
    expect(budgetFactor(after), "and so does the breakdown every card renders").toMatchObject({
      points: HEALTH_WEIGHTS.budget,
      detail: "confirmed",
    });
    expect(events, "one updated event: the budget save's").toHaveLength(1);
    expect(events[0], "the log says the flag changed — and now the row agrees").toMatchObject({
      section: "health",
      changed: { budget_confirmed: { from: false, to: true } },
    });
    expect(r.deals, "read, the held write (matched nothing), re-read, write").toEqual([
      "GET",
      "PATCH",
      "GET",
      "PATCH",
    ]);
  });

  it("3. with no trailing recompute to tidy up, the held recompute computes FROM the new flag itself", async () => {
    const dealId = await newDeal();
    const r = await probe(agent, { holdWrites: 1 });
    const running = recomputeDealHealth(r.client, dealId);
    await heldAtTheGate(r, running);

    // the deal's own agent PATCHes the flag directly: health_score stays 0
    const patched = await patchFlag(dealId, true);

    r.gates[0]!.release();
    await expect(running).resolves.toBeUndefined();

    const after = await healthRow(dealId);
    evidence("3. direct PATCH between read and write", {
      requests: r.deals,
      patched: { flag: patched.health.budget_confirmed, score: patched.health_score },
      after: { flag: after.health.budget_confirmed, score: after.health_score, budget: budgetFactor(after) },
    });
    expect(patched.health_score, "nothing but the recompute writes a score").toBe(0);
    expect(after.health.budget_confirmed, "the flag survives").toBe(true);
    expect(after.health_score, "a score computed from the NEW flag, by the retry").toBe(WITH_BUDGET);
    expect(budgetFactor(after)).toMatchObject({ points: HEALTH_WEIGHTS.budget, detail: "confirmed" });
    expect(after.updated_at, "the retry wrote the row").not.toBe(patched.updated_at);
    expect(r.deals).toEqual(["GET", "PATCH", "GET", "PATCH"]);
  });

  it("4. a listing manager's recompute (no UPDATE on deals) stays a silent no-op: one re-read, no retry", async () => {
    const dealId = await newDeal();
    // a score on the row first, by someone who may write it
    const seed = await probe(agent, { holdWrites: 0 });
    await recomputeDealHealth(seed.client, dealId);
    const before = await healthRow(dealId);

    const lm = await probe(manager, { holdWrites: 0 });
    await expect(recomputeDealHealth(lm.client, dealId)).resolves.toBeUndefined();

    const after = await healthRow(dealId);
    evidence("4. listing manager", { requests: lm.deals, before: before.updated_at, after: after.updated_at });
    expect(after, "the row is exactly as it was").toEqual(before);
    expect(lm.deals, "read, the refused write, the re-read that found the row unmoved").toEqual([
      "GET",
      "PATCH",
      "GET",
    ]);
  });

  it("5. losing BOTH writes, it gives up: nothing stale lands, nothing throws, no third attempt", async () => {
    const dealId = await newDeal();
    const r = await probe(agent, { holdWrites: 2 });
    const running = recomputeDealHealth(r.client, dealId);
    await heldAtTheGate(r, running, 0);

    // the row moves under the first write: the flag goes on
    const firstMove = await patchFlag(dealId, true);
    r.gates[0]!.release();
    const second = await reached(r, running, 1);
    expect(
      await healthRow(dealId),
      "the first write, predicated on the row it read, matched nothing: the flag just set still stands",
    ).toEqual(firstMove);
    // the re-read saw the flag on, the retry computed 55 from it — and is held in its turn
    expect(second, "the recompute re-read and came back with a retry").toBe("held");

    // the row moves again under the retry: the flag goes off
    const lastMove = await patchFlag(dealId, false);
    r.gates[1]!.release();
    await expect(running, "giving up is not an error its callers would see").resolves.toBeUndefined();

    const after = await healthRow(dealId);
    evidence("5. both writes lost", {
      requests: r.deals,
      lastMove: { flag: lastMove.health.budget_confirmed, score: lastMove.health_score },
      after: { flag: after.health.budget_confirmed, score: after.health_score },
    });
    expect(
      after,
      "the last move stands byte for byte: the retry's 55, computed from a flag since turned off, never landed",
    ).toEqual(lastMove);
    expect(after.health.budget_confirmed).toBe(false);
    expect(after.health_score).toBe(0);
    expect(r.deals, "two attempts, and no third").toEqual(["GET", "PATCH", "GET", "PATCH"]);
  });

  it("6. the write names THIS deal: a deal stamped by the same statement is left byte for byte", async () => {
    const { target, twin } = await newDealPair();
    const targetBefore = await healthRow(target);
    const twinBefore = await healthRow(twin);
    expect(
      twinBefore.updated_at,
      "precondition: one statement, one now() — the two rows share the timestamp the write is predicated on",
    ).toBe(targetBefore.updated_at);

    const r = await probe(agent, { holdWrites: 0 });
    await expect(recomputeDealHealth(r.client, target)).resolves.toBeUndefined();

    const targetAfter = await healthRow(target);
    const twinAfter = await healthRow(twin);
    evidence("6. two deals, one timestamp", {
      requests: r.deals,
      shared: targetBefore.updated_at,
      target: { score: targetAfter.health_score, flag: targetAfter.health.budget_confirmed },
      twin: { score: twinAfter.health_score, flag: twinAfter.health.budget_confirmed },
    });
    expect(targetAfter.health_score, "the target was written: activity 30, no budget").toBe(
      WITHOUT_BUDGET,
    );
    expect(
      twinAfter,
      "the twin is untouched — a write predicated on updated_at alone would have put the target's health (no flag) and score on it",
    ).toEqual(twinBefore);
    expect(r.deals).toEqual(["GET", "PATCH"]);
  });
});

// ---------------------------------------------------------------------------
describe("the chain", () => {
  it("7. verifies for the organisation after everything above", async () => {
    const { rows } = await pg.query("select ok, reason from verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
