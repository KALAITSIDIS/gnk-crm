import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_PASSWORD, anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { CODE_MD5_SQL, GUARD_0118, REVERT_0131_SQL, RPC_0067, readMigration0131 } from "./revert-0131";
import { REVERT_0133_SQL } from "./revert-0133";

/**
 * A deal's canonical `stage_changed` event records a movement that happened
 * (T-authentic-stage-movement, migration 0131).
 *
 * THE GAP (reproduced at 9913c74 / 0130 by this file): `events_insert` (0128)
 * refused a session's `won` / `lost` / `won_override` for a deal but nothing
 * about `stage_changed`. Any aal2 agent or admin could POST "New → Completed"
 * for a deal that never left New, with real stage ids and names, and
 * `report_stage_conversion` counted an entry into Completed while the won
 * outcome stayed 0. The mirror image held too: a session's direct PATCH of
 * `deals.stage_id` moved the deal with NO event at all, kept a
 * `stage_entered_at` of its choosing, and could park an open deal in another
 * deal type's stage. `move_deal_to_stage` was SECURITY INVOKER and inserted
 * the event as the caller, so the policy could not simply refuse it.
 *
 * THE DESIGN PINNED HERE: the event is DERIVED from the row change. An AFTER
 * UPDATE trigger on `deals` writes it — from OLD and NEW, the stage names read
 * in the deal's organisation, the actor from the session — whenever an open
 * deal's stage changes and it stays open. A session may no longer write the
 * event itself — under any entity_type. `move_deal_to_stage` stays an invoker
 * (RLS stays the authority for who may move what) and no longer inserts. A
 * session's direct PATCH / UPSERT is a movement like any other: same event,
 * same stamped `stage_entered_at` / `last_activity_at`, and the same deal-type
 * rule; and a session may not change a deal's id (its history is keyed by
 * it). close_deal's terminal transition is not a movement and writes no
 * `stage_changed` (it changes the status in the same UPDATE).
 *
 * TWO KINDS OF CALLER, both real (the deal-close.test.ts idiom):
 *  - supabase-js clients through PostgREST — how the app and any crafted
 *    request reach the database — for every role / MFA / ownership rule;
 *  - `pg` sessions impersonating a user inside a transaction for the ORDERED
 *    races: A moves and holds its transaction; B is observed blocked on A's
 *    row lock (pg_stat_activity), never a sleep; A commits or rolls back.
 *
 * Fixtures: two throwaway organisations, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);

let a: Client; // first mover
let b: Client; // competing mover
let o: Client; // observer as postgres: fixtures, barriers, verification, cleanup
let svc: SupabaseClient;

let admin: TestUser;
let agent: TestUser; // owns the deals
let peer: TestUser; // same organisation, owns nothing
let lm: TestUser; // listing manager: reads every deal, updates none
let inactive: TestUser; // owns a deal, then deactivated
let otherAdmin: TestUser; // another organisation
let otherAgent: TestUser;
let aal1: SupabaseClient; // the admin, signed in again without the second factor
const userIds: string[] = [];

type Stage = { id: string; name: string };
const S: Record<string, Stage> = {}; // ORG's sale stages by name
let rentalQualified: Stage;
let otherNew: Stage;
let otherQualified: Stage;
let n = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function stageOf(org: string, dealType: string, name: string): Promise<Stage> {
  const { rows } = await o.query<Stage>(
    "select id, name from deal_stages where org_id = $1 and deal_type = $2 and name = $3",
    [org, dealType, name],
  );
  if (!rows[0]) throw new Error(`no ${dealType} stage ${name} in ${org}`);
  return rows[0];
}

/** A deal written as postgres: a fixture, not a movement. */
async function newDeal(opts: { owner?: string; org?: string; stage?: Stage; accepted?: number } = {}) {
  n += 1;
  const org = opts.org ?? ORG;
  const stage = opts.stage ?? (org === ORG ? S.New : otherNew);
  const owner = opts.owner ?? agent.id;
  const { rows } = await o.query<{ id: string }>(
    `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by, expected_value)
     values ($1, 'sale', $2, $3, $4, $4, 100000) returning id`,
    [org, stage.id, `ZZTEST stage move ${RUN} ${n}`, owner],
  );
  const id = rows[0]!.id;
  if (opts.accepted != null) {
    await o.query("insert into offers (org_id, deal_id, amount, status, decided_at) values ($1, $2, $3, 'accepted', now())", [
      org,
      id,
      opts.accepted,
    ]);
  }
  return id;
}

type DealRow = {
  stage_id: string;
  status: string;
  stage_entered_at: Date;
  last_activity_at: Date | null;
  updated_at: Date;
  deal_type: string;
};
async function deal(id: string): Promise<DealRow> {
  const { rows } = await o.query<DealRow>(
    "select stage_id, status::text as status, stage_entered_at, last_activity_at, updated_at, deal_type::text as deal_type from deals where id = $1",
    [id],
  );
  return rows[0]!;
}

type Move = { id: string; org_id: string; actor_id: string | null; payload: Record<string, unknown>; occurred_at: Date };
/** Every deal stage_changed naming this entity — in ANY organisation's chain. */
async function moves(entityId: string): Promise<Move[]> {
  const { rows } = await o.query<Move>(
    `select id::text, org_id, actor_id, payload, occurred_at from events
      where entity_type = 'deal' and event_type = 'stage_changed' and entity_id = $1 order by id`,
    [entityId],
  );
  return rows;
}
async function eventTypes(entityId: string): Promise<string[]> {
  const { rows } = await o.query<{ event_type: string }>("select event_type from events where entity_id = $1 order by id", [
    entityId,
  ]);
  return rows.map((r) => r.event_type);
}

const payloadOf = (from: Stage, to: Stage) => ({ from: from.name, to: to.name, from_stage_id: from.id, to_stage_id: to.id });

type Conv = {
  moves_total: number;
  moves_with_ids: number;
  moves_malformed: number;
  stages: Array<{ stage: string; entered: number; advanced: number; advance_rate: number | null }>;
  transitions: Array<{ from: string | null; to: string | null; deals: number }>;
  outcomes: { won: number; lost: number };
};
let win: { p_from: string; p_to: string };
async function report(client: SupabaseClient, who: string): Promise<Conv> {
  const { data, error } = await client.rpc("report_stage_conversion", win);
  expect(error, `${who}: ${JSON.stringify(error)}`).toBeNull();
  return data as Conv;
}
const entered = (c: Conv, stage: string) => c.stages.find((s) => s.stage === stage)?.entered ?? 0;
const transition = (c: Conv, from: string, to: string) =>
  c.transitions.find((t) => t.from === from && t.to === to)?.deals ?? 0;

const rpcMove = (client: SupabaseClient, dealId: string, stage: Stage | string) =>
  client.rpc("move_deal_to_stage", { p_deal_id: dealId, p_stage_id: typeof stage === "string" ? stage : stage.id });

/** A session's direct INSERT of a canonical movement — what a crafted request sends. */
function forge(user: TestUser, dealId: string, payload: Record<string, unknown>, org = ORG) {
  return user.client
    .from("events")
    .insert({ org_id: org, actor_id: user.id, entity_type: "deal", entity_id: dealId, event_type: "stage_changed", payload })
    .select("id");
}

/** Open a transaction on `c` as `uid` — the only way `set local role` holds. */
async function asUser(c: Client, uid: string, aal: "aal1" | "aal2" = "aal2") {
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal })]);
}
const moveSql = (c: Client, dealId: string, stage: Stage) =>
  c.query("select public.move_deal_to_stage($1::uuid, $2::uuid)", [dealId, stage.id]);

async function pidOf(c: Client) {
  return (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
}
async function until(label: string, cond: () => Promise<boolean>, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`barrier timed out: ${label}`);
}
/** Barrier: that backend is blocked waiting for another transaction's row lock. */
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
  tracked.catch(() => {}); // handled at creation (deal-close.test.ts, CI run 36474616830)
  return { done: () => done, value: () => tracked };
}

/** Refuse ONE event type for ONE entity, in the database (committed); returns the remover. */
async function failEvent(entityId: string, eventType: string) {
  n += 1;
  const fn = `zz_sma_fail_${RUN}_${n}`;
  if (!/^[0-9a-f-]{36}$/.test(entityId) || !/^[a-z_]+$/.test(eventType)) throw new Error("bad input");
  // one transaction: a failure between the function and its trigger leaves
  // neither behind
  await o.query("begin");
  try {
    await o.query(
      `create function public.${fn}() returns trigger language plpgsql set search_path = public, pg_temp as $f$
       begin
         if new.entity_id = '${entityId}'::uuid and new.event_type = '${eventType}' then
           raise exception 'injected failure: % event refused', new.event_type;
         end if;
         return new;
       end $f$`,
    );
    await o.query(`revoke all on function public.${fn}() from public, anon, authenticated, service_role`);
    await o.query(`create trigger ${fn} before insert on public.events for each row execute function public.${fn}()`);
    await o.query("commit");
  } catch (e) {
    await o.query("rollback");
    throw e;
  }
  return async () => {
    await o.query(`drop trigger if exists ${fn} on public.events`);
    await o.query(`drop function if exists public.${fn}()`);
  };
}

/** Injectors a crashed run left behind — triggers AND functions. */
async function dropStaleInjectors() {
  const { rows: trg } = await o.query<{ tgname: string }>(
    "select tgname from pg_trigger where tgrelid = 'public.events'::regclass and tgname like 'zz\\_sma\\_fail\\_%'",
  );
  for (const t of trg) await o.query(`drop trigger if exists ${t.tgname} on public.events`);
  const { rows: fns } = await o.query<{ proname: string }>(
    "select proname from pg_proc where pronamespace = 'public'::regnamespace and proname like 'zz\\_sma\\_fail\\_%'",
  );
  for (const f of fns) await o.query(`drop function if exists public.${f.proname}()`);
}

beforeAll(async () => {
  svc = serviceClient();
  a = new Client({ connectionString: DB_URL });
  b = new Client({ connectionString: DB_URL });
  o = new Client({ connectionString: DB_URL });
  await Promise.all([a.connect(), b.connect(), o.connect()]);
  await dropStaleInjectors();

  await ensureTestOrg(svc, ORG, `stage move ${RUN}`, `stage-move-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `stage move other ${RUN}`, `stage-move-other-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors
  admin = await createTestUser(svc, `sm-admin-${RUN}@test.local`, "admin", ORG);
  agent = await createTestUser(svc, `sm-agent-${RUN}@test.local`, "agent", ORG);
  peer = await createTestUser(svc, `sm-peer-${RUN}@test.local`, "agent", ORG);
  lm = await createTestUser(svc, `sm-lm-${RUN}@test.local`, "listing_manager", ORG);
  inactive = await createTestUser(svc, `sm-inactive-${RUN}@test.local`, "agent", ORG);
  otherAdmin = await createTestUser(svc, `sm-other-admin-${RUN}@test.local`, "admin", OTHER_ORG);
  otherAgent = await createTestUser(svc, `sm-other-agent-${RUN}@test.local`, "agent", OTHER_ORG);
  userIds.push(admin.id, agent.id, peer.id, lm.id, inactive.id, otherAdmin.id, otherAgent.id);
  aal1 = anonClient();
  const signIn = await aal1.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD });
  if (signIn.error) throw new Error(`aal1 sign-in: ${signIn.error.message}`);

  for (const name of ["New", "Qualified", "Viewing", "Offer", "Reservation", "Completed", "Lost"]) {
    S[name] = await stageOf(ORG, "sale", name);
  }
  rentalQualified = await stageOf(ORG, "rental", "Qualified");
  otherNew = await stageOf(OTHER_ORG, "sale", "New");
  otherQualified = await stageOf(OTHER_ORG, "sale", "Qualified");

  const t0 = (await o.query<{ t: Date }>("select clock_timestamp() as t")).rows[0]!.t;
  win = { p_from: new Date(t0.getTime() - 1000).toISOString(), p_to: new Date(Date.now() + 2 * 3600_000).toISOString() };
});

afterEach(async () => {
  // both at once: a session blocked on the other's lock queues its rollback
  // behind the blocked statement (the events-chain-order lesson)
  await Promise.all([a.query("rollback").catch(() => undefined), b.query("rollback").catch(() => undefined)]);
});

afterAll(async () => {
  await dropStaleInjectors();
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
describe("1. a session cannot write a movement it did not make", () => {
  it("the reported case: the deal's agent POSTs New → Completed for a deal that stays in New — refused, nothing kept, no figure moves", async () => {
    const id = await newDeal();
    const before = { deal: await deal(id), admin: await report(admin.client, "admin"), other: await report(otherAdmin.client, "other") };
    const r = await forge(agent, id, payloadOf(S.New, S.Completed));
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
    expect(await moves(id)).toEqual([]);
    expect(await deal(id), "the deal never moved").toEqual(before.deal);
    const after = await report(admin.client, "admin");
    expect(after, "no entry into Completed, no transition, no won outcome").toEqual(before.admin);
    expect(entered(after, "Completed")).toBe(0);
    expect(after.outcomes.won).toBe(before.admin.outcomes.won);
    expect(await report(otherAdmin.client, "other"), "another organisation is untouched").toEqual(before.other);
  });

  const variants: Array<[string, () => Record<string, unknown>]> = [
    ["a plausible next step (New → Qualified) with valid ids", () => payloadOf(S.New, S.Qualified)],
    ["a move from a stage the deal is not in", () => payloadOf(S.Viewing, S.Offer)],
    ["into the Lost stage", () => payloadOf(S.New, S.Lost)],
    ["ids only", () => ({ from_stage_id: S.New.id, to_stage_id: S.Qualified.id })],
    ["names only (the pre-0067 shape)", () => ({ from: "New", to: "Qualified" })],
    ["an empty payload", () => ({})],
  ];
  for (const [label, payload] of variants) {
    for (const who of ["admin", "agent"] as const) {
      it(`${label}, from the ${who}: refused, nothing kept`, async () => {
        const id = await newDeal();
        const before = await deal(id);
        const r = await forge(who === "admin" ? admin : agent, id, payload());
        expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
        expect(await moves(id)).toEqual([]);
        expect(await deal(id)).toEqual(before);
      });
    }
  }

  it("a bulk insert carrying one movement among ordinary events is refused whole", async () => {
    const id = await newDeal();
    const r = await admin.client.from("events").insert([
      { org_id: ORG, actor_id: admin.id, entity_type: "deal", entity_id: id, event_type: "updated", payload: {} },
      { org_id: ORG, actor_id: admin.id, entity_type: "deal", entity_id: id, event_type: "stage_changed", payload: payloadOf(S.New, S.Qualified) },
    ]);
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
    expect(await eventTypes(id)).toEqual([]);
  });

  it("the exact type under any other entity_type is refused too — the timeline would still print it as a move", async () => {
    const id = await newDeal();
    for (const entityType of ["Deal", "deals", "offer", "lead"]) {
      const r = await admin.client
        .from("events")
        .insert({ org_id: ORG, actor_id: admin.id, entity_type: entityType, entity_id: id, event_type: "stage_changed", payload: payloadOf(S.New, S.Completed) });
      expect(r.error?.code, `${entityType}: ${JSON.stringify(r.error)}`).toBe("42501");
    }
    expect(await eventTypes(id)).toEqual([]);
  });

  it("another organisation's admin cannot plant one in its own chain about this organisation's deal", async () => {
    const id = await newDeal();
    const before = await report(otherAdmin.client, "other");
    const r = await forge(otherAdmin, id, payloadOf(S.New, S.Completed), OTHER_ORG);
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
    expect(await moves(id)).toEqual([]);
    expect(await report(otherAdmin.client, "other")).toEqual(before);
  });

  it("an aal1 session, a listing manager and anon are refused too", async () => {
    const id = await newDeal();
    const at1 = await aal1
      .from("events")
      .insert({ org_id: ORG, actor_id: admin.id, entity_type: "deal", entity_id: id, event_type: "stage_changed", payload: payloadOf(S.New, S.Qualified) });
    expect(at1.error?.code, JSON.stringify(at1.error)).toBe("42501");
    const byLm = await forge(lm, id, payloadOf(S.New, S.Qualified));
    expect(byLm.error?.code, JSON.stringify(byLm.error)).toBe("42501");
    const byAnon = await anonClient()
      .from("events")
      .insert({ org_id: ORG, entity_type: "deal", entity_id: id, event_type: "stage_changed", payload: {} });
    expect(byAnon.error, "anon has no INSERT").not.toBeNull();
    expect(await moves(id)).toEqual([]);
  });

  it("a session's ordinary deal events still write (0128's paths unchanged)", async () => {
    const id = await newDeal();
    const r = await agent.client
      .from("events")
      .insert({ org_id: ORG, actor_id: agent.id, entity_type: "deal", entity_id: id, event_type: "updated", payload: {} });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("2. a permitted movement records exactly what happened, once", () => {
  it("move_deal_to_stage by the deal's agent: one event, actual stages, the caller as actor, one transaction", async () => {
    const id = await newDeal();
    const before = await report(admin.client, "admin");
    const r = await rpcMove(agent.client, id, S.Qualified);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const ev = await moves(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ org_id: ORG, actor_id: agent.id, payload: payloadOf(S.New, S.Qualified) });
    const d = await deal(id);
    expect(d.stage_id).toBe(S.Qualified.id);
    expect(d.stage_entered_at.getTime(), "stage_entered_at is the event's own time").toBe(ev[0]!.occurred_at.getTime());
    expect(d.last_activity_at!.getTime()).toBe(ev[0]!.occurred_at.getTime());
    const after = await report(admin.client, "admin");
    expect(entered(after, "Qualified") - entered(before, "Qualified")).toBe(1);
    expect(transition(after, "New", "Qualified") - transition(before, "New", "Qualified")).toBe(1);
    expect(after.moves_total - before.moves_total).toBe(1);
    expect(after.moves_with_ids - before.moves_with_ids).toBe(1);
  });

  it("an admin moving the agent's deal is the actor; a chain of moves records each previous stage", async () => {
    const id = await newDeal();
    expect((await rpcMove(admin.client, id, S.Qualified)).error).toBeNull();
    expect((await rpcMove(agent.client, id, S.Viewing)).error).toBeNull();
    expect((await rpcMove(admin.client, id, S.Qualified)).error, "backwards is a movement too").toBeNull();
    const ev = await moves(id);
    expect(ev.map((e) => [e.actor_id, e.payload])).toEqual([
      [admin.id, payloadOf(S.New, S.Qualified)],
      [agent.id, payloadOf(S.Qualified, S.Viewing)],
      [admin.id, payloadOf(S.Viewing, S.Qualified)],
    ]);
  });

  it("a no-op move and a retried move write nothing more", async () => {
    const id = await newDeal();
    expect((await rpcMove(agent.client, id, S.New)).error, "onto its own column").toBeNull();
    expect(await moves(id)).toEqual([]);
    const untouched = await deal(id);
    expect((await rpcMove(agent.client, id, S.Qualified)).error).toBeNull();
    const once = await deal(id);
    expect(once.stage_entered_at.getTime()).toBeGreaterThan(untouched.stage_entered_at.getTime());
    // the client retries the request it already completed
    expect((await rpcMove(agent.client, id, S.Qualified)).error).toBeNull();
    expect((await rpcMove(agent.client, id, S.Qualified)).error).toBeNull();
    expect(await moves(id)).toHaveLength(1);
    expect(await deal(id), "the retry changed nothing on the row").toEqual(once);
  });

  const refusedTargets: Array<[string, () => Stage | string, RegExp]> = [
    ["the Won stage", () => S.Completed, /guarded flow/],
    ["the Lost stage", () => S.Lost, /guarded flow/],
    ["another deal type's stage", () => rentalQualified, /another deal type/],
    ["another organisation's stage", () => otherQualified, /Stage not found/],
    ["a stage that does not exist", () => randomUUID(), /Stage not found/],
  ];
  for (const [label, target, message] of refusedTargets) {
    it(`a move to ${label} is refused and writes nothing`, async () => {
      const id = await newDeal();
      const before = await deal(id);
      const r = await rpcMove(admin.client, id, target());
      expect(r.error?.message ?? "", JSON.stringify(r.error)).toMatch(message);
      expect(await deal(id)).toEqual(before);
      expect(await moves(id)).toEqual([]);
    });
  }

  it("a closed deal does not move, by the RPC or by a PATCH", async () => {
    const id = await newDeal();
    const closed = await agent.client.rpc("close_deal", {
      p_deal_id: id,
      p_outcome: "lost",
      p_final_value: null,
      p_lost_reason: "Closed before a move",
      p_override: false,
    });
    expect(closed.error, JSON.stringify(closed.error)).toBeNull();
    const before = await deal(id);
    expect((await rpcMove(admin.client, id, S.Qualified)).error?.message).toMatch(/closed deals do not move stages/);
    const patch = await admin.client.from("deals").update({ stage_id: S.Qualified.id }).eq("id", id).select("id");
    expect(patch.error?.message, JSON.stringify(patch.error)).toMatch(/cannot be changed/);
    expect(await deal(id)).toEqual(before);
    expect(await moves(id)).toEqual([]);
  });

  it("callers who may not move this deal are refused and write nothing: a peer agent, a listing manager, another organisation, aal1, anon, a deactivated owner", async () => {
    const id = await newDeal();
    const owned = await newDeal({ owner: inactive.id });
    const before = { id: await deal(id), owned: await deal(owned) };
    const cases: Array<[string, SupabaseClient, string]> = [
      ["peer agent", peer.client, id],
      ["listing manager", lm.client, id],
      ["another organisation's admin", otherAdmin.client, id],
      ["the admin at aal1", aal1, id],
      ["anon", anonClient(), id],
    ];
    for (const [who, client, target] of cases) {
      const r = await rpcMove(client, target, S.Qualified);
      expect(r.error, `${who} must be refused`).not.toBeNull();
    }
    await o.query("update profiles set is_active = false where id = $1", [inactive.id]);
    const r = await rpcMove(inactive.client, owned, S.Qualified);
    expect(r.error, "a deactivated owner must be refused").not.toBeNull();
    expect(await deal(id)).toEqual(before.id);
    expect(await deal(owned)).toEqual(before.owned);
    expect(await moves(id)).toEqual([]);
    expect(await moves(owned)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("3. a direct write to a deal's stage cannot bypass the record", () => {
  it("the owner's PATCH is a movement: one event with the actual stages, stage_entered_at and last_activity_at stamped by the database", async () => {
    const id = await newDeal();
    const r = await agent.client
      .from("deals")
      .update({ stage_id: S.Qualified.id, stage_entered_at: "2001-01-01T00:00:00Z", last_activity_at: "2001-01-01T00:00:00Z" })
      .eq("id", id)
      .select("id");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.data).toHaveLength(1);
    const ev = await moves(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ org_id: ORG, actor_id: agent.id, payload: payloadOf(S.New, S.Qualified) });
    const d = await deal(id);
    expect(d.stage_id).toBe(S.Qualified.id);
    // (a LATER PATCH of stage_entered_at alone is still accepted — BACKLOG
    // "Deal fields around a close that nothing freezes")
    expect(d.stage_entered_at.getTime(), "a stage-changing PATCH does not choose when the stage was entered").toBe(
      ev[0]!.occurred_at.getTime(),
    );
    expect(d.last_activity_at!.getTime()).toBe(ev[0]!.occurred_at.getTime());
  });

  it("an admin's UPSERT that changes the stage is a movement too", async () => {
    const id = await newDeal();
    const r = await admin.client
      .from("deals")
      .upsert(
        {
          id,
          org_id: ORG,
          deal_type: "sale",
          stage_id: S.Viewing.id,
          title: `ZZTEST upsert ${RUN}`,
          agent_id: agent.id,
          created_by: agent.id,
        },
        { onConflict: "id" },
      )
      .select("id");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const ev = await moves(id);
    expect(ev.map((e) => [e.actor_id, e.payload])).toEqual([[admin.id, payloadOf(S.New, S.Viewing)]]);
  });

  it("one PATCH moving two deals records one movement per deal", async () => {
    const d1 = await newDeal();
    const d2 = await newDeal({ stage: S.Qualified });
    const r = await admin.client.from("deals").update({ stage_id: S.Offer.id }).in("id", [d1, d2]).select("id");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect((await moves(d1)).map((e) => e.payload)).toEqual([payloadOf(S.New, S.Offer)]);
    expect((await moves(d2)).map((e) => e.payload)).toEqual([payloadOf(S.Qualified, S.Offer)]);
  });

  it("a PATCH that leaves the stage as it is writes no movement", async () => {
    const id = await newDeal();
    const r1 = await agent.client.from("deals").update({ title: `ZZTEST renamed ${RUN}` }).eq("id", id).select("id");
    expect(r1.error).toBeNull();
    const r2 = await agent.client.from("deals").update({ stage_id: S.New.id }).eq("id", id).select("id");
    expect(r2.error).toBeNull();
    expect(await moves(id)).toEqual([]);
  });

  it("a PATCH into another deal type's stage is refused, as the RPC refuses it", async () => {
    const id = await newDeal();
    const before = await deal(id);
    const r = await admin.client.from("deals").update({ stage_id: rentalQualified.id }).eq("id", id).select("id");
    expect(r.error?.code, JSON.stringify(r.error)).toBe("P0001");
    expect(await deal(id)).toEqual(before);
    expect(await moves(id)).toEqual([]);
  });

  it("the type rule binds whichever side of the pair a session sets: a deal born in another pipeline's stage, a deal_type change alone", async () => {
    const born = await agent.client
      .from("deals")
      .insert({ org_id: ORG, deal_type: "sale", stage_id: rentalQualified.id, title: `ZZTEST born rental ${RUN}`, agent_id: agent.id, created_by: agent.id })
      .select("id");
    expect(born.error?.code, JSON.stringify(born.error)).toBe("P0001");
    expect(born.error?.message).toBe("Stage belongs to another deal type");
    const id = await newDeal();
    const before = await deal(id);
    const retyped = await admin.client.from("deals").update({ deal_type: "rental" }).eq("id", id).select("id");
    expect(retyped.error?.code, JSON.stringify(retyped.error)).toBe("P0001");
    expect(retyped.error?.message).toBe("Stage belongs to another deal type");
    expect(await deal(id)).toEqual(before);
    expect(await moves(id)).toEqual([]);
  });

  it("a session cannot re-key a deal, with or without a stage change — its history stays its own", async () => {
    const id = await newDeal();
    const before = await deal(id);
    for (const patch of [{ id: randomUUID(), stage_id: S.Qualified.id }, { id: randomUUID() }]) {
      const r = await admin.client.from("deals").update(patch).eq("id", id).select("id");
      expect(r.error?.code, JSON.stringify(r.error)).toBe("P0001");
      expect(r.error?.message).toBe("A deal's id cannot be changed");
    }
    expect(await deal(id)).toEqual(before);
    expect(await moves(id)).toEqual([]);
  });

  it("a PATCH that changes the type and the stage together, consistently, is recorded as the movement it is", async () => {
    // whether deal_type should be writable at all is BACKLOG's decision; what
    // 0131 pins is that the event follows the row, whatever wrote it
    const id = await newDeal();
    const r = await admin.client.from("deals").update({ deal_type: "rental", stage_id: rentalQualified.id }).eq("id", id).select("id");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect((await moves(id)).map((e) => [e.actor_id, e.payload])).toEqual([[admin.id, payloadOf(S.New, rentalQualified)]]);
    expect((await deal(id)).deal_type).toBe("rental");
  });

  it("a PATCH into the Won or Lost stage, or another organisation's stage, stays refused (0118) and writes nothing", async () => {
    const id = await newDeal();
    const before = await deal(id);
    for (const target of [S.Completed, S.Lost, otherQualified]) {
      const r = await agent.client.from("deals").update({ stage_id: target.id }).eq("id", id).select("id");
      expect(r.error?.code, `${target.name}: ${JSON.stringify(r.error)}`).toBe("P0001");
    }
    expect(await deal(id)).toEqual(before);
    expect(await moves(id)).toEqual([]);
  });

  it("a PATCH by someone who may not update the deal matches nothing and writes nothing", async () => {
    const id = await newDeal();
    const before = await deal(id);
    for (const [who, client] of [
      ["peer", peer.client],
      ["listing manager", lm.client],
      ["another organisation", otherAdmin.client],
      ["aal1", aal1],
    ] as const) {
      const r = await client.from("deals").update({ stage_id: S.Qualified.id }).eq("id", id).select("id");
      expect(r.data ?? [], `${who}: ${JSON.stringify(r.error)}`).toEqual([]);
    }
    expect(await deal(id)).toEqual(before);
    expect(await moves(id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("4. closing a deal is not a stage movement (close_deal unchanged)", () => {
  async function close(client: SupabaseClient, id: string, outcome: "won" | "lost", opts: { override?: boolean; reason?: string } = {}) {
    const r = await client.rpc("close_deal", {
      p_deal_id: id,
      p_outcome: outcome,
      p_final_value: null,
      p_lost_reason: opts.reason ?? null,
      p_override: opts.override ?? false,
    });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return r.data as { result: string };
  }

  it("Won with an accepted offer, Lost with a reason, Won by admin override: their own events only, no stage_changed; the report counts outcomes, not entries", async () => {
    const won = await newDeal({ accepted: 250000, stage: S.Offer });
    const lost = await newDeal({ stage: S.Qualified });
    const overridden = await newDeal({ stage: S.Viewing });
    const before = await report(admin.client, "admin");
    expect((await close(agent.client, won, "won")).result).toBe("closed");
    expect((await close(agent.client, lost, "lost", { reason: "Bought elsewhere" })).result).toBe("closed");
    expect((await close(admin.client, overridden, "won", { override: true })).result).toBe("closed");
    expect(await eventTypes(won)).toEqual(["won"]);
    expect(await eventTypes(lost)).toEqual(["lost"]);
    expect(await eventTypes(overridden)).toEqual(["won_override", "won"]);
    expect((await deal(won)).stage_id).toBe(S.Completed.id);
    expect((await deal(lost)).stage_id).toBe(S.Lost.id);
    const after = await report(admin.client, "admin");
    expect(after.outcomes).toEqual({ won: before.outcomes.won + 2, lost: before.outcomes.lost + 1 });
    expect(entered(after, "Completed"), "a close is not an entry into the Won stage").toBe(entered(before, "Completed"));
    expect(entered(after, "Lost")).toBe(entered(before, "Lost"));
    expect(after.moves_total).toBe(before.moves_total);
  });

  it("an agent without an accepted offer still cannot close Won, and nothing is written", async () => {
    const id = await newDeal();
    const r = await agent.client.rpc("close_deal", {
      p_deal_id: id,
      p_outcome: "won",
      p_final_value: null,
      p_lost_reason: null,
      p_override: false,
    });
    expect(r.error?.message).toMatch(/accepted offer/);
    expect(await eventTypes(id)).toEqual([]);
  });

  it("Lost still requires a reason", async () => {
    const id = await newDeal();
    const r = await agent.client.rpc("close_deal", {
      p_deal_id: id,
      p_outcome: "lost",
      p_final_value: null,
      p_lost_reason: " ",
      p_override: false,
    });
    expect(r.error?.message).toMatch(/reason is required/);
    expect(await eventTypes(id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("5. concurrent movements record the serialised sequence — genuine concurrent sessions", () => {
  /** A moves and holds; B is seen blocked on A's row lock; A ends; B returns and commits. */
  async function race(id: string, first: Stage, second: (c: Client) => Promise<unknown>, endFirst: "commit" | "rollback" = "commit") {
    await asUser(a, agent.id);
    await moveSql(a, id, first);
    await asUser(b, admin.id);
    const pidB = await pidOf(b);
    const pb = settled(second(b));
    await until("B is blocked on A's row lock", waitsOnRowLock(pidB));
    expect(pb.done(), "B must wait while A holds the row").toBe(false);
    await a.query(endFirst);
    await pb.value();
    await b.query("commit");
  }

  it("two moves to different stages: two events, each naming the stage actually left", async () => {
    const id = await newDeal();
    await race(id, S.Qualified, (c) => moveSql(c, id, S.Viewing));
    expect((await moves(id)).map((e) => [e.actor_id, e.payload])).toEqual([
      [agent.id, payloadOf(S.New, S.Qualified)],
      [admin.id, payloadOf(S.Qualified, S.Viewing)],
    ]);
    expect((await deal(id)).stage_id).toBe(S.Viewing.id);
  });

  it("two moves to the same stage: one event — the second finds nothing to move", async () => {
    const id = await newDeal();
    await race(id, S.Qualified, (c) => moveSql(c, id, S.Qualified));
    const ev = await moves(id);
    expect(ev.map((e) => e.payload)).toEqual([payloadOf(S.New, S.Qualified)]);
    // …and B returned at its no-op check under the lock rather than rewriting
    // the row: the entry time is still A's, in A's transaction
    const d = await deal(id);
    expect(d.stage_entered_at.getTime()).toBe(ev[0]!.occurred_at.getTime());
    expect(d.last_activity_at!.getTime()).toBe(ev[0]!.occurred_at.getTime());
  });

  it("the first rolls back: only the second's movement exists, from the stage it really left", async () => {
    const id = await newDeal();
    await race(id, S.Qualified, (c) => moveSql(c, id, S.Viewing), "rollback");
    expect((await moves(id)).map((e) => [e.actor_id, e.payload])).toEqual([[admin.id, payloadOf(S.New, S.Viewing)]]);
  });

  it("a direct UPDATE waiting behind an RPC move records the stage it actually replaced", async () => {
    const id = await newDeal();
    await race(id, S.Qualified, (c) => c.query("update deals set stage_id = $2 where id = $1", [id, S.Offer.id]));
    expect((await moves(id)).map((e) => e.payload)).toEqual([payloadOf(S.New, S.Qualified), payloadOf(S.Qualified, S.Offer)]);
    expect((await deal(id)).stage_id).toBe(S.Offer.id);
  });
});

// ---------------------------------------------------------------------------
describe("6. the movement and its event commit together", () => {
  it("an event-write failure rolls the RPC's movement back", async () => {
    const id = await newDeal();
    const before = await deal(id);
    const remove = await failEvent(id, "stage_changed");
    try {
      const r = await rpcMove(agent.client, id, S.Qualified);
      expect(r.error?.message ?? "", JSON.stringify(r.error)).toMatch(/injected failure/);
    } finally {
      await remove();
    }
    expect(await deal(id)).toEqual(before);
    expect(await moves(id)).toEqual([]);
  });

  it("an event-write failure rolls a PATCH's movement back", async () => {
    const id = await newDeal();
    const before = await deal(id);
    const remove = await failEvent(id, "stage_changed");
    try {
      const r = await agent.client.from("deals").update({ stage_id: S.Qualified.id }).eq("id", id).select("id");
      expect(r.error?.message ?? "", JSON.stringify(r.error)).toMatch(/injected failure/);
    } finally {
      await remove();
    }
    expect(await deal(id)).toEqual(before);
    expect(await moves(id)).toEqual([]);
  });

  it("a transaction that moves and then rolls back leaves neither the movement nor its event", async () => {
    const id = await newDeal();
    const before = await deal(id);
    await asUser(a, agent.id);
    await moveSql(a, id, S.Qualified);
    const inside = await a.query<{ n: number }>(
      "select count(*)::int as n from events where entity_id = $1 and event_type = 'stage_changed'",
      [id],
    );
    expect(inside.rows[0]!.n, "inside the transaction the event exists beside the move").toBe(1);
    await a.query("rollback");
    expect(await deal(id)).toEqual(before);
    expect(await moves(id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("7. the trusted maintenance paths, deliberately", () => {
  it("a service-role stage change on an open deal is recorded as a system movement (no actor), with the timestamps it chose", async () => {
    const id = await newDeal();
    const chosen = "2026-01-02T03:04:05.000Z";
    const r = await svc
      .from("deals")
      .update({ stage_id: S.Qualified.id, stage_entered_at: chosen, last_activity_at: chosen })
      .eq("id", id)
      .select("id");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect((await moves(id)).map((e) => [e.actor_id, e.payload])).toEqual([[null, payloadOf(S.New, S.Qualified)]]);
    // the database's clock binds sessions only (the guard's rule)
    const d = await deal(id);
    expect(d.stage_entered_at.toISOString()).toBe(chosen);
    expect(d.last_activity_at!.toISOString()).toBe(chosen);
  });

  it("a maintenance reopen that also changes the stage is not a movement either", async () => {
    const id = await newDeal({ stage: S.Viewing });
    const closed = await agent.client.rpc("close_deal", {
      p_deal_id: id,
      p_outcome: "lost",
      p_final_value: null,
      p_lost_reason: "Closed before a reopen into another stage",
      p_override: false,
    });
    expect(closed.error, JSON.stringify(closed.error)).toBeNull();
    const r = await svc.from("deals").update({ status: "open", stage_id: S.Qualified.id }).eq("id", id).select("id");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(await moves(id), "lost → open with a stage is a reopen, not a pipeline movement").toEqual([]);
    expect((await rpcMove(agent.client, id, S.Offer)).error).toBeNull();
    expect((await moves(id)).map((e) => e.payload)).toEqual([payloadOf(S.Qualified, S.Offer)]);
  });

  it("a maintenance reopen is not a movement; the next move records the stage the deal really left", async () => {
    const id = await newDeal({ stage: S.Qualified });
    const closed = await agent.client.rpc("close_deal", {
      p_deal_id: id,
      p_outcome: "lost",
      p_final_value: null,
      p_lost_reason: "Closed before a maintenance reopen",
      p_override: false,
    });
    expect(closed.error, JSON.stringify(closed.error)).toBeNull();
    expect((await svc.from("deals").update({ status: "open" }).eq("id", id)).error).toBeNull();
    expect(await moves(id), "the reopen wrote no movement").toEqual([]);
    expect((await rpcMove(agent.client, id, S.Viewing)).error).toBeNull();
    expect((await moves(id)).map((e) => e.payload)).toEqual([payloadOf(S.Lost, S.Viewing)]);
  });

  it("a maintenance write pointing an open deal at another organisation's stage records that stage's id, never its name", async () => {
    // only postgres / the service role can store such a stage (the guard binds
    // sessions); the event lands in the deal's own chain, so the other
    // organisation's stage NAME must not travel with it
    const id = await newDeal();
    await o.query("update deals set stage_id = $2 where id = $1", [id, otherQualified.id]);
    const ev = await moves(id);
    expect(ev.map((e) => [e.org_id, e.actor_id, e.payload])).toEqual([
      [ORG, null, { from: S.New.name, to: otherQualified.id, from_stage_id: S.New.id, to_stage_id: otherQualified.id }],
    ]);
    await o.query("update deals set stage_id = $2 where id = $1", [id, S.New.id]); // back home, for the cleanup's sake
  });

  it("a maintenance move to another organisation is not a pipeline movement: no event in either chain", async () => {
    const id = await newDeal();
    await o.query("update deals set org_id = $2, stage_id = $3 where id = $1", [id, OTHER_ORG, otherQualified.id]);
    expect(await moves(id)).toEqual([]);
  });

  it("the service role may still write a historical movement event (imports, restores) — RLS binds sessions only", async () => {
    const id = await newDeal();
    const r = await svc
      .from("events")
      .insert({ org_id: ORG, entity_type: "deal", entity_id: id, event_type: "stage_changed", payload: payloadOf(S.New, S.Qualified), occurred_at: "2024-03-04T05:06:07Z" })
      .select("id");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(await moves(id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("8. the mechanism, and the chain", () => {
  it("the event writer is a SECURITY DEFINER trigger function nobody can call, fired AFTER UPDATE per row for an open deal's stage change", async () => {
    const { rows } = await o.query(`
      select t.tgname, pg_get_triggerdef(t.oid) as def, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
             has_function_privilege('authenticated', p.oid, 'execute') as authed,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.deals'::regclass and not t.tgisinternal and p.proname = 'trg_deals_stage_changed_event'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prosecdef: true, owner: "postgres", proconfig: ["search_path=public, pg_temp"], authed: false, anon: false, svc: false });
    expect(rows[0].def).toMatch(/AFTER UPDATE ON public\.deals FOR EACH ROW WHEN/);
    expect(rows[0].def).toMatch(/old\.stage_id IS DISTINCT FROM new\.stage_id/);
    expect(rows[0].def).toMatch(/old\.org_id = new\.org_id/);
    // the enforcement boundary is kept on the trigger itself (0131's postflight)
    const { rows: c } = await o.query<{ d: string | null }>(
      "select obj_description(t.oid, 'pg_trigger') as d from pg_trigger t where t.tgrelid = 'public.deals'::regclass and t.tgname = 'deals_stage_changed_event'",
    );
    expect(c[0]!.d).toMatch(
      /^Writes a deal's stage_changed from OLD \/ NEW \(0131\)\. Sessions may not write stage_changed from event id > \d+ \(rows above it come from this trigger or the service role — imports, restores\); at or below it, \d+ deal stage_changed event\(s\) were written before 0131 and are uncertified\.$/,
    );
  });

  it("move_deal_to_stage stays SECURITY INVOKER with its grants, and no longer inserts an event itself", async () => {
    const { rows } = await o.query(`
      select p.prosecdef, p.proconfig, pg_get_function_result(p.oid) as result, regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') as src,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authed,
             has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p where p.oid = 'public.move_deal_to_stage(uuid, uuid)'::regprocedure`);
    expect(rows[0]).toMatchObject({ prosecdef: false, proconfig: ["search_path=public"], result: "void", anon: false, authed: true, svc: true });
    expect(rows[0].src).not.toMatch(/insert\s+into\s+(public\.)?events/i);
  });

  it("both organisations' chains verify end to end", async () => {
    for (const org of [ORG, OTHER_ORG]) {
      expect((await o.query("select public.verify_events_chain($1) as ok", [org])).rows[0].ok, org).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("9. the migration: it replays over 0130, refuses what it was not written against, and its rollback restores 0130", () => {
  /** Run `body` in a transaction on `o` that is always rolled back; collect NOTICEs. */
  async function rolledBack(body: (notices: string[]) => Promise<void>) {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
    o.on("notice", onNotice);
    await o.query("begin");
    // the rollback recipe's DDL runs before the file's own lock_timeout: on a
    // shared stack, wait at most 5 s for a lock, then fail cleanly
    await o.query("set local lock_timeout = '5s'");
    try {
      await body(notices);
    } finally {
      await o.query("rollback");
      o.off("notice", onNotice);
    }
  }
  const codeMd5 = async (sig: string) =>
    (await o.query<{ m: string }>(`select ${CODE_MD5_SQL} as m from pg_proc p where p.oid = $1::regprocedure`, [sig])).rows[0]?.m;
  const insertCheck = async () =>
    (
      await o.query<{ c: string }>(
        "select pg_get_expr(polwithcheck, polrelid) as c from pg_policy where polrelid = 'public.events'::regclass and polname = 'events_insert'",
      )
    ).rows[0]!.c;

  it("over the rollback's 0130 state, the preflight's hashes match, and the file's preflight and postflight pass", async () => {
    await rolledBack(async (notices) => {
      // 0133 put a trigger on deals; 0131's preflight requires exactly its three
      await o.query(REVERT_0133_SQL);
      await o.query(REVERT_0131_SQL);
      expect(await codeMd5("public.move_deal_to_stage(uuid,uuid)"), "0067's code, as the preflight expects").toBe(
        "bcadfb1a175518e069a4fdc5ff6a237a",
      );
      expect(await codeMd5("public.trg_deals_closed_guard()"), "0118's code").toBe("4266740fcc7f0f6159aef0c09746a762");
      expect(await insertCheck()).not.toMatch(/stage_changed/);
      // every event that exists now, byte for byte (append-only: rows other
      // sessions add meanwhile have higher ids and are left out)
      const digest = `select max(id)::text as m, md5(coalesce(string_agg(id::text || ':' || coalesce(hash, '') || ':' || coalesce(prev_hash, '') || ':' || payload::text || ':' || occurred_at::text, '|' order by id), '')) as d
                        from events where id <= $1::bigint`;
      const maxBefore = (await o.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events")).rows[0]!.m;
      const before = (await o.query<{ d: string }>(digest, [maxBefore])).rows[0]!.d;

      const results = [(await o.query(readMigration0131()))].flat();
      expect(notices.some((m) => m.startsWith("0131: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0131: postflight passed"))).toBe(true);
      expect(await insertCheck()).toMatch(/\(event_type <> 'stage_changed'::text\)/);

      // the boundary is exact: read while ALTER POLICY holds events' lock, no
      // event can be inserted until this transaction ends, so it is max(id)
      const boundary = notices.find((m) => m.startsWith("0131: enforcement boundary")) ?? "";
      const n = /^0131: enforcement boundary — events with id <= (\d+) were written before 0131; \d+ deal stage_changed/.exec(boundary);
      expect(n, notices.join("\n")).not.toBeNull();
      const maxNow = (await o.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events")).rows[0]!.m;
      expect(n![1]).toBe(maxNow);
      // …kept on the trigger, and returned as the file's last row
      const last = results[results.length - 1] as { rows: Array<{ enforcement_boundary: string }> };
      expect(last.rows[0]!.enforcement_boundary).toContain(`from event id > ${maxNow} `);

      // the apply changed and removed no existing event (rows a cron may have
      // committed before the policy lock was granted carry higher ids)
      expect((await o.query<{ d: string }>(digest, [maxBefore])).rows[0]!.d).toBe(before);
    });
  });

  it("the file refuses before it changes anything, and reads the boundary only after the policy change", () => {
    const sql = readMigration0131().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.indexOf("0131 aborted"), "every refusal sits in the preflight, before the first change").toBeGreaterThan(0);
    expect(sql.lastIndexOf("0131 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("alter policy events_insert")).toBeLessThan(sql.indexOf("0131: enforcement boundary"));
    expect(sql.indexOf("create trigger deals_stage_changed_event"), "deals' lock before events'").toBeLessThan(
      sql.indexOf("alter policy events_insert"),
    );
  });

  it("a comment-only difference in the replaced RPC body is accepted (hosted bodies have differed by comments)", async () => {
    await rolledBack(async (notices) => {
      // 0133 put a trigger on deals; 0131's preflight requires exactly its three
      await o.query(REVERT_0133_SQL);
      await o.query(REVERT_0131_SQL);
      const commented = RPC_0067.replace("begin\n", "begin\n  -- a comment hosted might carry\n");
      expect(commented, "the comment really went in").not.toBe(RPC_0067);
      await o.query(commented);
      const raw = (
        await o.query<{ m: string }>(
          "select md5(replace(prosrc, E'\\r', '')) as m from pg_proc where oid = 'public.move_deal_to_stage(uuid,uuid)'::regprocedure",
        )
      ).rows[0]!.m;
      expect(raw, "a body that differs from 0067's text…").not.toBe("f0012afe5f5bd2ddd6da6dd2b4a22e6c");
      expect(await codeMd5("public.move_deal_to_stage(uuid,uuid)"), "…but not in its code").toBe("bcadfb1a175518e069a4fdc5ff6a237a");
      await o.query(readMigration0131());
      expect(notices.some((m) => m.startsWith("0131: postflight passed"))).toBe(true);
    });
  });

  const refusals: Array<[string, string, RegExp]> = [
    ["an RPC body whose CODE differs", "__RPC__", /0131 aborted: move_deal_to_stage is not 0067's invoker body/],
    [
      "an events_insert that is not 0128's",
      "alter policy events_insert on public.events with check (org_id = (select current_org_id()) and actor_id = (select auth.uid()));",
      /0131 aborted: events_insert's check is not 0128's/,
    ],
    [
      "a guard body that is not 0118's",
      "__GUARD__",
      /0131 aborted: trg_deals_closed_guard is not 0118's invoker body/,
    ],
    [
      "a fourth trigger on deals",
      "create trigger zz_sma_extra after update on public.deals for each row execute function public.set_updated_at();",
      /0131 aborted: the triggers on deals are not the expected three/,
    ],
  ];
  // what the refusal leaves behind is nothing because the file is one
  // transaction and every refusal precedes its first change (the static test
  // above); here, that each drift IS refused, with its own words
  for (const [label, drift, refusal] of refusals) {
    it(`the preflight refuses ${label}`, async () => {
      await rolledBack(async () => {
        // 0133 put a trigger on deals; 0131's preflight requires exactly its three
        await o.query(REVERT_0133_SQL);
        await o.query(REVERT_0131_SQL);
        const sql =
          drift === "__RPC__"
            ? RPC_0067.replace("raise exception 'Deal not found';", "raise exception 'Deal missing';")
            : drift === "__GUARD__"
              ? GUARD_0118.replace("raise exception 'Stage not found';", "raise exception 'Stage missing';")
              : drift;
        expect(sql, "the drift really differs").not.toBe(drift === "__RPC__" ? RPC_0067 : drift === "__GUARD__" ? GUARD_0118 : "");
        await o.query(sql);
        await expect(o.query(readMigration0131())).rejects.toThrow(refusal);
      });
    });
  }

  it("the rollback recipe restores 0130's behaviour: one event per move, written by the RPC, and a session may write one again", async () => {
    const id = await newDeal();
    await rolledBack(async () => {
      // 0133 put a trigger on deals; 0131's preflight requires exactly its three
      await o.query(REVERT_0133_SQL);
      await o.query(REVERT_0131_SQL);
      await o.query("set local role authenticated");
      await o.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: agent.id, role: "authenticated", aal: "aal2" }),
      ]);
      await o.query("select public.move_deal_to_stage($1::uuid, $2::uuid)", [id, S.Qualified.id]);
      const { rows } = await o.query<{ n: number }>(
        "select count(*)::int as n from events where entity_id = $1 and event_type = 'stage_changed'",
        [id],
      );
      expect(rows[0]!.n, "0067's INSERT, and no trigger: exactly one").toBe(1);
      await o.query(
        `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
         values ($1, $2, 'deal', $3, 'stage_changed', '{}'::jsonb)`,
        [ORG, agent.id, id],
      );
      await o.query("reset role");
    });
    expect(await moves(id), "all of it rolled back").toEqual([]);
    expect((await deal(id)).stage_id).toBe(S.New.id);
  });
});
