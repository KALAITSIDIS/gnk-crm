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
 * client whose fetch can HOLD its first `PATCH /rest/v1/deals` until the test
 * releases it (the gate of deal-close-actions.test.ts and
 * unit-status-actions.test.ts). By the time the PATCH reaches the gate the
 * recompute has READ the deal; the database has not seen the write. Between
 * the two the test changes the flag — through the real budget save
 * (scenario 2) or a direct PATCH as the deal's own agent, with no trailing
 * recompute to tidy up after it (scenario 3) — then releases.
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
// its FIRST PATCH of deals at the gate until released.
// ---------------------------------------------------------------------------
type Probe = {
  client: SupabaseClient;
  /** the method of every PostgREST request on deals, in order */
  deals: string[];
  /** resolves when the first PATCH of deals is held at the gate */
  arrived: Promise<void>;
  /** lets the held PATCH go on to the database */
  release: () => void;
};

const opened: Probe[] = [];

async function probe(user: TestUser, opts: { holdFirstWrite: boolean }): Promise<Probe> {
  const { data } = await user.client.auth.getSession();
  const session = data.session;
  if (!session) throw new Error(`no session for ${user.email}`);
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((r) => (arrive = r));
  const released = new Promise<void>((r) => (release = r));
  let holding = opts.holdFirstWrite;
  const deals: string[] = [];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (/\/rest\/v1\/deals(\?|$)/.test(url)) {
          deals.push(method);
          if (method === "PATCH" && holding) {
            holding = false;
            arrive();
            await released;
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
  const p: Probe = { client, deals, arrived, release };
  opened.push(p);
  return p;
}

/**
 * Wait until the recompute's write is held — or fail if it finished without
 * writing. The losing branch never rejects: a rejection raised after the race
 * has settled would be nobody's, and vitest fails a run on an unhandled one.
 */
async function heldAtTheGate(p: Probe, running: Promise<void>): Promise<void> {
  const first = await Promise.race([
    p.arrived.then(() => "held" as const),
    running.then(
      () => "finished" as const,
      () => "finished" as const,
    ),
  ]);
  if (first !== "held") throw new Error("the recompute finished without reaching its write");
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

/** The real budget save, as `user`: updateDealSection(section = 'health'). */
async function saveBudget(user: TestUser, dealId: string, confirmed: boolean) {
  const p = await probe(user, { holdFirstWrite: false });
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
  for (const p of opened) p.release();
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
    const r = await probe(agent, { holdFirstWrite: false });

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
    const r = await probe(agent, { holdFirstWrite: true });
    const running = recomputeDealHealth(r.client, dealId);
    await heldAtTheGate(r, running);

    // the recompute has read budget_confirmed absent; now the person ticks it
    const saved = await saveBudget(agent, dealId, true);
    expect(saved.error, "the budget save itself succeeds").toBeNull();
    const afterSave = await healthRow(dealId);

    r.release();
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
    const r = await probe(agent, { holdFirstWrite: true });
    const running = recomputeDealHealth(r.client, dealId);
    await heldAtTheGate(r, running);

    // the deal's own agent PATCHes the flag directly: health_score stays 0
    const { data: patchedRows, error } = await agent.client
      .from("deals")
      .update({ health: { budget_confirmed: true } })
      .eq("id", dealId)
      .select("id");
    expect(error).toBeNull();
    expect(patchedRows, "the agent's PATCH wrote the row").toHaveLength(1);
    const patched = await healthRow(dealId);

    r.release();
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
    const seed = await probe(agent, { holdFirstWrite: false });
    await recomputeDealHealth(seed.client, dealId);
    const before = await healthRow(dealId);

    const lm = await probe(manager, { holdFirstWrite: false });
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
});

// ---------------------------------------------------------------------------
describe("the chain", () => {
  it("5. verifies for the organisation after everything above", async () => {
    const { rows } = await pg.query("select ok, reason from verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
