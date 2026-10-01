import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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

/**
 * One malformed `stage_changed` payload must not take the stage-conversion
 * report down (T-stage-conversion-malformed, migration 0130).
 *
 * `report_stage_conversion` (0076) cast `payload->>'from_stage_id'` and
 * `'to_stage_id'` straight to uuid. `events_insert` never checked payloads, so
 * any aal2 session could POST a `stage_changed` with `to_stage_id: "x"`, and
 * every window containing it — for every caller who can SEE that event — raised
 * 22P02: the page painted an empty section, the CSV export 500'd, permanently
 * (the chain is append-only). Now a present, non-empty stage id that is not a
 * uuid makes the whole movement MALFORMED: it is left out of every figure
 * (never rescued by its recorded name) and counted in `moves_malformed`.
 *
 * The invariant this file pins: every event the 0076 body reported, it still
 * reports identically; only the events that made it raise are now excluded
 * and counted.
 *
 * Fixtures: two throwaway organisations, aal2 sessions through PostgREST,
 * deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);

let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser; // writes every session event in ORG
let peer: TestUser; // same organisation, sees only its own events
let otherAdmin: TestUser;
const userIds: string[] = [];

type Stage = { id: string; name: string };
let sNew: Stage;
let sQualified: Stage;
let sViewing: Stage;
let otherStage: Stage;

type Conv = {
  derived_from: string;
  stage_key: string;
  moves_total: number;
  moves_with_ids: number;
  moves_malformed: number;
  stages: Array<{ stage: string; entered: number; advanced: number; advance_rate: number | null }>;
  transitions: Array<{ from: string | null; to: string | null; deals: number }>;
  outcomes: { won: number; lost: number };
  note: string;
};

type Win = { p_from: string; p_to: string };

async function report(client: SupabaseClient, win: Win) {
  const { data, error } = await client.rpc("report_stage_conversion", win);
  return { conv: data as unknown as Conv | null, error };
}

/** A report that must succeed. */
async function ok(client: SupabaseClient, win: Win, who: string): Promise<Conv> {
  const { conv, error } = await report(client, win);
  expect(error, `${who}: ${JSON.stringify(error)}`).toBeNull();
  return conv!;
}

/** The figures a malformed event must not move. */
const figures = (c: Conv) => ({
  stages: c.stages,
  transitions: c.transitions,
  outcomes: c.outcomes,
  moves_total: c.moves_total,
  moves_with_ids: c.moves_with_ids,
});

async function stageOf(org: string, name: string): Promise<Stage> {
  const { rows } = await pg.query(
    "select id, name from deal_stages where org_id = $1 and deal_type = 'sale' and name = $2",
    [org, name],
  );
  return rows[0] as Stage;
}

async function newDeal(org: string, stage: string, agentId: string): Promise<string> {
  const { data, error } = await svc
    .from("deals")
    .insert({ org_id: org, deal_type: "sale", stage_id: stage, title: `ZZSC ${RUN}`, agent_id: agentId, created_by: agentId })
    .select("id")
    .single();
  if (error) throw new Error(`deal fixture: ${error.message}`);
  return data.id as string;
}

/** A session's direct POST — the write path events_insert permits for any payload. */
function post(user: TestUser, dealId: string, payload: Record<string, unknown>) {
  return user.client
    .from("events")
    .insert({ org_id: ORG, actor_id: user.id, entity_type: "deal", entity_id: dealId, event_type: "stage_changed", payload })
    .select("id")
    .single();
}

/** The database's clock — window edges must come from the clock that stamps occurred_at. */
const dbNow = async () => (await pg.query("select clock_timestamp() as t")).rows[0].t as Date;

/** md5 over every event of an organisation — id, hash and payload — in chain order. */
const eventsDigest = async (org: string) =>
  (
    await pg.query(
      "select md5(coalesce(string_agg(id::text || ':' || coalesce(hash, '') || ':' || payload::text, '|' order by id), '')) as d from events where org_id = $1",
      [org],
    )
  ).rows[0].d as string;

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Stage conv ${RUN}`, `stage-conv-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `Stage conv other ${RUN}`, `stage-conv-other-${RUN}`);
  admin = await createTestUser(svc, `sc-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `sc-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  peer = await createTestUser(svc, `sc-peer-${RUN}@test.local`, "agent", ORG);
  userIds.push(peer.id);
  otherAdmin = await createTestUser(svc, `sc-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(otherAdmin.id);
  sNew = await stageOf(ORG, "New");
  sQualified = await stageOf(ORG, "Qualified");
  sViewing = await stageOf(ORG, "Viewing");
  otherStage = await stageOf(OTHER_ORG, "Qualified");
});

afterAll(async () => {
  await pg.query("delete from deals where org_id = any($1)", [[ORG, OTHER_ORG]]);
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

describe("a malformed stage_changed written by a session, through the real write paths", () => {
  let t0: Date;
  let tMid: Date;
  let live: Win;
  const baseline: Record<string, Conv> = {};
  let dealC: string;

  it("baseline: valid moves through move_deal_to_stage report exactly", async () => {
    t0 = await dbNow();
    const dealA = await newDeal(ORG, sNew.id, agent.id);
    const dealB = await newDeal(ORG, sNew.id, agent.id);
    dealC = await newDeal(ORG, sNew.id, agent.id);
    for (const [deal, to] of [
      [dealA, sQualified.id],
      [dealA, sViewing.id],
      [dealB, sQualified.id],
    ] as const) {
      const r = await agent.client.rpc("move_deal_to_stage", { p_deal_id: deal, p_stage_id: to });
      expect(r.error, JSON.stringify(r.error)).toBeNull();
    }
    // the other organisation has its own movement
    const otherAgent = await createTestUser(svc, `sc-other-agent-${RUN}@test.local`, "agent", OTHER_ORG);
    userIds.push(otherAgent.id);
    const otherNew = await stageOf(OTHER_ORG, "New");
    const otherDeal = await newDeal(OTHER_ORG, otherNew.id, otherAgent.id);
    expect((await otherAgent.client.rpc("move_deal_to_stage", { p_deal_id: otherDeal, p_stage_id: otherStage.id })).error).toBeNull();
    tMid = await dbNow();
    live = { p_from: t0.toISOString(), p_to: new Date(Date.now() + 60 * 60 * 1000).toISOString() };

    const conv = await ok(admin.client, live, "admin");
    expect(conv.moves_total).toBe(3);
    expect(conv.moves_with_ids).toBe(3);
    expect(conv.moves_malformed).toBe(0);
    expect(conv.stages).toEqual([
      { stage: "Qualified", entered: 2, advanced: 1, advance_rate: 0.5 },
      { stage: "Viewing", entered: 1, advanced: 0, advance_rate: 0 },
      // New was only departed, never entered in-window: no row (0076's cohort)
    ]);
    expect(conv.transitions).toEqual([
      { from: "New", to: "Qualified", deals: 2 },
      { from: "Qualified", to: "Viewing", deals: 1 },
    ]);
    for (const [who, c] of [
      ["admin", admin],
      ["agent", agent],
      ["peer", peer],
      ["otherAdmin", otherAdmin],
    ] as const) {
      baseline[who] = await ok(c.client, live, who);
    }
    expect(baseline.agent.moves_total, "the agent sees its own three moves").toBe(3);
    expect(baseline.peer.moves_total, "a peer agent sees none of them").toBe(0);
    expect(baseline.otherAdmin.moves_total, "the other organisation sees only its own").toBe(1);
  });

  it("events_insert still accepts a session's malformed payload — the reader is what must cope", async () => {
    const bad = await post(agent, dealC, {
      from: "New",
      to: "Qualified",
      from_stage_id: sNew.id,
      to_stage_id: "x",
    });
    expect(bad.error, JSON.stringify(bad.error)).toBeNull();
  });

  it("the writer's and its admin's reports still succeed, figures unchanged, the exclusion counted", async () => {
    for (const who of ["admin", "agent"] as const) {
      const c = who === "admin" ? admin : agent;
      const conv = await ok(c.client, live, who);
      expect(figures(conv), `${who}: the malformed move is not rescued by its recorded name`).toEqual(
        figures(baseline[who]),
      );
      expect(conv.moves_malformed, who).toBe(1);
    }
  });

  it("a malformed from_stage_id is excluded the same way, and counted per record", async () => {
    const bad = await post(agent, dealC, {
      from: "Qualified",
      to: "Viewing",
      from_stage_id: "not-a-uuid",
      to_stage_id: sViewing.id,
    });
    expect(bad.error, JSON.stringify(bad.error)).toBeNull();
    for (const who of ["admin", "agent"] as const) {
      const conv = await ok((who === "admin" ? admin : agent).client, live, who);
      expect(figures(conv), who).toEqual(figures(baseline[who]));
      expect(conv.moves_malformed, who).toBe(2);
    }
  });

  it("visibility decides who is affected: a peer agent and another organisation see nothing change", async () => {
    const p = await ok(peer.client, live, "peer");
    expect(p).toEqual(baseline.peer);
    expect(p.moves_malformed).toBe(0);
    const o = await ok(otherAdmin.client, live, "otherAdmin");
    expect(o).toEqual(baseline.otherAdmin);
    expect(o.moves_malformed).toBe(0);
  });

  it("the window decides too: before the malformed writes nothing is excluded; after them, nothing valid remains", async () => {
    const before = await ok(admin.client, { p_from: t0.toISOString(), p_to: tMid.toISOString() }, "before");
    expect(figures(before)).toEqual(figures(baseline.admin));
    expect(before.moves_malformed).toBe(0);

    const after = await ok(admin.client, { p_from: tMid.toISOString(), p_to: live.p_to }, "after");
    expect(after.moves_malformed, "an all-malformed window says so").toBe(2);
    expect(after.moves_total).toBe(0);
    expect(after.moves_with_ids).toBe(0);
    expect(after.stages).toEqual([]);
    expect(after.transitions).toEqual([]);
  });

  it("an aal1 session still reads nothing and writes nothing (require_aal2 unchanged)", async () => {
    const aal1 = anonClient();
    const { error: signInErr } = await aal1.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD });
    expect(signInErr).toBeNull();
    const conv = await ok(aal1, live, "aal1 admin");
    expect(conv.moves_total).toBe(0);
    expect(conv.moves_malformed).toBe(0);
    expect(conv.stages).toEqual([]);
    const write = await aal1
      .from("events")
      .insert({ org_id: ORG, actor_id: admin.id, entity_type: "deal", entity_id: dealC, event_type: "stage_changed", payload: { to_stage_id: "x" } });
    expect(write.error?.code, JSON.stringify(write.error)).toBe("42501");
  });

  it("anon still may not call the report", async () => {
    const r = await anonClient().rpc("report_stage_conversion", live);
    expect(r.error, "anon has no EXECUTE").not.toBeNull();
  });
});

/**
 * The payload matrix. Each case is ONE event, written by the service role at a
 * fixed occurred_at in its own one-hour window of 2024 (a session cannot pick
 * occurred_at since 0128), and read back by the organisation's aal2 admin.
 *
 * The recorded names deliberately differ from the stages' current names, so a
 * figure keyed "REC-…" proves a name FALLBACK and a figure keyed by the stage's
 * name proves an id RESOLUTION.
 */
describe("every shape a stage-id field can take", () => {
  let slot = 0;
  async function one(payload: Record<string, unknown>): Promise<Conv> {
    const base = Date.UTC(2024, 0, 1) + slot++ * 60 * 60 * 1000;
    const deal = await newDeal(ORG, sNew.id, agent.id);
    const { error } = await svc.from("events").insert({
      org_id: ORG,
      actor_id: agent.id,
      entity_type: "deal",
      entity_id: deal,
      event_type: "stage_changed",
      payload,
      occurred_at: new Date(base + 60_000).toISOString(),
    });
    if (error) throw new Error(`event fixture: ${error.message}`);
    return ok(admin.client, { p_from: new Date(base).toISOString(), p_to: new Date(base + 60 * 60 * 1000).toISOString() }, JSON.stringify(payload));
  }
  const names = { from: "REC-from", to: "REC-to" };
  const valid = () => ({ ...names, from_stage_id: sNew.id, to_stage_id: sQualified.id });

  it("valid ids resolve to the stages' CURRENT names", async () => {
    const c = await one(valid());
    expect(c.transitions).toEqual([{ from: "New", to: "Qualified", deals: 1 }]);
    expect([c.moves_total, c.moves_with_ids, c.moves_malformed]).toEqual([1, 1, 0]);
  });

  it.each([
    ["upper case", (u: string) => u.toUpperCase()],
    ["braces", (u: string) => `{${u}}`],
    ["no hyphens", (u: string) => u.replace(/-/g, "")],
  ])("every uuid spelling the cast accepted still resolves (%s)", async (_label, spell) => {
    for (const field of ["from_stage_id", "to_stage_id"] as const) {
      const p = valid();
      p[field] = spell(p[field]);
      const c = await one(p);
      expect(c.transitions, field).toEqual([{ from: "New", to: "Qualified", deals: 1 }]);
      expect([c.moves_total, c.moves_with_ids, c.moves_malformed], field).toEqual([1, 1, 0]);
    }
  });

  it.each([
    ["absent", undefined],
    ["JSON null", null],
    ["the empty string", ""],
  ])("a %s id is a legacy id-less side: its recorded name stands, nothing is excluded", async (_label, value) => {
    for (const field of ["from_stage_id", "to_stage_id"] as const) {
      const p: Record<string, unknown> = valid();
      if (value === undefined) delete p[field];
      else p[field] = value;
      const c = await one(p);
      const expected =
        field === "from_stage_id" ? { from: "REC-from", to: "Qualified", deals: 1 } : { from: "New", to: "REC-to", deals: 1 };
      expect(c.transitions, field).toEqual([expected]);
      expect([c.moves_total, c.moves_with_ids, c.moves_malformed], field).toEqual([1, 1, 0]);
    }
  });

  it("a pre-0067 name-only event reports under its recorded names, not id-backed", async () => {
    const c = await one({ ...names });
    expect(c.transitions).toEqual([{ from: "REC-from", to: "REC-to", deals: 1 }]);
    expect([c.moves_total, c.moves_with_ids, c.moves_malformed]).toEqual([1, 0, 0]);
  });

  it("an id naming no readable stage (deleted, or another organisation's) falls back to the recorded name", async () => {
    for (const id of [randomUUID(), otherStage.id]) {
      const c = await one({ ...valid(), to_stage_id: id });
      expect(c.transitions).toEqual([{ from: "New", to: "REC-to", deals: 1 }]);
      expect([c.moves_total, c.moves_with_ids, c.moves_malformed]).toEqual([1, 1, 0]);
    }
  });

  it.each([
    ["a non-uuid string", "x"],
    ["whitespace", " "],
    ["a padded uuid", ` ${randomUUID()} `],
    ["one bad hex digit", "12345678-1234-1234-1234-12345678901z"],
    ["one digit too many", "123e4567-e89b-12d3-a456-4266141740000"],
    ["a number", 123],
    ["zero", 0],
    ["true", true],
    ["false", false],
    ["an object", { id: "x" }],
    ["an empty object", {}],
    ["an array", ["x"]],
    ["an empty array", []],
  ])("%s in either field excludes the WHOLE movement and counts it — no name fallback", async (_label, value) => {
    for (const field of ["from_stage_id", "to_stage_id"] as const) {
      const c = await one({ ...valid(), [field]: value });
      expect(c.stages, field).toEqual([]);
      expect(c.transitions, field).toEqual([]);
      expect([c.moves_total, c.moves_with_ids, c.moves_malformed], field).toEqual([0, 0, 1]);
    }
  });

  it("a uuid wrapped in an object or array is malformed, not unwrapped", async () => {
    for (const value of [{ id: sQualified.id }, [sQualified.id]]) {
      const c = await one({ ...valid(), to_stage_id: value });
      expect([c.moves_total, c.moves_malformed]).toEqual([0, 1]);
    }
  });
});

describe("a mixed window keeps its counters consistent", () => {
  it("valid, legacy and malformed moves split cleanly", async () => {
    const base = Date.UTC(2024, 5, 1);
    const at = (m: number) => new Date(base + m * 60_000).toISOString();
    const d1 = await newDeal(ORG, sNew.id, agent.id);
    const d2 = await newDeal(ORG, sNew.id, agent.id);
    const rows = [
      // two id-backed moves of d1: New → Qualified → Viewing
      { entity_id: d1, payload: { from: "New", to: "Qualified", from_stage_id: sNew.id, to_stage_id: sQualified.id }, occurred_at: at(1) },
      { entity_id: d1, payload: { from: "Qualified", to: "Viewing", from_stage_id: sQualified.id, to_stage_id: sViewing.id }, occurred_at: at(2) },
      // one legacy name-only move of d2 into Qualified
      { entity_id: d2, payload: { from: "New", to: "Qualified" }, occurred_at: at(3) },
      // two malformed moves — one would have fabricated a SECOND Viewing entry by name
      { entity_id: d2, payload: { from: "Qualified", to: "Viewing", from_stage_id: sQualified.id, to_stage_id: 42 }, occurred_at: at(4) },
      { entity_id: d2, payload: { from: "Viewing", to: "Offer", from_stage_id: "Viewing", to_stage_id: null }, occurred_at: at(5) },
    ].map((r) => ({ ...r, org_id: ORG, actor_id: agent.id, entity_type: "deal", event_type: "stage_changed" }));
    const { error } = await svc.from("events").insert(rows);
    expect(error, JSON.stringify(error)).toBeNull();

    const c = await ok(admin.client, { p_from: at(0), p_to: at(10) }, "mixed");
    expect([c.moves_total, c.moves_with_ids, c.moves_malformed]).toEqual([3, 2, 2]);
    expect(c.stages).toEqual([
      { stage: "Qualified", entered: 2, advanced: 1, advance_rate: 0.5 },
      { stage: "Viewing", entered: 1, advanced: 0, advance_rate: 0 },
    ]);
    expect(c.stages.every((s) => s.advanced <= s.entered)).toBe(true);
    expect(c.transitions.reduce((n, t) => n + t.deals, 0)).toBeLessThanOrEqual(c.moves_total);
    expect(c.note).toMatch(/moves_malformed/);
  });
});

describe("the function and the chain are unchanged in every other respect", () => {
  it("SECURITY INVOKER, STABLE, search_path=public, same signature and grants", async () => {
    const { rows } = await pg.query(`
      select p.prosecdef, p.provolatile, p.proconfig, pg_get_function_identity_arguments(p.oid) as args,
             pg_get_function_result(p.oid) as result,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authed,
             has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p where p.oid = 'public.report_stage_conversion(timestamptz, timestamptz)'::regprocedure`);
    expect(rows[0]).toEqual({
      prosecdef: false,
      provolatile: "s",
      proconfig: ["search_path=public"],
      args: "p_from timestamp with time zone, p_to timestamp with time zone",
      result: "jsonb",
      anon: false,
      authed: true,
      svc: true,
    });
  });

  it("reading reports changes no event, and the chain still verifies", async () => {
    const before = await eventsDigest(ORG);
    await ok(admin.client, { p_from: "2000-01-01T00:00:00Z", p_to: "2100-01-01T00:00:00Z" }, "all time");
    await ok(agent.client, { p_from: "2000-01-01T00:00:00Z", p_to: "2100-01-01T00:00:00Z" }, "all time");
    expect(await eventsDigest(ORG)).toBe(before);
    expect((await pg.query("select public.verify_events_chain($1) as ok", [ORG])).rows[0].ok).toBe(true);
  });
});
