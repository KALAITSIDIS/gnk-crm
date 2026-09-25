import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
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
 * 0117: `close_deal` — the database half of closing a deal.
 *
 * TWO KINDS OF CALLER, both real:
 *
 *  - `pg` sessions IMPERSONATING a user (`set local role authenticated` plus the
 *    JWT claims, inside a transaction — outside one the role reverts and the
 *    call would run as postgres with RLS bypassed). These give the ORDERED
 *    races: session A closes and holds its transaction open; session B's call
 *    is observed BLOCKED on A's row lock (pg_stat_activity: wait_event_type
 *    'Lock'); A commits or rolls back; B returns. A barrier on a condition,
 *    never a sleep.
 *  - supabase-js clients through PostgREST — exactly how the app calls it —
 *    for the role, MFA, input and failure-injection rules. Each request is its
 *    own transaction, as in production.
 *
 * A THROWAWAY ORGANISATION (and a second one for cross-organisation probes),
 * deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);

let a: Client; // first closer
let b: Client; // competing closer
let o: Client; // observer as postgres: barriers, fixtures, verification, cleanup
let svc: SupabaseClient;

let admin: TestUser;
let agent: TestUser; // owns the deals
let otherAgent: TestUser; // same org, owns nothing
let lm: TestUser; // listing manager
let inactive: TestUser; // owns a deal, then deactivated
let otherAdmin: TestUser; // another organisation
const userIds: string[] = [];

let openStage: { id: string; name: string };
let wonStage: { id: string; name: string };
let lostStage: { id: string; name: string };
let n = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type Result = { result: string; status: string; [k: string]: unknown };

async function newDeal(opts: { owner?: string; accepted?: number | null; org?: string } = {}) {
  n += 1;
  const org = opts.org ?? ORG;
  const stage =
    org === ORG
      ? openStage.id
      : (
          await o.query<{ id: string }>(
            "select id from deal_stages where org_id = $1 and deal_type = 'sale' order by sort_order limit 1",
            [org],
          )
        ).rows[0]!.id;
  const owner = opts.owner ?? agent.id;
  const { rows } = await o.query<{ id: string }>(
    `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by, expected_value)
     values ($1, 'sale', $2, $3, $4, $4, 123456) returning id`,
    [org, stage, `ZZTEST close_deal ${RUN} ${n}`, owner],
  );
  const id = rows[0]!.id;
  if (opts.accepted != null) {
    await o.query(
      `insert into offers (org_id, deal_id, amount, status, decided_at) values ($1, $2, $3, 'accepted', now())`,
      [org, id, opts.accepted],
    );
  }
  return id;
}

async function row(id: string) {
  const { rows } = await o.query(
    `select status::text, won_at, lost_at, lost_reason, final_value::text as final_value,
            stage_id, stage_entered_at, last_activity_at, updated_at
       from deals where id = $1`,
    [id],
  );
  return rows[0] as Record<string, unknown> & { status: string; lost_reason: string | null; final_value: string | null; stage_id: string };
}

async function events(entityId: string) {
  const { rows } = await o.query<{ event_type: string; payload: Record<string, unknown>; actor_id: string; occurred_at: Date }>(
    "select event_type, payload, actor_id, occurred_at from events where org_id = $1 and entity_id = $2 order by id",
    [ORG, entityId],
  );
  return rows;
}
const count = (evs: { event_type: string }[], t: string) => evs.filter((e) => e.event_type === t).length;

/** Open a transaction on `c` as `uid` — the only way `set local role` holds. */
async function asUser(c: Client, uid: string, aal: "aal1" | "aal2" = "aal2") {
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal }),
  ]);
}

async function closeSql(
  c: Client,
  dealId: string,
  outcome: string,
  opts: { final?: number | string | null; reason?: string | null; override?: boolean } = {},
): Promise<Result> {
  const { rows } = await c.query<{ r: Result }>(
    "select public.close_deal($1::uuid, $2::text, $3::numeric, $4::text, $5::boolean) as r",
    [dealId, outcome, opts.final ?? null, opts.reason ?? null, opts.override ?? false],
  );
  return rows[0]!.r;
}

async function rpc(
  client: SupabaseClient,
  dealId: string,
  outcome: string,
  opts: { final?: number | null; reason?: string | null; override?: boolean | null } = {},
) {
  return client.rpc("close_deal", {
    p_deal_id: dealId,
    p_outcome: outcome,
    p_final_value: opts.final ?? null,
    p_lost_reason: opts.reason ?? null,
    p_override: opts.override === undefined ? false : opts.override,
  });
}

async function pidOf(c: Client) {
  const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
  return rows[0]!.pid;
}

async function until(label: string, cond: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`barrier timed out: ${label}`);
}

/** Barrier: that backend is blocked waiting for a row lock (another transaction's). */
const waitsOnRowLock = (pid: number) => async () => {
  const { rows } = await o.query<{ t: string | null; e: string | null }>(
    "select wait_event_type as t, wait_event as e from pg_stat_activity where pid = $1",
    [pid],
  );
  return rows[0]?.t === "Lock" && (rows[0]?.e === "transactionid" || rows[0]?.e === "tuple");
};

function settled<T>(p: Promise<T>) {
  let done = false;
  const tracked = p.finally(() => {
    done = true;
  });
  return { done: () => done, value: () => tracked };
}

/** Refuse ONE event type for ONE entity, in the database (committed); returns the remover. */
async function failEvent(entityId: string, eventType: string) {
  n += 1;
  const fn = `zz_dcx_fail_${RUN}_${n}`;
  if (!/^[0-9a-f-]{36}$/.test(entityId) || !/^[a-z_]+$/.test(eventType)) throw new Error("bad input");
  await o.query(
    `create function public.${fn}() returns trigger language plpgsql as $f$
     begin
       if new.entity_id = '${entityId}'::uuid and new.event_type = '${eventType}' then
         raise exception 'injected failure: % event refused', new.event_type;
       end if;
       return new;
     end $f$`,
  );
  await o.query(`revoke all on function public.${fn}() from public, anon, authenticated, service_role`);
  await o.query(`create trigger ${fn} before insert on public.events for each row execute function public.${fn}()`);
  return async () => {
    await o.query(`drop trigger if exists ${fn} on public.events`);
    await o.query(`drop function if exists public.${fn}()`);
  };
}

beforeAll(async () => {
  svc = serviceClient();
  a = new Client({ connectionString: DB_URL });
  b = new Client({ connectionString: DB_URL });
  o = new Client({ connectionString: DB_URL });
  await Promise.all([a.connect(), b.connect(), o.connect()]);
  const { rows: stale } = await o.query<{ tgname: string }>(
    "select tgname from pg_trigger where tgrelid = 'public.events'::regclass and tgname like 'zz_dcx_fail_%'",
  );
  for (const t of stale) {
    await o.query(`drop trigger if exists ${t.tgname} on public.events`);
    await o.query(`drop function if exists public.${t.tgname}()`);
  }

  await ensureTestOrg(svc, ORG, `close_deal ${RUN}`, `close-deal-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `close_deal other ${RUN}`, `close-deal-other-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors ({} messages)
  admin = await createTestUser(svc, `cd-admin-${RUN}@test.local`, "admin", ORG);
  agent = await createTestUser(svc, `cd-agent-${RUN}@test.local`, "agent", ORG);
  otherAgent = await createTestUser(svc, `cd-agent2-${RUN}@test.local`, "agent", ORG);
  lm = await createTestUser(svc, `cd-lm-${RUN}@test.local`, "listing_manager", ORG);
  inactive = await createTestUser(svc, `cd-inactive-${RUN}@test.local`, "agent", ORG);
  otherAdmin = await createTestUser(svc, `cd-admin-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(admin.id, agent.id, otherAgent.id, lm.id, inactive.id, otherAdmin.id);

  const { rows: stages } = await o.query<{ id: string; name: string; sort_order: number; is_won: boolean; is_lost: boolean }>(
    "select id, name, sort_order, is_won, is_lost from deal_stages where org_id = $1 and deal_type = 'sale' order by sort_order",
    [ORG],
  );
  openStage = stages.find((s) => s.sort_order === 1)!;
  wonStage = stages.find((s) => s.is_won)!;
  lostStage = stages.find((s) => s.is_lost)!;
});

afterEach(async () => {
  // both at once: a session blocked on the other's lock queues its rollback
  // behind the blocked statement (the events-chain-order lesson)
  await Promise.all([a.query("rollback").catch(() => undefined), b.query("rollback").catch(() => undefined)]);
});

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from tasks where org_id = $1", [org]);
    await o.query("delete from offers where org_id = $1", [org]);
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
  await Promise.all([a.end(), b.end(), o.end()]);
});

// ---------------------------------------------------------------------------
describe("competing closes serialise on the row: one transition, one terminal event", () => {
  /** A closes and holds; B is seen blocked; A commits; B returns. */
  async function race(
    dealId: string,
    first: { uid: string; outcome: string; opts?: Parameters<typeof closeSql>[3] },
    second: { uid: string; outcome: string; opts?: Parameters<typeof closeSql>[3] },
    endFirst: "commit" | "rollback" = "commit",
  ) {
    await asUser(a, first.uid);
    const ra = await closeSql(a, dealId, first.outcome, first.opts);
    await asUser(b, second.uid);
    const pidB = await pidOf(b);
    const pb = settled(closeSql(b, dealId, second.outcome, second.opts));
    await until("B is blocked on A's row lock", waitsOnRowLock(pidB));
    expect(pb.done(), "B must wait while A holds the row").toBe(false);
    await a.query(endFirst);
    const rb = await pb.value();
    await b.query("commit");
    return { ra, rb };
  }

  it("Lost vs Lost: the second answers already_closed and writes nothing", async () => {
    const deal = await newDeal();
    const { ra, rb } = await race(
      deal,
      { uid: agent.id, outcome: "lost", opts: { reason: "Reason A" } },
      { uid: agent.id, outcome: "lost", opts: { reason: "Reason B" } },
    );
    expect(ra).toMatchObject({ result: "closed", status: "lost" });
    expect(rb).toEqual({ result: "already_closed", status: "lost", deal_id: deal });
    const r = await row(deal);
    expect(r.lost_reason, "the first reason stands").toBe("Reason A");
    const evs = await events(deal);
    expect(count(evs, "lost")).toBe(1);
    // one transaction: the row's lost_at IS the event's occurred_at
    expect((r.lost_at as Date).getTime()).toBe(evs.find((e) => e.event_type === "lost")!.occurred_at.getTime());
  });

  it("Won vs Won (accepted offer): one Won, no override event", async () => {
    const deal = await newDeal({ accepted: 250000 });
    const { ra, rb } = await race(
      deal,
      { uid: agent.id, outcome: "won" },
      { uid: agent.id, outcome: "won", opts: { final: 999 } },
    );
    expect(ra).toMatchObject({ result: "closed", status: "won", override: false, final_value: 250000 });
    expect(rb).toMatchObject({ result: "already_closed", status: "won" });
    const evs = await events(deal);
    expect(count(evs, "won")).toBe(1);
    expect(count(evs, "won_override")).toBe(0);
    expect((await row(deal)).final_value, "the second request's price is not applied").toBe("250000.00");
  });

  it("Won vs Won (admin override): exactly one won_override and one Won", async () => {
    const deal = await newDeal();
    const { ra, rb } = await race(
      deal,
      { uid: admin.id, outcome: "won", opts: { override: true, final: 100000 } },
      { uid: admin.id, outcome: "won", opts: { override: true, final: 200000 } },
    );
    expect(ra).toMatchObject({ result: "closed", override: true, final_value: 100000 });
    expect(rb).toMatchObject({ result: "already_closed", status: "won" });
    const evs = await events(deal);
    expect(evs.map((e) => e.event_type)).toEqual(["won_override", "won"]);
    expect((await row(deal)).final_value).toBe("100000.00");
  });

  it("Won first, then Lost: Lost answers conflict; the won deal carries no Lost details", async () => {
    const deal = await newDeal({ accepted: 300000 });
    const { rb } = await race(
      deal,
      { uid: agent.id, outcome: "won" },
      { uid: agent.id, outcome: "lost", opts: { reason: "Should never land" } },
    );
    expect(rb).toEqual({ result: "conflict", status: "won", deal_id: deal });
    const r = await row(deal);
    expect(r).toMatchObject({ status: "won", lost_at: null, lost_reason: null, stage_id: wonStage.id });
    const evs = await events(deal);
    expect(count(evs, "won")).toBe(1);
    expect(count(evs, "lost")).toBe(0);
  });

  it("Lost first, then Won: Won answers conflict; the lost deal carries no Won details", async () => {
    const deal = await newDeal({ accepted: 300000 });
    const { rb } = await race(
      deal,
      { uid: agent.id, outcome: "lost", opts: { reason: "Buyer withdrew" } },
      { uid: admin.id, outcome: "won", opts: { override: true, final: 5 } },
    );
    expect(rb).toEqual({ result: "conflict", status: "lost", deal_id: deal });
    const r = await row(deal);
    expect(r).toMatchObject({ status: "lost", won_at: null, final_value: null, stage_id: lostStage.id });
    const evs = await events(deal);
    expect(count(evs, "lost")).toBe(1);
    expect(count(evs, "won") + count(evs, "won_override")).toBe(0);
  });

  it("if the first close rolls back, the waiting one proceeds and closes", async () => {
    const deal = await newDeal();
    const { ra, rb } = await race(
      deal,
      { uid: agent.id, outcome: "lost", opts: { reason: "Rolled back" } },
      { uid: agent.id, outcome: "lost", opts: { reason: "Committed" } },
      "rollback",
    );
    expect(ra.result).toBe("closed");
    expect(rb).toMatchObject({ result: "closed", status: "lost" });
    expect((await row(deal)).lost_reason).toBe("Committed");
    expect(count(await events(deal), "lost")).toBe(1);
  });

  it("through PostgREST, two simultaneous closes: exactly one reports closed", async () => {
    const deal = await newDeal({ accepted: 150000 });
    const [x, y] = await Promise.all([
      rpc(agent.client, deal, "won"),
      rpc(agent.client, deal, "lost", { reason: "Simultaneous" }),
    ]);
    expect(x.error).toBeNull();
    expect(y.error).toBeNull();
    const results = [x.data, y.data] as Result[];
    expect(results.filter((r) => r.result === "closed")).toHaveLength(1);
    expect(results.filter((r) => r.result === "conflict")).toHaveLength(1);
    const winner = results.find((r) => r.result === "closed")!;
    expect((await row(deal)).status).toBe(winner.status);
    const evs = await events(deal);
    expect(count(evs, "won") + count(evs, "lost")).toBe(1);
  });
});

describe("a repeated request after completion", () => {
  it("the same outcome with different details: already_closed, the row untouched, no event", async () => {
    const deal = await newDeal({ accepted: 400000 });
    const first = await rpc(agent.client, deal, "won", { final: 390000 });
    expect(first.data).toMatchObject({ result: "closed", final_value: 390000 });
    const before = await row(deal);
    const again = await rpc(agent.client, deal, "won", { final: 1 });
    expect(again.error).toBeNull();
    expect(again.data).toEqual({ result: "already_closed", status: "won", deal_id: deal });
    expect(await row(deal), "no column moved, updated_at included").toEqual(before);
    expect(count(await events(deal), "won")).toBe(1);
  });

  it("the other outcome: conflict, the row untouched, no event", async () => {
    const deal = await newDeal();
    await rpc(agent.client, deal, "lost", { reason: "Original reason" });
    const before = await row(deal);
    const again = await rpc(admin.client, deal, "won", { override: true });
    expect(again.data).toEqual({ result: "conflict", status: "lost", deal_id: deal });
    expect(await row(deal)).toEqual(before);
    const evs = await events(deal);
    expect(evs.map((e) => e.event_type)).toEqual(["lost"]);
  });
});

describe("a refused event write rolls the whole close back", () => {
  async function withNudge(dealId: string) {
    // an open deal_no_contact task: closing supersedes it (deals_supersede_nudges),
    // so a rolled-back close must leave it open and write no `superseded` event
    const { rows } = await o.query<{ id: string }>(
      `insert into tasks (org_id, title, due_at, assignee_id, deal_id, kind)
       values ($1, 'ZZTEST nudge', now() + interval '1 day', $2, $3, 'deal_no_contact') returning id`,
      [ORG, agent.id, dealId],
    );
    return rows[0]!.id;
  }

  const cases = [
    { refused: "lost", caller: () => agent, outcome: "lost", opts: { reason: "Rolled back reason" } },
    { refused: "won_override", caller: () => admin, outcome: "won", opts: { override: true, final: 7 } },
    { refused: "won", caller: () => admin, outcome: "won", opts: { override: true, final: 8 } },
    { refused: "won", caller: () => agent, outcome: "won", opts: {}, accepted: 90000 },
  ] as const;

  for (const c of cases) {
    it(`${c.outcome} with the '${c.refused}' event refused${"accepted" in c ? " (accepted offer)" : ""}: status, stage, timestamps, price, reason and the nudge all stay`, async () => {
      const deal = await newDeal({ accepted: "accepted" in c ? c.accepted : null });
      const task = await withNudge(deal);
      const before = await row(deal);
      const remove = await failEvent(deal, c.refused);
      let res: Awaited<ReturnType<typeof rpc>>;
      try {
        res = await rpc(c.caller().client, deal, c.outcome, c.opts);
      } finally {
        await remove();
      }
      expect(res.error?.message ?? "").toMatch(/injected failure/);
      expect(res.data).toBeNull();
      expect(await row(deal)).toEqual(before);
      expect(await events(deal)).toEqual([]);
      const { rows: t } = await o.query("select is_done from tasks where id = $1", [task]);
      expect(t[0]!.is_done, "the supersession rolled back too").toBe(false);
      expect(await events(task)).toEqual([]);
      // and the deal can still be closed afterwards
      const retry = await rpc(c.caller().client, deal, c.outcome, c.opts);
      expect(retry.data).toMatchObject({ result: "closed" });
    });
  }
});

describe("the guarded rules hold for a direct RPC call", () => {
  it("an agent without an accepted offer is refused, override or not", async () => {
    const deal = await newDeal();
    for (const override of [false, true]) {
      const r = await rpc(agent.client, deal, "won", { override });
      expect(r.error?.message).toBe(
        "Won requires an accepted offer — record one first, or ask an admin to override.",
      );
    }
    expect((await row(deal)).status).toBe("open");
    expect(await events(deal)).toEqual([]);
  });

  it("an admin without an accepted offer must tick the override", async () => {
    const deal = await newDeal();
    const r = await rpc(admin.client, deal, "won");
    expect(r.error?.message).toBe('No accepted offer on this deal. Tick "Admin override" to mark it won anyway.');
    expect(await events(deal)).toEqual([]);
  });

  it("an admin override writes won_override then won; the price is the typed one or absent", async () => {
    const typed = await newDeal();
    const r1 = await rpc(admin.client, typed, "won", { override: true, final: 175000.5 });
    expect(r1.data).toMatchObject({ result: "closed", override: true, final_value: 175000.5 });
    const e1 = await events(typed);
    expect(e1.map((e) => e.event_type)).toEqual(["won_override", "won"]);
    expect(e1[0]!.payload).toEqual({ reason: "marked won without an accepted offer" });
    expect(e1[1]!.payload).toEqual({ override: true, final_value: 175000.5, stage: wonStage.name });
    expect(e1.every((e) => e.actor_id === admin.id)).toBe(true);

    const blank = await newDeal();
    await rpc(admin.client, blank, "won", { override: true });
    const e2 = await events(blank);
    expect(e2[1]!.payload, "no final_value key when none was given").toEqual({ override: true, stage: wonStage.name });
    expect((await row(blank)).final_value).toBeNull();
  });

  it("an accepted offer: no override event even if the flag is sent; the price defaults to the offer", async () => {
    const deal = await newDeal({ accepted: 250000 });
    await o.query(
      `insert into offers (org_id, deal_id, amount, status, decided_at) values ($1, $2, 1, 'withdrawn', now()), ($1, $2, 2, 'rejected', now())`,
      [ORG, deal],
    );
    const { rows: acc } = await o.query<{ id: string }>(
      "select id from offers where deal_id = $1 and status = 'accepted'",
      [deal],
    );
    const r = await rpc(admin.client, deal, "won", { override: true });
    expect(r.data).toMatchObject({ result: "closed", override: false, final_value: 250000, offer_id: acc[0]!.id });
    const evs = await events(deal);
    expect(evs.map((e) => e.event_type)).toEqual(["won"]);
    // the action's keys, plus the id of the offer that justified the close;
    // byte-compatible numbers: 250000, not 250000.00
    expect(evs[0]!.payload).toEqual({
      override: false,
      final_value: 250000,
      stage: wonStage.name,
      offer_id: acc[0]!.id,
    });
    const { rows } = await o.query("select payload::text as t from events where org_id = $1 and entity_id = $2", [ORG, deal]);
    expect(rows[0]!.t).toMatch(/"final_value": 250000[,}]/);
    expect(rows[0]!.t).not.toContain("250000.00");
    expect(await row(deal)).toMatchObject({ status: "won", final_value: "250000.00", stage_id: wonStage.id });
  });

  it("a typed price beats the offer's amount; zero is a price", async () => {
    const typed = await newDeal({ accepted: 250000 });
    await rpc(agent.client, typed, "won", { final: 248000 });
    expect((await row(typed)).final_value).toBe("248000.00");
    const zero = await newDeal({ accepted: 250000 });
    await rpc(agent.client, zero, "won", { final: 0 });
    expect((await row(zero)).final_value).toBe("0.00");
  });

  it("an accepted offer on ANOTHER deal does not satisfy the rule", async () => {
    const other = await newDeal({ accepted: 500000 });
    const deal = await newDeal();
    const r = await rpc(agent.client, deal, "won");
    expect(r.error?.message).toMatch(/^Won requires an accepted offer/);
    expect((await row(other)).status).toBe("open");
  });

  it("an 'accepted' offer planted on the deal from ANOTHER organisation does not satisfy it either", async () => {
    // offers.deal_id carries no tenant FK, and offers_insert checks only the
    // inserter's org — so this row is possible; close_deal reads the deal's own org
    const deal = await newDeal();
    await o.query(
      `insert into offers (org_id, deal_id, amount, status, decided_at) values ($1, $2, 999, 'accepted', now() + interval '1 day')`,
      [OTHER_ORG, deal],
    );
    const r = await rpc(admin.client, deal, "won");
    expect(r.error?.message).toBe('No accepted offer on this deal. Tick "Admin override" to mark it won anyway.');
    expect((await row(deal)).status).toBe("open");
  });

  it("an accepted offer whose amount is NaN is refused as a price, not stored", async () => {
    // numeric admits NaN and the offers CHECK (amount >= 0) passes it
    const deal = await newDeal();
    await o.query(
      `insert into offers (org_id, deal_id, amount, status, decided_at) values ($1, $2, 'NaN', 'accepted', now())`,
      [ORG, deal],
    );
    const r = await rpc(agent.client, deal, "won");
    expect(r.error?.message).toBe("The accepted offer's amount is not a valid price — correct the offer first.");
    expect((await row(deal)).status).toBe("open");
    // a typed price is used instead of the offer's, so the close can still happen
    const typed = await rpc(agent.client, deal, "won", { final: 410000 });
    expect(typed.data).toMatchObject({ result: "closed", final_value: 410000 });
  });

  it("Lost: the reason goes to the row, trimmed; the event is { stage } and nothing else", async () => {
    const deal = await newDeal();
    // an open deal_no_contact nudge, so the close ALSO writes a `superseded` event
    await o.query(
      `insert into tasks (org_id, title, due_at, assignee_id, deal_id, kind)
       values ($1, 'ZZTEST nudge', now() + interval '1 day', $2, $3, 'deal_no_contact')`,
      [ORG, agent.id, deal],
    );
    const reason = "  Buyer Xylophone-Quartz chose a rival listing  ";
    const { rows: mark } = await o.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events");
    const r = await rpc(agent.client, deal, "lost", { reason });
    expect(r.data).toMatchObject({ result: "closed", status: "lost", stage: lostStage.name });
    const rr = await row(deal);
    expect(rr).toMatchObject({ status: "lost", lost_reason: reason.trim(), stage_id: lostStage.id });
    const evs = await events(deal);
    expect(evs.map((e) => e.event_type)).toEqual(["lost"]);
    expect(evs[0]!.payload).toEqual({ stage: lostStage.name });
    // SEC-03: not one word of it in ANY event the close wrote, in ANY
    // organisation (the supersede trigger writes into the task's org)
    const { rows } = await o.query<{ n: string; c: string }>(
      `select count(*)::text as n,
              count(*) filter (where payload::text ilike '%Xylophone%' or payload::text ilike '%Quartz%')::text as c
         from events where id > $1::bigint`,
      [mark[0]!.m],
    );
    expect(Number(rows[0]!.n), "the lost event and the superseded nudge at least").toBeGreaterThanOrEqual(2);
    expect(rows[0]!.c).toBe("0");
  });

  it("a deal type with no terminal stage keeps its stage (as the action did)", async () => {
    const { rows: s } = await o.query<{ id: string }>(
      "select id from deal_stages where org_id = $1 and deal_type = 'advisory' order by sort_order limit 1",
      [ORG],
    );
    // advisory's Lost stage flag cleared for this probe, restored after
    await o.query("update deal_stages set is_lost = false where org_id = $1 and deal_type = 'advisory' and is_lost", [ORG]);
    try {
      const { rows } = await o.query<{ id: string }>(
        `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by)
         values ($1, 'advisory', $2, 'ZZTEST no lost stage', $3, $3) returning id`,
        [ORG, s[0]!.id, agent.id],
      );
      const r = await rpc(agent.client, rows[0]!.id, "lost", { reason: "No terminal stage" });
      expect(r.data).toMatchObject({ result: "closed" });
      expect(r.data).not.toHaveProperty("stage");
      expect((await row(rows[0]!.id)).stage_id).toBe(s[0]!.id);
      const evs = await events(rows[0]!.id);
      expect(evs[0]!.payload).toEqual({});
    } finally {
      await o.query(
        "update deal_stages set is_lost = true where org_id = $1 and deal_type = 'advisory' and name = 'Lost'",
        [ORG],
      );
    }
  });
});

describe("who may close — direct calls", () => {
  it("a listing manager is refused before any deal is read", async () => {
    const deal = await newDeal({ accepted: 1000 });
    for (const target of [deal, randomUUID()]) {
      const r = await rpc(lm.client, target, "lost", { reason: "Not mine to close" });
      expect(r.error?.message).toBe("You do not have permission to close deals.");
    }
    expect((await row(deal)).status).toBe("open");
  });

  it("another agent's deal, another organisation's deal and a missing deal all read 'Deal not found'", async () => {
    const mine = await newDeal({ accepted: 1000 });
    const foreign = await newDeal({ org: OTHER_ORG, owner: otherAdmin.id });
    const cases: [SupabaseClient, string][] = [
      [otherAgent.client, mine],
      [admin.client, foreign],
      [otherAdmin.client, mine],
      [admin.client, randomUUID()],
    ];
    for (const [client, id] of cases) {
      const r = await rpc(client, id, "lost", { reason: "Probing" });
      expect(r.error?.message).toBe("Deal not found");
      expect(r.data).toBeNull();
    }
    expect((await row(mine)).status).toBe("open");
    expect((await o.query("select status::text from deals where id = $1", [foreign])).rows[0].status).toBe("open");
  });

  it("an aal1 session is refused: second factor required", async () => {
    const deal = await newDeal({ accepted: 1000 });
    const aal1 = anonClient();
    const { error } = await aal1.auth.signInWithPassword({ email: agent.email, password: TEST_PASSWORD });
    expect(error).toBeNull();
    const r = await rpc(aal1, deal, "won");
    expect(r.error?.message).toBe("Second factor required.");
    expect((await row(deal)).status).toBe("open");
  });

  it("a deactivated user is refused", async () => {
    const deal = await newDeal({ owner: inactive.id, accepted: 1000 });
    await o.query("update profiles set is_active = false where id = $1", [inactive.id]);
    const r = await rpc(inactive.client, deal, "won");
    expect(r.error?.message).toBe("Account deactivated.");
    expect((await row(deal)).status).toBe("open");
  });

  it("anon and service_role cannot execute it at all", async () => {
    const deal = await newDeal({ accepted: 1000 });
    const anon = await rpc(anonClient(), deal, "won");
    expect(anon.error?.code).toBe("42501");
    const service = await rpc(svc, deal, "won");
    expect(service.error?.code).toBe("42501");
    expect((await row(deal)).status).toBe("open");
    const { rows } = await o.query<{ anon: boolean; auth: boolean; service: boolean; secdef: boolean }>(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as service,
              p.prosecdef as secdef
         from pg_proc p where p.oid = 'public.close_deal(uuid,text,numeric,text,boolean)'::regprocedure`,
    );
    // 0118: a definer — the only path by which a user session makes a deal
    // won or lost; the differential test below proves it restates deals_update
    expect(rows[0]).toEqual({ anon: false, auth: true, service: false, secdef: true });
  });
});

describe("0118: close_deal as a definer admits exactly whom deals_update admits", () => {
  // deals_update (0100): an admin of the organisation, or an agent who is the
  // deal's agent_id or created_by — and require_aal2 on top. A definer body is
  // not held by any of it, so it restates the rule; this compares the two
  // DIFFERENTIALLY, persona by persona, through PostgREST: close_deal must
  // succeed exactly where a PATCH of an ordinary column succeeds.
  async function canEdit(client: SupabaseClient, dealId: string) {
    const r = await client
      .from("deals")
      .update({ title: `ZZTEST differential ${RUN}` })
      .eq("id", dealId)
      .select("id")
      .maybeSingle();
    return r.data?.id === dealId;
  }
  async function canClose(client: SupabaseClient, dealId: string) {
    const r = await rpc(client, dealId, "lost", { reason: "Differential probe" });
    return (r.data as Result | null)?.result === "closed";
  }

  it("persona by persona: the same answer as the RLS policy, and the expected one", async () => {
    const aal1 = anonClient();
    const signIn = await aal1.auth.signInWithPassword({ email: agent.email, password: TEST_PASSWORD });
    expect(signIn.error).toBeNull();
    // created_by alone qualifies an agent: the deal is otherAgent's, the creator is agent
    const createdByAgent = async () => {
      const id = await newDeal({ owner: otherAgent.id });
      await o.query("update deals set created_by = $1 where id = $2", [agent.id, id]);
      return id;
    };
    const cases: { who: string; client: () => SupabaseClient; deal: () => Promise<string>; expected: boolean }[] = [
      { who: "the deal's agent", client: () => agent.client, deal: () => newDeal(), expected: true },
      { who: "the deal's creator (not its agent)", client: () => agent.client, deal: createdByAgent, expected: true },
      { who: "an admin (another agent's deal)", client: () => admin.client, deal: () => newDeal(), expected: true },
      { who: "another agent of the organisation", client: () => otherAgent.client, deal: () => newDeal(), expected: false },
      { who: "a listing manager", client: () => lm.client, deal: () => newDeal(), expected: false },
      { who: "another organisation's admin", client: () => otherAdmin.client, deal: () => newDeal(), expected: false },
      { who: "the deal's agent at aal1", client: () => aal1, deal: () => newDeal(), expected: false },
      { who: "anon", client: () => anonClient(), deal: () => newDeal(), expected: false },
    ];
    for (const c of cases) {
      // a fresh deal for each probe: the edit must not decide the close
      const editDeal = await c.deal();
      const closeDeal = await c.deal();
      const edit = await canEdit(c.client(), editDeal);
      const close = await canClose(c.client(), closeDeal);
      expect({ who: c.who, edit, close }).toEqual({ who: c.who, edit: c.expected, close: c.expected });
      if (!c.expected) {
        expect((await row(closeDeal)).status, c.who).toBe("open");
        expect(await events(closeDeal), c.who).toEqual([]);
      }
    }
  });

  it("a deactivated account: refused by both (current_org_id() is NULL for it)", async () => {
    // `inactive` is deactivated by "a deactivated user is refused" above; make sure
    const deal = await newDeal({ owner: inactive.id });
    await o.query("update profiles set is_active = false where id = $1", [inactive.id]);
    expect(await canEdit(inactive.client, deal)).toBe(false);
    expect(await canClose(inactive.client, deal)).toBe(false);
    expect((await row(deal)).status).toBe("open");
  });

  it("the definer resolves nothing through search_path the caller could shadow", async () => {
    const { rows } = await o.query<{ owner: string; config: string[]; src: string }>(
      `select pg_get_userbyid(p.proowner) as owner, p.proconfig as config, p.prosrc as src
         from pg_proc p where p.oid = 'public.close_deal(uuid,text,numeric,text,boolean)'::regprocedure`,
    );
    expect(rows[0]!.owner).toBe("postgres");
    expect(rows[0]!.config).toEqual(["search_path=public"]);
    // every relation it reads or writes is schema-qualified (a pg_temp table
    // named `deals` is searched BEFORE search_path for relations)
    const code = rows[0]!.src.replace(/--[^\n]*/g, "");
    const bare = code.match(/\b(?:from|join|update|into)\s+(?!public\.)(deals|offers|deal_stages|events)\b/gi);
    expect(bare).toBeNull();
  });
});

describe("inputs are validated in the database", () => {
  const refusals: [string, string, Parameters<typeof rpc>[3], RegExp][] = [
    ["an unknown outcome", "maybe", {}, /^Unknown outcome/],
    ["an empty outcome", "", {}, /^Unknown outcome/],
    // PostgREST passes an explicit JSON null through; a NULL must refuse, not fall through
    ["a null outcome", null as unknown as string, {}, /^Unknown outcome/],
    ["a null override", "won", { override: null }, /override flag/],
    ["a blank reason", "lost", { reason: "   " }, /^A reason is required\.$/],
    ["no reason", "lost", {}, /^A reason is required\.$/],
    ["a two-character reason", "lost", { reason: "ab" }, /^A reason is required\.$/],
    ["a 2001-character reason", "lost", { reason: "x".repeat(2001) }, /under 2000 characters/],
    ["a price on a Lost", "lost", { reason: "Valid reason", final: 5 }, /only when a deal is marked won/],
    ["an override on a Lost", "lost", { reason: "Valid reason", override: true }, /only when a deal is marked won/],
    ["a reason on a Won", "won", { reason: "Should not be here" }, /only when a deal is marked lost/],
    ["a negative price", "won", { final: -1 }, /positive amount/],
    ["a price beyond numeric(14,2)", "won", { final: 1_000_000_000_000 }, /positive amount/],
  ];
  for (const [label, outcome, opts, message] of refusals) {
    it(`refuses ${label}, writing nothing`, async () => {
      const deal = await newDeal({ accepted: 1000 });
      const r = await rpc(agent.client, deal, outcome, opts);
      expect(r.error?.message ?? "").toMatch(message);
      expect(await row(deal)).toMatchObject({ status: "open" });
      expect(await events(deal)).toEqual([]);
    });
  }

  it("refuses NaN and Infinity (numeric admits both; NaN even passes '>= 0')", async () => {
    for (const bad of ["NaN", "Infinity", "-Infinity"]) {
      const deal = await newDeal({ accepted: 1000 });
      await asUser(a, agent.id);
      await expect(closeSql(a, deal, "won", { final: bad })).rejects.toThrow(/positive amount/);
      await a.query("rollback");
      expect((await row(deal)).status).toBe("open");
    }
  });

  it("measures the reason as the form does (UTF-16 units): three units pass, two fail", async () => {
    const ok = await newDeal();
    // one astral character (two UTF-16 units) plus one letter = 3 units, 2 code points
    const r = await rpc(agent.client, ok, "lost", { reason: `${String.fromCodePoint(0x1f600)}a` });
    expect(r.data).toMatchObject({ result: "closed" });
    const tooShort = await newDeal();
    const r2 = await rpc(agent.client, tooShort, "lost", { reason: String.fromCodePoint(0x1f600) });
    expect(r2.error?.message).toBe("A reason is required.");
  });

  it("trims exactly what JavaScript's trim() trims — never refusing what the form accepted", async () => {
    const NEL = String.fromCharCode(0x85); // JS keeps it; PostgreSQL's \s would strip it
    const BOM = String.fromCharCode(0xfeff); // JS strips it; PostgreSQL's \s would keep it
    const NBSP = String.fromCharCode(0xa0);
    const LS = String.fromCharCode(0x2028); // LINE SEPARATOR
    const IDEO = String.fromCharCode(0x3000); // IDEOGRAPHIC SPACE
    for (const reason of [`${NEL}ab`, `${BOM}${NBSP}abc${NBSP}${BOM}`, `${LS} abc ${IDEO}`]) {
      const expected = reason.trim();
      // the form's own rule, which the database must not contradict
      expect(expected.length).toBeGreaterThanOrEqual(3);
      const deal = await newDeal();
      const r = await rpc(agent.client, deal, "lost", { reason });
      expect(r.error, JSON.stringify(reason)).toBeNull();
      expect((await row(deal)).lost_reason).toBe(expected);
    }
    // and whitespace JavaScript strips does not count towards the three
    const deal = await newDeal();
    const r = await rpc(agent.client, deal, "lost", { reason: `${BOM}ab${BOM}` });
    expect(r.error?.message).toBe("A reason is required.");
  });
});

describe("the guard trigger: a user session cannot rewrite a closed deal", () => {
  it("0118: an application older than aa01ef8 can no longer close a deal — its exact first request is refused, nothing written", async () => {
    // markDealWon / markDealLost at 6366ef8 PATCHed by id, THEN posted their
    // events. 0118 refuses that PATCH, so the old app fails closed: the row
    // and the chain are untouched and it never reaches its event writes.
    // (0117 pinned the opposite — this request had to keep working until
    // aa01ef8, which calls close_deal, was deployed.)
    const now = new Date().toISOString();
    const won = await newDeal({ accepted: 1000 });
    const beforeWon = await row(won);
    const patchWon = await agent.client
      .from("deals")
      .update({ status: "won", won_at: now, last_activity_at: now, final_value: 1000, stage_id: wonStage.id, stage_entered_at: now })
      .eq("id", won)
      .select("id")
      .maybeSingle();
    expect(patchWon.error?.code).toBe("P0001");
    expect(patchWon.error?.message).toBe("Deal is open — it is marked won only from the deal page (close_deal)");
    expect(await row(won)).toEqual(beforeWon);
    expect(await events(won)).toEqual([]);

    const lost = await newDeal();
    const beforeLost = await row(lost);
    const patchLost = await agent.client
      .from("deals")
      .update({ status: "lost", lost_at: now, lost_reason: "Old app", last_activity_at: now, stage_id: lostStage.id, stage_entered_at: now })
      .eq("id", lost)
      .select("id")
      .maybeSingle();
    expect(patchLost.error?.message).toBe("Deal is open — it is marked lost only from the deal page (close_deal)");
    expect(await row(lost)).toEqual(beforeLost);
    expect(await events(lost)).toEqual([]);
  });

  it("the deployed (pre-0117) actions' competing second write now fails instead of overwriting", async () => {
    const deal = await newDeal({ accepted: 1000 });
    await rpc(agent.client, deal, "won");
    const before = await row(deal);
    // exactly what markDealLost at 6366ef8 sends after reading the deal as open
    const now = new Date().toISOString();
    const lost = await agent.client
      .from("deals")
      .update({ status: "lost", lost_at: now, lost_reason: "Old app", last_activity_at: now, stage_id: lostStage.id, stage_entered_at: now })
      .eq("id", deal)
      .select("id")
      .maybeSingle();
    expect(lost.error?.message).toBe("Deal is already won — it cannot be marked lost");
    // …and what markDealWon at 6366ef8 sends on a double submit
    const won = await agent.client
      .from("deals")
      .update({ status: "won", won_at: now, last_activity_at: now, final_value: 1, stage_id: wonStage.id, stage_entered_at: now })
      .eq("id", deal)
      .select("id")
      .maybeSingle();
    expect(won.error?.message).toBe("Deal is already won — its closing details cannot be changed");
    expect(await row(deal)).toEqual(before);
  });

  it("a user session can neither flip, reopen nor re-detail a closed deal; ordinary edits still work", async () => {
    const deal = await newDeal();
    await rpc(agent.client, deal, "lost", { reason: "Kept" });
    const before = await row(deal);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ status: "won" }, /^Deal is already lost — it cannot be marked won$/],
      // two requests (reopen, then close) would otherwise flip it with no event
      [{ status: "open" }, /^Deal is already lost — a closed deal cannot be reopened$/],
      [{ lost_reason: "Rewritten" }, /closing details cannot be changed/],
      // …nor blank it: the pending erasure step must use the admin client (BACKLOG)
      [{ lost_reason: null }, /closing details cannot be changed/],
      [{ lost_at: new Date(0).toISOString() }, /closing details cannot be changed/],
      [{ stage_id: openStage.id }, /closing details cannot be changed/],
    ];
    for (const [patch, message] of cases) {
      const r = await admin.client.from("deals").update(patch).eq("id", deal);
      expect(r.error?.message ?? "", JSON.stringify(patch)).toMatch(message);
    }
    // the writers that legitimately touch closed rows: details, health, activity
    const edit = await agent.client
      .from("deals")
      .update({ title: "ZZTEST renamed after close", health: { budget_confirmed: true }, last_activity_at: new Date().toISOString() })
      .eq("id", deal)
      .select("id")
      .maybeSingle();
    expect(edit.error).toBeNull();
    expect(edit.data).toEqual({ id: deal });
    const after = await row(deal);
    expect({ ...after, updated_at: null, last_activity_at: null }).toEqual({
      ...before,
      updated_at: null,
      last_activity_at: null,
    });
  });

  it("the maintenance roles are not bound: the operator's correction path (and a future erasure step on the admin client)", async () => {
    const deal = await newDeal({ accepted: 1000 });
    await rpc(agent.client, deal, "won");
    // a mistyped price corrected by an operator (who logs its event by hand)
    const fix = await svc.from("deals").update({ final_value: 998 }).eq("id", deal);
    expect(fix.error).toBeNull();
    expect((await row(deal)).final_value).toBe("998.00");
    // the pending erasure decision (BACKLOG) is not pre-empted — on the ADMIN client (the service
    // role) a reason can be blanked; erasure today writes on the user session, which is refused above
    const lost = await newDeal();
    await rpc(agent.client, lost, "lost", { reason: "Names a person" });
    const redact = await svc.from("deals").update({ lost_reason: null }).eq("id", lost);
    expect(redact.error).toBeNull();
    expect((await row(lost)).lost_reason).toBeNull();
  });

  it("per open lifecycle: a deal reopened by maintenance can be closed again, once, and carries only the new outcome", async () => {
    const deal = await newDeal({ accepted: 1000 });
    await rpc(agent.client, deal, "lost", { reason: "First lifecycle" });
    // a reopen leaves the first lifecycle's lost_at / lost_reason on the row
    const reopen = await svc.from("deals").update({ status: "open" }).eq("id", deal);
    expect(reopen.error).toBeNull();
    expect((await row(deal)).lost_reason).toBe("First lifecycle");
    const again = await rpc(agent.client, deal, "won");
    expect(again.data).toMatchObject({ result: "closed", status: "won" });
    // …which the close clears: a won row never carries a Lost reason
    expect(await row(deal)).toMatchObject({ status: "won", lost_at: null, lost_reason: null });
    const repeat = await rpc(agent.client, deal, "won");
    expect(repeat.data).toMatchObject({ result: "already_closed" });
    expect((await events(deal)).map((e) => e.event_type)).toEqual(["lost", "won"]);
    // the one path where a Won runs on a row that carried a typed reason: the
    // won event is exactly its own shape, and the reason is nowhere in the chain
    const { rows: acc } = await o.query<{ id: string }>(
      "select id from offers where deal_id = $1 and status = 'accepted'",
      [deal],
    );
    expect((await events(deal))[1]!.payload).toEqual({
      override: false,
      final_value: 1000,
      stage: wonStage.name,
      offer_id: acc[0]!.id,
    });
    const { rows: leak } = await o.query<{ c: string }>(
      "select count(*)::text as c from events where org_id = $1 and payload::text ilike '%First lifecycle%'",
      [ORG],
    );
    expect(leak[0]!.c).toBe("0");

    // and the mirror: won -> reopened -> lost clears the price and won_at
    await svc.from("deals").update({ status: "open" }).eq("id", deal);
    const lost = await rpc(agent.client, deal, "lost", { reason: "Second lifecycle" });
    expect(lost.data).toMatchObject({ result: "closed", status: "lost" });
    expect(await row(deal)).toMatchObject({ status: "lost", won_at: null, final_value: null });
  });

  it("0118 (was KNOWN GAP): a direct write cannot take an OPEN deal to won — refused, the row and the chain untouched", async () => {
    // the exact request the gap test made against 0117, where it SUCCEEDED
    // with no accepted offer, no override and no event
    const deal = await newDeal();
    const before = await row(deal);
    const direct = await agent.client
      .from("deals")
      .update({ status: "won", won_at: new Date().toISOString() })
      .eq("id", deal)
      .select("id")
      .maybeSingle();
    expect(direct.error?.code).toBe("P0001");
    expect(direct.error?.message).toBe("Deal is open — it is marked won only from the deal page (close_deal)");
    expect(direct.data).toBeNull();
    expect(await row(deal), "no column moved, updated_at included").toEqual(before);
    expect(await events(deal)).toEqual([]);
  });
});

describe("0118: no user-session path but close_deal makes a deal won or lost", () => {
  const nowIso = () => new Date().toISOString();
  let foreignWon: string;
  let foreignOpen: string;
  beforeAll(async () => {
    const { rows } = await o.query<{ id: string; is_won: boolean }>(
      "select id, is_won from deal_stages where org_id = $1 and deal_type = 'sale' and (is_won or sort_order = 1)",
      [OTHER_ORG],
    );
    foreignWon = rows.find((r) => r.is_won)!.id;
    foreignOpen = rows.find((r) => !r.is_won)!.id;
  });

  /** A deal row the agent could legitimately POST (deals_insert: admin/agent, own org). */
  const insertable = (extra: Record<string, unknown> = {}) => ({
    org_id: ORG,
    deal_type: "sale",
    stage_id: openStage.id,
    title: `ZZTEST 0118 insert ${RUN} ${++n}`,
    agent_id: agent.id,
    created_by: agent.id,
    ...extra,
  });

  async function orgDealCount() {
    const { rows } = await o.query<{ c: string }>("select count(*)::text as c from deals where org_id = $1", [ORG]);
    return Number(rows[0]!.c);
  }

  describe("UPDATE (PATCH) of an OPEN deal", () => {
    const refusals: [string, () => Record<string, unknown>, string][] = [
      ["to won with a full closing payload", () => ({ status: "won", won_at: nowIso(), final_value: 5 }), "Deal is open — it is marked won only from the deal page (close_deal)"],
      ["to lost with no reason", () => ({ status: "lost" }), "Deal is open — it is marked lost only from the deal page (close_deal)"],
      ["to lost with a one-letter reason", () => ({ status: "lost", lost_at: nowIso(), lost_reason: "x" }), "Deal is open — it is marked lost only from the deal page (close_deal)"],
      ["won_at alone", () => ({ won_at: nowIso() }), "Deal is open — its closing details are written only when it is marked won or lost"],
      ["lost_at alone", () => ({ lost_at: nowIso() }), "Deal is open — its closing details are written only when it is marked won or lost"],
      ["lost_reason alone", () => ({ lost_reason: "Parked reason" }), "Deal is open — its closing details are written only when it is marked won or lost"],
      ["final_value alone", () => ({ final_value: 123 }), "Deal is open — its closing details are written only when it is marked won or lost"],
      ["into its type's Won stage", () => ({ stage_id: wonStage.id, stage_entered_at: nowIso() }), "Use the deal page to mark this deal won or lost (guarded flow)"],
      ["into its type's Lost stage", () => ({ stage_id: lostStage.id }), "Use the deal page to mark this deal won or lost (guarded flow)"],
      ["into ANOTHER organisation's Won stage", () => ({ stage_id: foreignWon }), "Stage not found"],
      ["into another organisation's open stage", () => ({ stage_id: foreignOpen }), "Stage not found"],
    ];
    for (const [label, patch, message] of refusals) {
      for (const who of ["agent", "admin"] as const) {
        it(`refuses ${label} (${who}): the row and the chain untouched`, async () => {
          const deal = await newDeal({ accepted: 1000 });
          const before = await row(deal);
          const client = who === "agent" ? agent.client : admin.client;
          const r = await client.from("deals").update(patch()).eq("id", deal).select("id").maybeSingle();
          expect(r.error?.code, JSON.stringify(r.error)).toBe("P0001");
          expect(r.error?.message).toBe(message);
          expect(await row(deal)).toEqual(before);
          expect(await events(deal)).toEqual([]);
        });
      }
    }

    it("a bulk PATCH over several open deals is refused as a whole — none moves", async () => {
      const d1 = await newDeal({ accepted: 1000 });
      const d2 = await newDeal();
      const r = await admin.client.from("deals").update({ status: "won", won_at: nowIso() }).in("id", [d1, d2]);
      expect(r.error?.code).toBe("P0001");
      expect((await row(d1)).status).toBe("open");
      expect((await row(d2)).status).toBe("open");
      expect([...(await events(d1)), ...(await events(d2))]).toEqual([]);
    });

    it("ordinary edits and non-terminal stage moves still work — the deal's own writers", async () => {
      const deal = await newDeal({ accepted: 1000 });
      // updateDealSection's column set, recomputeDealHealth, logDealContact
      const edit = await agent.client
        .from("deals")
        .update({
          title: `ZZTEST edited ${RUN}`,
          expected_value: 200000,
          commission_split_notes: "50/50",
          health: { budget_confirmed: true },
          last_activity_at: nowIso(),
          last_contact_at: nowIso(),
        })
        .eq("id", deal)
        .select("id")
        .maybeSingle();
      expect(edit.error).toBeNull();
      expect(edit.data).toEqual({ id: deal });
      // a direct move to another open stage of its own pipeline
      const { rows: s } = await o.query<{ id: string }>(
        "select id from deal_stages where org_id = $1 and deal_type = 'sale' and sort_order = 2",
        [ORG],
      );
      const move = await agent.client.from("deals").update({ stage_id: s[0]!.id, stage_entered_at: nowIso() }).eq("id", deal).select("id").maybeSingle();
      expect(move.error).toBeNull();
      // and the kanban's RPC (0067), to the next open stage and back
      const { rows: s3 } = await o.query<{ id: string }>(
        "select id from deal_stages where org_id = $1 and deal_type = 'sale' and sort_order = 3",
        [ORG],
      );
      const kanban = await agent.client.rpc("move_deal_to_stage", { p_deal_id: deal, p_stage_id: s3[0]!.id });
      expect(kanban.error).toBeNull();
      expect(await row(deal)).toMatchObject({ status: "open", stage_id: s3[0]!.id, won_at: null, lost_at: null });
      expect((await events(deal)).map((e) => e.event_type)).toEqual(["stage_changed"]);
    });

    it("a deal reopened by maintenance keeps its previous lifecycle's values through an ordinary edit", async () => {
      const deal = await newDeal({ accepted: 1000 });
      await rpc(agent.client, deal, "lost", { reason: "First lifecycle kept" });
      expect((await svc.from("deals").update({ status: "open" }).eq("id", deal)).error).toBeNull();
      const edit = await agent.client.from("deals").update({ title: `ZZTEST reopened ${RUN}` }).eq("id", deal).select("id").maybeSingle();
      expect(edit.error).toBeNull();
      // …but may not rewrite or blank them on the user session
      const blank = await agent.client.from("deals").update({ lost_reason: null }).eq("id", deal);
      expect(blank.error?.message).toBe("Deal is open — its closing details are written only when it is marked won or lost");
      expect((await row(deal)).lost_reason).toBe("First lifecycle kept");
    });
  });

  describe("INSERT (POST) of a new deal", () => {
    const refusals: [string, () => Record<string, unknown>, string][] = [
      ["born won", () => ({ status: "won", won_at: nowIso(), final_value: 1 }), "A deal is created open — it is marked won or lost only from the deal page (close_deal)"],
      ["born lost", () => ({ status: "lost", lost_at: nowIso(), lost_reason: "Never open" }), "A deal is created open — it is marked won or lost only from the deal page (close_deal)"],
      ["open but carrying won_at", () => ({ won_at: nowIso() }), "A new deal cannot carry closing details — they are written when it is marked won or lost"],
      ["open but carrying a lost_reason", () => ({ lost_reason: "Pre-written" }), "A new deal cannot carry closing details — they are written when it is marked won or lost"],
      ["open but carrying a final_value", () => ({ final_value: 99 }), "A new deal cannot carry closing details — they are written when it is marked won or lost"],
      ["open in the Won stage", () => ({ stage_id: wonStage.id }), "Use the deal page to mark this deal won or lost (guarded flow)"],
      ["open in the Lost stage", () => ({ stage_id: lostStage.id }), "Use the deal page to mark this deal won or lost (guarded flow)"],
      ["open in another organisation's stage", () => ({ stage_id: foreignOpen }), "Stage not found"],
    ];
    for (const [label, extra, message] of refusals) {
      it(`refuses a deal ${label}: nothing inserted, no event`, async () => {
        const before = await orgDealCount();
        const r = await agent.client.from("deals").insert(insertable(extra())).select("id");
        expect(r.error?.code, JSON.stringify(r.error)).toBe("P0001");
        expect(r.error?.message).toBe(message);
        expect(await orgDealCount()).toBe(before);
      });
    }

    it("an ordinary open deal is still created by a user session (convertLead / createDeal's shape)", async () => {
      const r = await agent.client.from("deals").insert(insertable({ expected_value: 300000 })).select("id, status").single();
      expect(r.error).toBeNull();
      expect(r.data!.status).toBe("open");
      // …and explicitly open is fine too
      const explicit = await admin.client.from("deals").insert(insertable({ status: "open" })).select("id").single();
      expect(explicit.error).toBeNull();
    });
  });

  describe("UPSERT (POST with on_conflict)", () => {
    it("an upsert onto an existing OPEN deal cannot make it won: the INSERT arm refuses before the conflict is resolved", async () => {
      const deal = await newDeal({ accepted: 1000 });
      const before = await row(deal);
      const r = await agent.client
        .from("deals")
        .upsert(insertable({ id: deal, status: "won", won_at: nowIso() }), { onConflict: "id" })
        .select("id");
      expect(r.error?.code).toBe("P0001");
      expect(r.error?.message).toBe("A deal is created open — it is marked won or lost only from the deal page (close_deal)");
      expect(await row(deal)).toEqual(before);
      expect(await events(deal)).toEqual([]);
    });

    it("an upsert onto an existing CLOSED deal cannot reopen or re-detail it (the UPDATE arm, 0117's guard)", async () => {
      const deal = await newDeal();
      await rpc(agent.client, deal, "lost", { reason: "Closed before upsert" });
      const before = await row(deal);
      // status omitted and an open stage: the INSERT arm passes the proposed row;
      // the UPDATE arm then meets the closed one and its stage change
      const r = await agent.client
        .from("deals")
        .upsert(insertable({ id: deal }), { onConflict: "id" })
        .select("id");
      expect(r.error?.message).toMatch(/^Deal is already lost — /);
      expect(await row(deal)).toEqual(before);
    });

    it("an upsert of a NEW deal born won is refused; an ordinary upsert still merges", async () => {
      const id = randomUUID();
      const born = await agent.client.from("deals").upsert(insertable({ id, status: "won", won_at: nowIso() }), { onConflict: "id" });
      expect(born.error?.code).toBe("P0001");
      expect((await o.query("select 1 from deals where id = $1", [id])).rowCount).toBe(0);
      const deal = await newDeal();
      const merge = await agent.client
        .from("deals")
        .upsert(insertable({ id: deal, title: `ZZTEST merged ${RUN}` }), { onConflict: "id" })
        .select("id, status")
        .single();
      expect(merge.error).toBeNull();
      expect(merge.data!.status).toBe("open");
    });
  });

  describe("the safeguard's context cannot be forged from a user session", () => {
    it("claiming service_role inside the JWT claims setting does not change the role the guard reads", async () => {
      const deal = await newDeal();
      await asUser(a, agent.id);
      // what a caller controls: the claims a request carries
      await a.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: agent.id, role: "service_role", aal: "aal2" }),
      ]);
      await expect(a.query("update deals set status = 'won', won_at = now() where id = $1", [deal])).rejects.toThrow(
        /^Deal is open — it is marked won only from the deal page \(close_deal\)$/,
      );
      await a.query("rollback");
      expect((await row(deal)).status).toBe("open");
    });

    // The role itself is chosen by PostgREST from the VERIFIED token: its login
    // role (authenticator) may become service_role, so the signature is the
    // whole gate — which is what this probes. (A SQL session cannot be the
    // probe: SET ROLE checks the LOGIN role's memberships, and the harness
    // logs in as postgres.)
    it("a token claiming service_role that the project did not sign is rejected before any SQL runs", async () => {
      const deal = await newDeal();
      const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", sub: agent.id, exp: 4102444800 })}.${Buffer.from("not-the-secret").toString("base64url")}`;
      const res = await fetch(`${SUPABASE_URL}/rest/v1/deals?id=eq.${deal}`, {
        method: "PATCH",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${unsigned}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "won", won_at: nowIso() }),
      });
      expect(res.status).toBe(401);
      expect((await row(deal)).status).toBe("open");
    });

    it("no session flag opens the gate: setting one and PATCHing is still refused, and set_config is not an exposed RPC", async () => {
      const deal = await newDeal();
      const viaRest = await agent.client.rpc("set_config", { setting_name: "role", new_value: "service_role", is_local: true });
      expect(viaRest.error).not.toBeNull();
      await asUser(a, agent.id);
      for (const [k, v] of [["gnk.close_deal", deal], ["app.closing", "on"], ["request.close_deal", "true"]]) {
        await a.query("select set_config($1, $2, true)", [k, v]);
      }
      await expect(a.query("update deals set status = 'lost', lost_reason = 'forged' where id = $1", [deal])).rejects.toThrow(
        /marked lost only from the deal page/,
      );
      await a.query("rollback");
      expect((await row(deal)).status).toBe("open");
    });
  });

  it("the maintenance path is not bound: the service role may still correct an open deal directly (it logs its own event)", async () => {
    const deal = await newDeal();
    const fix = await svc.from("deals").update({ status: "lost", lost_at: nowIso(), lost_reason: "Operator correction" }).eq("id", deal);
    expect(fix.error).toBeNull();
    expect((await row(deal)).status).toBe("lost");
    const reopen = await svc.from("deals").update({ status: "open" }).eq("id", deal);
    expect(reopen.error).toBeNull();
  });
});

describe("the chain", () => {
  it("verifies for the throwaway organisation after every scenario above", async () => {
    const { rows } = await o.query<{ ok: boolean; reason: string | null }>(
      "select ok, reason from verify_events_chain($1::uuid, null::bigint)",
      [ORG],
    );
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
