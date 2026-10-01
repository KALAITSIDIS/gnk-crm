import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * What a user session may write into the append-only chain
 * (T-session-written-events, migration 0128).
 *
 * `events_insert` checked only the organisation and the actor, so the session
 * that may close a deal could also POST its `won` / `lost` / `won_override`
 * events without closing it — and the chain keeps them for good (BACKLOG "A
 * user session can hand-write a deal's terminal events"; only `close_deal`, a
 * definer, writes them). And a session chose its own `occurred_at`: a
 * far-future value sorted first in the admin feed for good, skewed
 * `occurred_at_inversion`, and landed in the DEFAULT partition (BACKLOG "A
 * crafted event's `occurred_at` is bounded only in the renderer"). Both are
 * refused by `events_insert` now; RLS binds only sessions, so definers and
 * the service role keep writing as before.
 *
 * aal2 sessions of a throwaway organisation; deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);

let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
const userIds: string[] = [];
let openStage: string;

async function newDeal(): Promise<string> {
  const { data, error } = await svc
    .from("deals")
    .insert({ org_id: ORG, deal_type: "sale", stage_id: openStage, title: `ZZEV ${RUN}`, agent_id: agent.id, created_by: agent.id })
    .select("id")
    .single();
  if (error) throw new Error(`deal fixture: ${error.message}`);
  return data.id as string;
}

const count = async (entityId: string, type: string) =>
  (await pg.query("select count(*)::int as c from events where entity_id = $1 and event_type = $2", [entityId, type])).rows[0]
    .c as number;

/** A session's direct INSERT — the shape `logEvent` sends, plus whatever a crafted request adds. */
function post(user: TestUser, row: Record<string, unknown>) {
  return user.client
    .from("events")
    .insert({ org_id: ORG, actor_id: user.id, payload: {}, ...row })
    .select("id, occurred_at")
    .single();
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Events ${RUN}`, `events-${RUN}`);
  admin = await createTestUser(svc, `ev-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `ev-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  openStage = (
    await pg.query(
      "select id from deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1",
      [ORG],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await pg.query("delete from offers where org_id = $1", [ORG]);
  await pg.query("delete from tasks where org_id = $1", [ORG]);
  await pg.query("delete from leads where org_id = $1", [ORG]);
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

describe("a session cannot hand-write a deal's terminal events", () => {
  // 0131: nor its stage movement — deals_stage_changed_event writes that from
  // the row change (supabase/tests/stage-movement-authentic.test.ts)
  it.each(["won", "lost", "won_override", "stage_changed"])("an admin's or the deal agent's direct '%s' is refused, and nothing is kept", async (type) => {
    const deal = await newDeal();
    for (const u of [admin, agent]) {
      const r = await post(u, { entity_type: "deal", entity_id: deal, event_type: type });
      expect(r.error?.code, `${u.email} ${JSON.stringify(r.error)}`).toBe("42501");
    }
    expect(await count(deal, type)).toBe(0);
  });

  it("the session's ordinary events still write — a deal's 'updated', a lead's 'lost'", async () => {
    const deal = await newDeal();
    expect((await post(agent, { entity_type: "deal", entity_id: deal, event_type: "updated" })).error).toBeNull();
    const lead = randomUUID();
    expect((await post(admin, { entity_type: "lead", entity_id: lead, event_type: "lost" })).error).toBeNull();
  });

  it("close_deal — the definer that owns them — still writes them, once", async () => {
    const deal = await newDeal();
    const r = await agent.client.rpc("close_deal", {
      p_deal_id: deal,
      p_outcome: "lost",
      p_final_value: null,
      p_lost_reason: "Price",
      p_override: false,
    });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(await count(deal, "lost")).toBe(1);
  });
});

describe("a session's event happens now — it cannot choose its own occurred_at", () => {
  it.each([
    ["the far future (year 200000)", "200000-01-01T00:00:00Z"],
    ["the past", "2001-01-01T00:00:00Z"],
  ])("a session posting %s is refused, and nothing is kept", async (_label, at) => {
    const entity = randomUUID();
    const r = await post(admin, { entity_type: "contact", entity_id: entity, event_type: "updated", occurred_at: at });
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
    expect(await count(entity, "updated")).toBe(0);
  });

  it("a session that leaves occurred_at to its default writes at the insert's own time", async () => {
    const before = Date.now();
    const r = await post(admin, { entity_type: "contact", entity_id: randomUUID(), event_type: "updated" });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const { rows } = await pg.query("select extract(epoch from occurred_at) * 1000 as ms from events where id = $1", [r.data!.id]);
    expect(Number(rows[0].ms)).toBeGreaterThan(before - 60_000);
    expect(Number(rows[0].ms)).toBeLessThan(Date.now() + 60_000);
  });

  it("the service role (imports, backfills) keeps the occurred_at it gives", async () => {
    const { data, error } = await svc
      .from("events")
      .insert({ org_id: ORG, entity_type: "contact", entity_id: randomUUID(), event_type: "imported", payload: {}, occurred_at: "2024-05-06T07:08:09Z" })
      .select("id")
      .single();
    expect(error, JSON.stringify(error)).toBeNull();
    const { rows } = await pg.query("select occurred_at from events where id = $1", [data!.id]);
    expect((rows[0].occurred_at as Date).toISOString()).toBe("2024-05-06T07:08:09.000Z");
  });

  it("the organisation's chain still verifies end to end", async () => {
    expect((await pg.query("select public.verify_events_chain($1) as ok", [ORG])).rows[0].ok).toBe(true);
  });
});
