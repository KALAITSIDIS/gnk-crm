import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TEST_PASSWORD,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";
import { BODY_MD5_0154, REVERT_0154_SQL, readMigration0154 } from "./revert-0154";

/**
 * 0154 (F06, product review 2026-10-18): the lead-source and stage-conversion
 * reports say what they count.
 *
 *   1. report_source_roi, through PostgREST as aal2 users of a throwaway
 *      organisation: a spam enquiry counts in `leads` and `spam` and in neither
 *      side of `convert_rate`; `converted_visible` and `win_rate` stay within
 *      the caller's deal scope (two agents of one organisation each get their
 *      own rate while the enquiries stay organisation-wide); an admin's and a
 *      listing manager's figures equal the pre-0154 ones where no spam is
 *      involved; another organisation, an aal1 session and anon see nothing.
 *   2. report_stage_conversion: moves made through move_deal_to_stage — the
 *      real writer — give one row per (pipeline, stage id), so a sale and a
 *      rental "Qualified" are two rows; a drag back is `regressed`, not
 *      `advanced`; a reorder re-reads direction (CURRENT order, as the note
 *      says); a rename keeps the row. History-shaped events (written by the
 *      service role, as a pre-0131 session or an import left them): a
 *      name-only move and a deleted stage report under the recorded name and
 *      depart in an unknown direction; the pipeline of such a side is the
 *      deal's when the caller can read the deal, else unknown; a `{}` payload
 *      is malformed; won / lost are counted per pipeline, never attributed.
 *   3. the migration, as postgres in rolled-back transactions: the state
 *      before it (the defects, read as an agent), replay over it, its shape,
 *      the one-transaction guard, preflight refusals, a bounded lock wait,
 *      replay safety, postflight mutants, the rollback, the restore pack's
 *      rows (0154's, and 0130's, which must still hold).
 *
 * At 0149 sections 1 and 2 are RED where the defects live (spam in the rate,
 * a mixed-scope win rate, pipelines merged by name, demotions counted as
 * advancement, `{}` counted as a move) — section 3's "before" test reads them.
 * Fixtures: two throwaway organisations, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let svc: SupabaseClient;
let o: Client; // postgres: fixtures, observation, the migration replays, cleanup
let a: Client; // a second session holding a lock
let admin: TestUser;
let lm: TestUser; // listing manager: every deal, only its own events
let agent1: TestUser;
let agent2: TestUser;
let otherAdmin: TestUser;
const userIds: string[] = [];

type Win = { p_from: string; p_to: string };

/**
 * The lead-source window: February 2023 (leads are not partitioned, so a
 * back-dated window is safe). Not 2024: rls.test.ts test 38 reads March 2024
 * as the service role across EVERY organisation with exact counts, and this
 * file's lead on the window's exclusive end must never land in it, even if a
 * cleanup is cut short.
 */
const LEADS: Win = { p_from: "2023-02-01T00:00:00Z", p_to: "2023-03-01T00:00:00Z" };
/** The window of section 2's moves through move_deal_to_stage (section 3 reads it again). */
let live: Win;

type SourceRow = {
  source: string;
  leads: number;
  spam: number;
  converted: number;
  converted_visible: number;
  won: number;
  won_value: number;
  convert_rate: number | null;
  win_rate: number | null;
};
type StageRow = {
  deal_type: string | null;
  stage_id: string | null;
  stage: string;
  sort_order: number | null;
  entered: number;
  advanced: number;
  regressed: number;
  departed_unknown: number;
  advance_rate: number | null;
};
type Conv = {
  derived_from: string;
  stage_key: string;
  moves_total: number;
  moves_with_ids: number;
  moves_malformed: number;
  stages: StageRow[];
  transitions: Array<{
    deal_type: string | null;
    from: string | null;
    to: string | null;
    from_stage_id: string | null;
    to_stage_id: string | null;
    direction: string | null;
    deals: number;
  }>;
  outcomes: { won: number; lost: number };
  outcomes_by_type: Array<{ deal_type: string | null; won: number; lost: number }>;
  note: string;
};

type PgError = Error & { code?: string };
const failure = (q: Promise<unknown>) =>
  q.then(
    () => null,
    (e: PgError) => e,
  );

async function sources(client: SupabaseClient, win: Win = LEADS): Promise<Record<string, SourceRow>> {
  const { data, error } = await client.rpc("report_source_roi", win);
  expect(error, JSON.stringify(error)).toBeNull();
  expect(Array.isArray(data), "the report is an array of source rows").toBe(true);
  return Object.fromEntries((data as SourceRow[]).map((r) => [r.source, r]));
}

async function stages(client: SupabaseClient, win: Win): Promise<Conv> {
  const { data, error } = await client.rpc("report_stage_conversion", win);
  expect(error, JSON.stringify(error)).toBeNull();
  return data as Conv;
}

/** A stage row through the keys a reader compares (rates as numbers). */
const row = (s: StageRow) => ({
  deal_type: s.deal_type,
  stage_id: s.stage_id,
  stage: s.stage,
  sort_order: s.sort_order,
  entered: s.entered,
  advanced: s.advanced,
  regressed: s.regressed,
  departed_unknown: s.departed_unknown,
  advance_rate: s.advance_rate === null ? null : Number(s.advance_rate),
});

const dbNow = async () => (await o.query<{ t: Date }>("select clock_timestamp() as t")).rows[0]!.t;

async function stageId(org: string, dealType: string, name: string): Promise<string> {
  const { rows } = await o.query<{ id: string }>(
    "select id from deal_stages where org_id = $1 and deal_type = $2 and name = $3",
    [org, dealType, name],
  );
  return rows[0]!.id;
}

/** A deal written as the service role: open by default, or already closed (the guard binds sessions only). */
async function deal(fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await svc
    .from("deals")
    .insert({ org_id: ORG, title: `ZZRD ${RUN}`, ...fields })
    .select("id")
    .single();
  if (error) throw new Error(`deal fixture: ${error.message}`);
  return data.id as string;
}

async function lead(org: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await svc.from("leads").insert({ org_id: org, channel: "email", ...fields });
  if (error) throw new Error(`lead fixture: ${error.message}`);
}

/** Open a transaction on `c` as `uid` — the only way `set local role` holds. */
async function asUser(c: Client, uid: string) {
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
  ]);
}

let S: Record<"new" | "qualified" | "viewing", string>; // ORG's sale stages
let R: Record<"new" | "qualified", string>; // ORG's rental stages

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  a = new Client({ connectionString: DB_URL });
  await o.connect();
  await a.connect();
  await ensureTestOrg(svc, ORG, `Report definitions ${RUN}`, `report-defs-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `Report definitions other ${RUN}`, `report-defs-other-${RUN}`);
  admin = await createTestUser(svc, `rd-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  lm = await createTestUser(svc, `rd-lm-${RUN}@test.local`, "listing_manager", ORG);
  userIds.push(lm.id);
  agent1 = await createTestUser(svc, `rd-agent1-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent1.id);
  agent2 = await createTestUser(svc, `rd-agent2-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent2.id);
  otherAdmin = await createTestUser(svc, `rd-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(otherAdmin.id);
  S = {
    new: await stageId(ORG, "sale", "New"),
    qualified: await stageId(ORG, "sale", "Qualified"),
    viewing: await stageId(ORG, "sale", "Viewing"),
  };
  R = { new: await stageId(ORG, "rental", "New"), qualified: await stageId(ORG, "rental", "Qualified") };
});

afterAll(async () => {
  // Tasks first: the cron sweeps attach them to these fixtures while the file
  // runs (0098's lead-sla, every ten minutes, to the website enquiry nobody
  // answered; 0020's follow-up nudges to an open deal), and tasks.lead_id /
  // tasks.deal_id are NO ACTION — one such task refuses the leads delete and
  // cuts the cleanup short, leaving this file's leads behind (F06 review).
  // Then leads, which hold deals through converted_deal_id.
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from tasks where org_id = $1", [org]);
    await o.query("delete from leads where org_id = $1", [org]);
    await o.query("delete from deals where org_id = $1", [org]);
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
  await a.end();
  await o.end();
});

// ---------------------------------------------------------------------------
// 1. Lead sources
// ---------------------------------------------------------------------------
describe("1. lead sources: spam out of the convert rate, the win rate within the caller's scope", () => {
  beforeAll(async () => {
    const at = (day: number) => `2023-02-${String(day).padStart(2, "0")}T10:00:00Z`;
    // agent1's deals: one won (confirmed 300 000 over a stale estimate), one open
    const a1Won = await deal({
      deal_type: "sale", stage_id: S.new, agent_id: agent1.id, status: "won",
      won_at: at(20), expected_value: 999999, final_value: 300000,
    });
    const a1Open = await deal({ deal_type: "sale", stage_id: S.new, agent_id: agent1.id });
    // agent2's deals: one won rental (a rent, no final value), two lost
    const a2Won = await deal({
      deal_type: "rental", stage_id: R.new, agent_id: agent2.id, status: "won", won_at: at(21), expected_value: 2400,
    });
    const a2Lost1 = await deal({ deal_type: "sale", stage_id: S.new, agent_id: agent2.id, status: "lost", lost_at: at(22) });
    const a2Lost2 = await deal({ deal_type: "sale", stage_id: S.new, agent_id: agent2.id, status: "lost", lost_at: at(23) });
    const contradictory = await deal({ deal_type: "sale", stage_id: S.new, agent_id: agent1.id });

    // website: 8 enquiries — 5 converted (2 to agent1's deals, 3 to agent2's),
    // one open, two spam
    for (const [dealId, day] of [
      [a1Won, 2], [a1Open, 3], [a2Won, 4], [a2Lost1, 5], [a2Lost2, 6],
    ] as const) {
      await lead(ORG, { source: "website", status: "converted", received_at: at(day), converted_deal_id: dealId });
    }
    await lead(ORG, { source: "website", status: "new", received_at: at(7) });
    await lead(ORG, { source: "website", status: "spam", received_at: at(8) });
    await lead(ORG, { source: "website", status: "spam", received_at: at(9) });
    // referral: nothing but spam
    await lead(ORG, { source: "referral", status: "spam", received_at: at(10) });
    // portal: a contradictory row a direct write can leave — marked spam AND
    // linked to a deal — beside one open enquiry
    await lead(ORG, { source: "portal", status: "spam", received_at: at(11), converted_deal_id: contradictory });
    await lead(ORG, { source: "portal", status: "new", received_at: at(12) });
    // another organisation's spam must change nothing here
    await lead(OTHER_ORG, { source: "website", status: "spam", received_at: at(13) });
    // outside the window: must not count
    await lead(ORG, { source: "website", status: "spam", received_at: LEADS.p_to });
  });

  it("an admin: spam is counted, kept out of both sides of the convert rate; the win rate is won / converted", async () => {
    const r = await sources(admin.client);
    expect(r.website).toMatchObject({ leads: 8, spam: 2, converted: 5, converted_visible: 5, won: 2 });
    expect(Number(r.website!.won_value), "300 000 confirmed + a 2 400 rent — the transaction values, added").toBe(302400);
    expect(Number(r.website!.convert_rate), "5 converted of the 6 enquiries that are not spam (0076 read 5/8)").toBeCloseTo(5 / 6, 10);
    expect(Number(r.website!.win_rate), "2 won of 5 converted").toBeCloseTo(0.4, 10);

    expect(r.referral, "a source that produced only spam is KEPT").toMatchObject({ leads: 1, spam: 1, converted: 0, converted_visible: 0, won: 0 });
    expect(r.referral!.convert_rate, "no enquiry that is not spam: no rate, not 0/0").toBeNull();
    expect(r.referral!.win_rate).toBeNull();

    expect(r.portal).toMatchObject({ leads: 2, spam: 1, converted: 1, converted_visible: 1, won: 0 });
    expect(Number(r.portal!.convert_rate), "a spam-marked enquiry is out of the numerator too: the rate stays within 0..1").toBe(0);
    expect(Number(r.portal!.win_rate)).toBe(0);
  });

  it("a listing manager reads every deal, so the same figures as the admin", async () => {
    expect(await sources(lm.client)).toEqual(await sources(admin.client));
  });

  it("two agents: enquiries and conversions stay organisation-wide, Won and the win rate are each agent's own", async () => {
    const one = await sources(agent1.client);
    expect(one.website).toMatchObject({ leads: 8, spam: 2, converted: 5, converted_visible: 2, won: 1 });
    expect(Number(one.website!.won_value)).toBe(300000);
    expect(Number(one.website!.convert_rate), "the inbox is shared: the same rate as the admin's").toBeCloseTo(5 / 6, 10);
    expect(Number(one.website!.win_rate), "1 won of the 2 converted deals agent1 can see (0076 read 1/5)").toBeCloseTo(0.5, 10);

    const two = await sources(agent2.client);
    expect(two.website).toMatchObject({ leads: 8, spam: 2, converted: 5, converted_visible: 3, won: 1 });
    expect(Number(two.website!.won_value)).toBe(2400);
    expect(Number(two.website!.win_rate), "1 won of agent2's 3").toBeCloseTo(1 / 3, 10);
    expect(two.portal, "the contradictory row's deal is agent1's").toMatchObject({ converted: 1, converted_visible: 0 });
    expect(two.portal!.win_rate, "no visible conversion: no win rate").toBeNull();
  });

  it("another organisation sees only its own enquiries; anon and an aal1 session see nothing", async () => {
    const other = await sources(otherAdmin.client);
    expect(Object.keys(other)).toEqual(["website"]);
    expect(other.website).toMatchObject({ leads: 1, spam: 1, converted: 0 });

    const anon = await anonClient().rpc("report_source_roi", LEADS);
    expect(anon.error, "anon has no EXECUTE").not.toBeNull();

    const aal1 = anonClient();
    expect((await aal1.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD })).error).toBeNull();
    const r = await aal1.rpc("report_source_roi", LEADS);
    expect(r.error).toBeNull();
    expect(r.data, "require_aal2 hides every lead").toEqual([]);
  });

  it("the lead-sla sweep's task on the unanswered enquiry changes no figure (and the cleanup removes it before the leads)", async () => {
    const before = await sources(admin.client);
    // what the every-ten-minutes cron does to this file's fixtures, made certain
    // here rather than left to the clock: afterAll must delete tasks first, or
    // tasks_org_lead_fkey refuses the leads delete and the cleanup stops there
    const { error } = await svc.rpc("raise_lead_sla_tasks", { p_org: ORG });
    expect(error, JSON.stringify(error)).toBeNull();
    const { rows } = await o.query<{ n: number }>(
      "select count(*)::int as n from tasks where org_id = $1 and kind = 'lead_unanswered'",
      [ORG],
    );
    expect(rows[0]!.n, "the open website enquiry nobody answered").toBe(1);
    expect(await sources(admin.client)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 2. Stage conversion
// ---------------------------------------------------------------------------
describe("2. stage conversion: per pipeline and stage id, departures by direction", () => {
  let t0: Date;
  let t1: Date;
  let hist: Win;
  let dSale: string;
  let dRent: string;

  it("moves through move_deal_to_stage: sale and rental 'Qualified' are two rows, a drag back is regressed", async () => {
    dSale = await deal({ deal_type: "sale", stage_id: S.new, agent_id: agent1.id });
    dRent = await deal({ deal_type: "rental", stage_id: R.new, agent_id: agent1.id });
    t0 = await dbNow();
    for (const [d, to] of [
      [dSale, S.qualified],
      [dSale, S.viewing],
      [dSale, S.qualified], // dragged back
      [dRent, R.qualified],
    ] as const) {
      const r = await agent1.client.rpc("move_deal_to_stage", { p_deal_id: d, p_stage_id: to });
      expect(r.error, JSON.stringify(r.error)).toBeNull();
    }
    t1 = await dbNow();
    live = { p_from: t0.toISOString(), p_to: t1.toISOString() };

    const c = await stages(admin.client, live);
    expect(c.stage_key).toBe("id");
    expect([c.moves_total, c.moves_with_ids, c.moves_malformed]).toEqual([4, 4, 0]);
    expect(c.stages.map(row)).toEqual([
      { deal_type: "sale", stage_id: S.qualified, stage: "Qualified", sort_order: 2, entered: 1, advanced: 1, regressed: 0, departed_unknown: 0, advance_rate: 1 },
      { deal_type: "sale", stage_id: S.viewing, stage: "Viewing", sort_order: 3, entered: 1, advanced: 0, regressed: 1, departed_unknown: 0, advance_rate: 0 },
      { deal_type: "rental", stage_id: R.qualified, stage: "Qualified", sort_order: 2, entered: 1, advanced: 0, regressed: 0, departed_unknown: 0, advance_rate: 0 },
    ]);
    expect(c.transitions).toEqual([
      { deal_type: "sale", from: "New", to: "Qualified", from_stage_id: S.new, to_stage_id: S.qualified, direction: "forward", deals: 1 },
      { deal_type: "sale", from: "Qualified", to: "Viewing", from_stage_id: S.qualified, to_stage_id: S.viewing, direction: "forward", deals: 1 },
      { deal_type: "sale", from: "Viewing", to: "Qualified", from_stage_id: S.viewing, to_stage_id: S.qualified, direction: "backward", deals: 1 },
      { deal_type: "rental", from: "New", to: "Qualified", from_stage_id: R.new, to_stage_id: R.qualified, direction: "forward", deals: 1 },
    ]);
    expect(c.outcomes).toEqual({ won: 0, lost: 0 });
    expect(c.outcomes_by_type).toEqual([]);
    expect(c.note).toMatch(/CURRENT order/);
    expect(c.note).toMatch(/not attributed to the stage they left/);
  });

  it("who sees the moves: the agent who made them does; a peer agent and the listing manager (own events only) and another organisation do not", async () => {
    const own = await stages(agent1.client, live);
    expect(own.stages.map(row)).toEqual((await stages(admin.client, live)).stages.map(row));
    for (const [who, u] of [["agent2", agent2], ["listing manager", lm], ["other org", otherAdmin]] as const) {
      const c = await stages(u.client, live);
      expect([c.moves_total, c.stages.length, c.transitions.length], who).toEqual([0, 0, 0]);
    }
  });

  it("direction reads the CURRENT order: reordering a pipeline re-reads its history (the note says so)", async () => {
    const swap = async (q: number, v: number) => {
      await o.query("update deal_stages set sort_order = 100 where id = $1", [S.viewing]);
      await o.query("update deal_stages set sort_order = $2 where id = $1", [S.qualified, q]);
      await o.query("update deal_stages set sort_order = $2 where id = $1", [S.viewing, v]);
    };
    await swap(3, 2);
    try {
      const c = await stages(admin.client, live);
      expect(c.stages.filter((s) => s.deal_type === "sale").map((s) => [s.stage, s.sort_order, s.advanced, s.regressed])).toEqual([
        ["Viewing", 2, 1, 0],
        ["Qualified", 3, 0, 1],
      ]);
    } finally {
      await swap(2, 3);
    }
  });

  it("a rename keeps the row: same stage id, the current name", async () => {
    await o.query("update deal_stages set name = 'Qualified (renamed)' where id = $1", [S.qualified]);
    try {
      const c = await stages(admin.client, live);
      expect(c.stages.find((s) => s.stage_id === S.qualified)?.stage).toBe("Qualified (renamed)");
      expect(c.stages.filter((s) => s.stage === "Qualified").map((s) => s.deal_type), "the rental stage keeps its name").toEqual(["rental"]);
    } finally {
      await o.query("update deal_stages set name = 'Qualified' where id = $1", [S.qualified]);
    }
  });

  it("history-shaped events: a recorded name and a deleted stage depart in an unknown direction; `{}` is malformed; closes counted per pipeline", async () => {
    // agent2's deals — agent1 wrote the events but cannot read these deals
    const dHist = await deal({ deal_type: "sale", stage_id: S.new, agent_id: agent2.id });
    const dWon = await deal({ deal_type: "sale", stage_id: S.new, agent_id: agent2.id, status: "won", won_at: new Date().toISOString() });
    const dLost = await deal({ deal_type: "rental", stage_id: R.new, agent_id: agent2.id, status: "lost", lost_at: new Date().toISOString() });
    const gone = randomUUID();
    const from = await dbNow();
    const ev = (entityId: string, eventType: string, payload: unknown) => ({
      org_id: ORG, actor_id: agent1.id, entity_type: "deal", entity_id: entityId, event_type: eventType, payload,
    });
    // one row per request, so each takes its own occurred_at in order
    for (const e of [
      ev(dHist, "stage_changed", { from: "OLD-A", to: "OLD-B" }), // pre-0067: names only
      ev(dHist, "stage_changed", { from: "OLD-B", to: "Qualified", to_stage_id: S.qualified }),
      ev(dHist, "stage_changed", { from: "Qualified", to: "GONE", from_stage_id: S.qualified, to_stage_id: gone }), // a deleted stage
      ev(dHist, "stage_changed", {}), // names no stage at all
      ev(dWon, "won", { stage: "Completed" }),
      ev(dLost, "lost", { stage: "Lost" }),
      ev(randomUUID(), "won", { stage: "Completed" }), // a deal nobody can read
    ]) {
      const { error } = await svc.from("events").insert(e);
      expect(error, JSON.stringify(error)).toBeNull();
    }
    hist = { p_from: from.toISOString(), p_to: new Date(Date.now() + 60 * 60 * 1000).toISOString() };

    const c = await stages(admin.client, hist);
    expect([c.moves_total, c.moves_with_ids, c.moves_malformed], "the `{}` move is malformed, not a null → null move").toEqual([3, 2, 1]);
    expect(c.stages.map(row)).toEqual([
      { deal_type: "sale", stage_id: S.qualified, stage: "Qualified", sort_order: 2, entered: 1, advanced: 0, regressed: 0, departed_unknown: 1, advance_rate: 0 },
      // no current stage: the recorded name, in the deal's pipeline (the admin reads the deal)
      { deal_type: "sale", stage_id: null, stage: "GONE", sort_order: null, entered: 1, advanced: 0, regressed: 0, departed_unknown: 0, advance_rate: 0 },
      { deal_type: "sale", stage_id: null, stage: "OLD-B", sort_order: null, entered: 1, advanced: 0, regressed: 0, departed_unknown: 1, advance_rate: 0 },
    ]);
    expect(c.transitions.every((t) => t.direction === null), "no move here has two current stages").toBe(true);
    expect(c.outcomes).toEqual({ won: 2, lost: 1 });
    expect(c.outcomes_by_type).toEqual([
      { deal_type: "sale", won: 1, lost: 0 },
      { deal_type: "rental", won: 0, lost: 1 },
      { deal_type: null, won: 1, lost: 0 },
    ]);

    // agent1 wrote these events but cannot read agent2's deals: an id-backed
    // side keeps its stage's pipeline, a name-only side's pipeline is unknown
    const mine = await stages(agent1.client, hist);
    expect(mine.stages.map((s) => [s.deal_type, s.stage_id, s.stage, s.entered, s.departed_unknown])).toEqual([
      ["sale", S.qualified, "Qualified", 1, 1],
      [null, null, "GONE", 1, 0],
      [null, null, "OLD-B", 1, 1],
    ]);
    expect(mine.outcomes_by_type).toEqual([{ deal_type: null, won: 2, lost: 1 }]);
    expect((await stages(agent2.client, hist)).moves_total, "agent2 reads none of agent1's events").toBe(0);
  });

  it("anon may not call it; reading changes no event and the chain still verifies", async () => {
    expect((await anonClient().rpc("report_stage_conversion", live)).error).not.toBeNull();
    expect((await o.query("select public.verify_events_chain($1) as ok", [ORG])).rows[0].ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The migration
// ---------------------------------------------------------------------------
describe("3. the migration", () => {
  /** Run `body` in a transaction on `o` that is always ROLLED BACK; collects the NOTICEs it raises. */
  async function rolledBack(body: (notices: string[]) => Promise<void>) {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => {
      if (m.message) notices.push(m.message);
    };
    o.on("notice", onNotice);
    await o.query("begin");
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
  const bodyMd5 = async (fn: string) =>
    (
      await o.query<{ md5: string }>(`select md5(replace(prosrc, chr(13), '')) as md5 from pg_proc where oid = to_regprocedure($1)`, [
        `public.${fn}(timestamptz, timestamptz)`,
      ])
    ).rows[0]!.md5;
  const bodies = async () => [await bodyMd5("report_source_roi"), await bodyMd5("report_stage_conversion")];
  const BEFORE = [BODY_MD5_0154.report_source_roi.before, BODY_MD5_0154.report_stage_conversion.before];
  const AFTER = [BODY_MD5_0154.report_source_roi.after, BODY_MD5_0154.report_stage_conversion.after];

  it("this database holds 0154's bodies", async () => {
    expect(await bodies()).toEqual(AFTER);
  });

  it("the state before it, read as agent1: spam in the convert rate, a mixed-scope win rate, pipelines merged by name, a drag back counted as advancement", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0154_SQL);
      expect(await bodies()).toEqual(BEFORE);
      await asUser(o, agent1.id);
      const roi = (await o.query<{ r: SourceRow[] }>("select public.report_source_roi($1, $2) as r", [LEADS.p_from, LEADS.p_to])).rows[0]!.r;
      const web = roi.find((r) => r.source === "website")!;
      expect(web.spam, "no spam key").toBeUndefined();
      expect(Number(web.convert_rate), "5 of 8, spam included").toBeCloseTo(5 / 8, 10);
      expect(Number(web.win_rate), "agent1's 1 won over the agency's 5 conversions").toBeCloseTo(0.2, 10);
      const conv = (await o.query<{ r: Conv }>("select public.report_stage_conversion($1, $2) as r", [live.p_from, live.p_to])).rows[0]!.r;
      expect(conv.stage_key).toBe("name");
      expect(conv.stages.map((s) => [s.stage, s.entered, s.advanced])).toEqual([
        ["Qualified", 2, 1], // sale AND rental, one row
        ["Viewing", 1, 1], // the drag back to Qualified, as "advanced"
      ]);
    });
  });

  it("replays over the state before it: preflight and postflight pass, the bodies are 0154's, the digests as its last row", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0154_SQL);
      const out = lastRow(await o.query(readMigration0154()));
      expect(out).toEqual({ report_bodies: `report_source_roi=${AFTER[0]} report_stage_conversion=${AFTER[1]}` });
      expect(await bodies()).toEqual(AFTER);
      expect(notices.some((m) => m.startsWith("0154: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0154: postflight passed"))).toBe(true);
    });
    // the probe's organisation did not survive
    const { rows } = await o.query("select count(*)::int as n from organizations where name = '0154 postflight probe'");
    expect(rows[0].n).toBe(0);
  });

  it("its shape: every abort precedes the first replacement, no begin/commit, no table write outside the rolled-back probe", () => {
    const code = readMigration0154().replace(/--[^\n]*/g, "");
    const firstDdl = code.search(/\bcreate or replace function\b/i);
    expect(firstDdl).toBeGreaterThan(0);
    const aborts = [...code.matchAll(/raise exception '0154 aborted/g)].map((m) => m.index!);
    expect(aborts.length).toBeGreaterThanOrEqual(6);
    for (const at of aborts) expect(at).toBeLessThan(firstDdl);
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(code).not.toMatch(/\b(update\s+public\.|delete\s+from|truncate|alter\s+table|drop\s+)/i);
    // every insert sits inside the probe block, which always ends in the undo sentinel
    const probe = code.indexOf("insert into public.organizations");
    const undo = code.indexOf("message = '0154-postflight-undo'");
    expect(probe).toBeGreaterThan(firstDdl);
    for (const m of code.matchAll(/insert into /g)) {
      expect(m.index!).toBeGreaterThanOrEqual(probe);
      expect(m.index!).toBeLessThan(undo);
    }
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0154();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/^0154 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  const refusals: Array<[string, string, RegExp]> = [
    [
      "a report_source_roi body it was not written against",
      `create or replace function public.report_source_roi(p_from timestamptz, p_to timestamptz)
       returns jsonb language sql stable security invoker set search_path = public as $fn$ select '[]'::jsonb $fn$`,
      /^0154 aborted: the body of public\.report_source_roi\(timestamptz, timestamptz\) is not 0076's \(md5 [0-9a-f]{32}\) — read it before replacing it; nothing was changed$/,
    ],
    [
      "a report_stage_conversion body it was not written against",
      `create or replace function public.report_stage_conversion(p_from timestamptz, p_to timestamptz)
       returns jsonb language sql stable security invoker set search_path = public as $fn$ select '{}'::jsonb $fn$`,
      /^0154 aborted: the body of public\.report_stage_conversion\(timestamptz, timestamptz\) is not 0130's/,
    ],
    [
      "a second overload",
      `create function public.report_stage_conversion(p_from date, p_to date)
       returns jsonb language sql stable as $fn$ select '{}'::jsonb $fn$`,
      /^0154 aborted: public\.report_stage_conversion is not exactly one function/,
    ],
    [
      "a SECURITY DEFINER report",
      "alter function public.report_source_roi(timestamptz, timestamptz) security definer",
      /^0154 aborted: public\.report_source_roi\(timestamptz, timestamptz\) is not the jsonb SECURITY INVOKER STABLE function/,
    ],
    [
      "a VOLATILE report",
      "alter function public.report_stage_conversion(timestamptz, timestamptz) volatile",
      /^0154 aborted: public\.report_stage_conversion\(timestamptz, timestamptz\) is not the jsonb SECURITY INVOKER STABLE function/,
    ],
    [
      "another search_path",
      "alter function public.report_source_roi(timestamptz, timestamptz) set search_path = public, pg_temp",
      /^0154 aborted: public\.report_source_roi\(timestamptz, timestamptz\) is not the jsonb SECURITY INVOKER STABLE function/,
    ],
    [
      "a report anon may call",
      "grant execute on function public.report_stage_conversion(timestamptz, timestamptz) to anon",
      /^0154 aborted: the grants on public\.report_stage_conversion\(timestamptz, timestamptz\) are not authenticated \+ service_role without anon/,
    ],
    [
      "a report authenticated may not call",
      "revoke execute on function public.report_source_roi(timestamptz, timestamptz) from authenticated",
      /^0154 aborted: the grants on public\.report_source_roi\(timestamptz, timestamptz\) are not authenticated \+ service_role without anon/,
    ],
  ];
  for (const [label, setup, refusal] of refusals) {
    it(`the preflight refuses ${label}, changing nothing`, async () => {
      await rolledBack(async () => {
        await o.query(REVERT_0154_SQL);
        await o.query(setup);
        const planted = await bodies();
        await o.query("savepoint before_0154");
        const e = await failure(o.query(readMigration0154()));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0154");
        expect(await bodies()).toEqual(planted);
      });
    });
  }

  it("an uncommitted edit of a report function makes it wait at most lock_timeout, then abort (55P03), changing nothing", async () => {
    await a.query("begin");
    // an uncommitted rewrite of the function's catalog row (attributes unchanged)
    await a.query("alter function public.report_source_roi(timestamptz, timestamptz) stable");
    try {
      await rolledBack(async () => {
        const t = Date.now();
        const e = await failure(o.query(readMigration0154()));
        const waited = Date.now() - t;
        expect(e?.code, e?.message).toBe("55P03");
        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(15_000);
      });
    } finally {
      await a.query("rollback");
    }
    expect(await bodies()).toEqual(AFTER);
  });

  it("is replay-safe: run twice in one transaction, the same bodies, one overload each", async () => {
    await rolledBack(async () => {
      await o.query(readMigration0154());
      await o.query(readMigration0154());
      expect(await bodies()).toEqual(AFTER);
      const { rows } = await o.query<{ proname: string; n: number }>(
        `select proname, count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace
            and proname in ('report_source_roi', 'report_stage_conversion') group by 1 order by 1`,
      );
      expect(rows).toEqual([
        { proname: "report_source_roi", n: 1 },
        { proname: "report_stage_conversion", n: 1 },
      ]);
    });
  });

  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "spam back in the convert rate",
      (s) =>
        s.replace(
          /case when leads - spam > 0\s+then converted_not_spam::numeric \/ \(leads - spam\) end/,
          () => "case when leads > 0 then converted::numeric / leads end",
        ),
      /^0154 postflight: report_source_roi does not keep spam out of the convert rate/,
    ],
    [
      "a drag back counted as forward",
      (s) => s.replace("st.sort_order < sf.sort_order then 'backward'", () => "st.sort_order < sf.sort_order then 'forward'"),
      /^0154 postflight: report_stage_conversion does not split pipelines and directions/,
    ],
    [
      "stage rows that do not name their pipeline",
      (s) => s.replace("'deal_type',        s.deal_type,", () => "'deal_type',        null,"),
      /^0154 postflight: report_stage_conversion does not split pipelines and directions/,
    ],
    [
      "departures without an in-window entry (no cohort)",
      (s) => s.replace(/and exists \(\n\s+select 1 from moves e\n[\s\S]*?and e\.to_type is not distinct from m\.from_type\)/, () => "and true"),
      /^0154 postflight: report_stage_conversion does not split pipelines and directions/,
    ],
    [
      "a `{}` payload counted as a move",
      (s) =>
        s.replace(
          /\n\s+or \(k\.from_kind = 'none' and k\.to_kind = 'none'\n\s+and coalesce\(k\.from_name, ''\) = '' and coalesce\(k\.to_name, ''\) = ''\)\)/,
          () => ")",
        ),
      /^0154 postflight: report_stage_conversion's keys are not this file's/,
    ],
    [
      "an unguarded uuid cast",
      (s) =>
        s.replace(
          "case when c.to_kind   = 'id' then (c.to_raw   #>> '{}')::uuid end as to_id",
          () => "nullif(c.to_raw #>> '{}', '')::uuid as to_id",
        ),
      /^0154 postflight: report_stage_conversion's uuid casts are not exactly the two guarded ones$/,
    ],
    [
      "a body that behaves but is not the text this file pins",
      (s) => s.replace("-- 0154: enquiries marked spam; still counted in `leads`, never in a rate", () => "-- spam"),
      /^0154 postflight: public\.report_source_roi\(timestamptz, timestamptz\) is not the function this file wrote/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`the postflight refuses ${label}`, async () => {
      const sql = readMigration0154();
      const bad = mutate(sql);
      expect(bad, "the mutation installed").not.toBe(sql);
      await rolledBack(async () => {
        await o.query(REVERT_0154_SQL);
        await o.query("savepoint before_0154");
        const e = await failure(o.query(bad));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0154");
        expect(await bodies()).toEqual(BEFORE);
      });
    });
  }

  it("the postflight will not probe as a role that RLS binds (its figures would be someone's view, not the probe's)", async () => {
    const sql = readMigration0154();
    const post = sql.indexOf("-- 3. Postflight");
    const doStart = sql.indexOf("do $$", post);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    const postflight = sql.slice(doStart, doEnd);
    expect(postflight.indexOf("r.rolsuper or r.rolbypassrls"), "the guard comes before any write").toBeLessThan(
      postflight.indexOf("insert into public.organizations"),
    );
    await rolledBack(async () => {
      await o.query("set local role authenticated");
      const e = await failure(o.query(postflight));
      expect(e?.message ?? "(it ran)").toMatch(/^0154 postflight: run this file as a role that bypasses RLS \(postgres\) .* \(running as authenticated\)$/);
    });
  });

  it("the rollback recipe leaves 0130's / 0076's state: the bodies back, grants and attributes unchanged", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0154_SQL);
      expect(await bodies()).toEqual(BEFORE);
      const { rows } = await o.query(`
        select p.proname, p.prosecdef, p.provolatile, p.proconfig, pg_get_function_result(p.oid) as result,
               has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('authenticated', p.oid, 'execute') as authed,
               has_function_privilege('service_role', p.oid, 'execute') as svc
          from pg_proc p where p.oid in (to_regprocedure('public.report_source_roi(timestamptz, timestamptz)'),
                                         to_regprocedure('public.report_stage_conversion(timestamptz, timestamptz)'))
         order by 1`);
      for (const r of rows) {
        expect(r, r.proname).toMatchObject({
          prosecdef: false, provolatile: "s", proconfig: ["search_path=public"], result: "jsonb", anon: false, authed: true, svc: true,
        });
      }
    });
  });

  it("the restore pack's 0154 row passes now and reads a restored old body as drift; its 0130 row still holds", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const rowOf = (start: string) => {
      const from = pack.indexOf(start);
      expect(from, `the pack carries "${start}"`).toBeGreaterThan(0);
      return `select * from (${pack.slice(from, pack.indexOf("\n  union all\n", from))}) r(check_name, expected, actual)`;
    };
    const row0154 = rowOf("  select 'HONESTY: lead sources keep spam out of the convert rate");
    const row0130 = rowOf("  select 'HONESTY: report_stage_conversion guards its uuid casts");
    const read = async (q: string) => (await o.query<{ expected: string; actual: string }>(q)).rows[0]!;

    const now = await read(row0154);
    expect(now.expected).toBe("true true");
    expect(now.actual).toBe(now.expected);
    expect((await read(row0130)).actual).toBe("true");

    await rolledBack(async () => {
      await o.query(REVERT_0154_SQL);
      expect((await read(row0154)).actual).toBe("false false");
      expect((await read(row0130)).actual, "0130's body still holds its own row").toBe("true");
    });
    // a weakened source body, alone: spam back in the rate
    await rolledBack(async () => {
      const sql = readMigration0154();
      const start = sql.indexOf("create or replace function public.report_source_roi");
      const end = sql.indexOf("comment on function public.report_source_roi");
      await o.query(
        sql
          .slice(start, end)
          .replace(/case when leads - spam > 0\s+then converted_not_spam::numeric \/ \(leads - spam\) end/, () => "case when leads > 0 then converted::numeric / leads end"),
      );
      expect((await read(row0154)).actual).toBe("false true");
    });
  });
});
