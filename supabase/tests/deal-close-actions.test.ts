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
 * The REAL Won / Lost server actions, against the REAL local stack.
 *
 * Nothing below the action is stubbed except the Next.js request plumbing:
 * `createClient` hands the action a supabase-js client that is signed in (at
 * aal2) as a fixture user, so every read and write goes through PostgREST,
 * RLS, the triggers and the events hash chain exactly as it does in
 * production. `createAdminClient` is the real service client. Only
 * `revalidatePath` (it needs a Next request) is a stub.
 *
 * THE GATE, AND WHAT IT CONTROLS. Each action's client routes its requests
 * through a gate that can HOLD the action's first write until the test
 * releases it. Against the pre-0117 actions (the reproduction at 6366ef8) that
 * write was the `PATCH /rest/v1/deals` AFTER their status read, so
 * "overlapping" meant exactly: both had read the deal as open before either
 * wrote. Against the close_deal actions the held write is the
 * `POST /rest/v1/rpc/close_deal` — their FIRST request, nothing read before
 * it — so "both arrived" means both close requests are in flight. The order in
 * which the database then runs them is NOT controlled here, and the
 * assertions hold in either order. The ordered, row-lock proof that closes
 * serialise is supabase/tests/deal-close.test.ts (a second session OBSERVED
 * blocked on the first's lock). No sleeps anywhere.
 *
 * FAILURE INJECTION IS REAL. `failEvent` installs a BEFORE INSERT trigger on
 * `events` that refuses ONE event type for ONE entity of this file's
 * throwaway organisation, and removes it in `finally`. The refusal happens in
 * the database, inside whatever transaction the insert belongs to — so it
 * shows exactly what a failed event write leaves behind. `trg_events_hash`
 * itself is never touched.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// The gate: holds a client's next write until released.
// ---------------------------------------------------------------------------
type Held = { release: () => void; done: Promise<void> };

const gate = {
  holding: new Set<string>(),
  held: new Map<string, Held>(),
  /** Ask the gate to hold `name`'s next write. */
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
  },
};

function isCloseWrite(url: string, method: string): boolean {
  return (
    (method === "PATCH" && /\/rest\/v1\/deals(\?|$)/.test(url)) ||
    (method === "POST" && /\/rest\/v1\/rpc\/close_deal(\?|$)/.test(url))
  );
}

function gatedFetch(name: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (isCloseWrite(url, method) && gate.holding.has(name)) {
      gate.holding.delete(name);
      let release!: () => void;
      let finish!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const done = new Promise<void>((r) => (finish = r));
      gate.held.set(name, { release, done });
      await released;
      try {
        return await fetch(input, init);
      } finally {
        finish();
      }
    }
    return fetch(input, init);
  };
}

/** A fresh client carrying `user`'s aal2 session, whose writes pass the gate as `name`. */
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

// ---------------------------------------------------------------------------
// The action under test gets whichever client the test queued for it.
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

import { markDealLost, markDealWon, type DealSectionState } from "@/lib/actions/deals";

type Outcome = { result: DealSectionState | null; thrown: string | null };

/** Run an action as `user` under the gate name `name`; a throw is data, not a crash. */
async function act(
  user: TestUser,
  name: string,
  action: typeof markDealWon,
  fields: Record<string, string>,
): Promise<Outcome> {
  state.queue.push(await sessionClient(user, name));
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    return { result: await action({ error: null, savedAt: null }, fd), thrown: null };
  } catch (e) {
    return { result: null, thrown: e instanceof Error ? e.message : String(e) };
  }
}

/** Start an action without awaiting it — the gate decides when it proceeds. */
function start(
  user: TestUser,
  name: string,
  action: typeof markDealWon,
  fields: Record<string, string>,
): Promise<Outcome> {
  return act(user, name, action, fields);
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
let agent: TestUser;
let openStage: { id: string; name: string };
let wonStage: { id: string; name: string };
let lostStage: { id: string; name: string };
const userIds: string[] = [];
let fixtureN = 0;

async function newDeal(opts: { agentId?: string; propertyId?: string | null; accepted?: number | null } = {}) {
  fixtureN += 1;
  const { data: deal, error } = await svc
    .from("deals")
    .insert({
      org_id: ORG,
      deal_type: "sale",
      stage_id: openStage.id,
      title: `ZZTEST close ${RUN} ${fixtureN}`,
      agent_id: opts.agentId ?? agent.id,
      created_by: opts.agentId ?? agent.id,
      property_id: opts.propertyId ?? null,
      expected_value: 123456,
    })
    .select("id, stage_entered_at")
    .single();
  if (error) throw new Error(`deal fixture: ${error.message}`);
  if (opts.accepted != null) {
    const { error: offerErr } = await svc.from("offers").insert({
      org_id: ORG,
      deal_id: deal.id,
      amount: opts.accepted,
      status: "accepted",
      decided_at: new Date().toISOString(),
    });
    if (offerErr) throw new Error(`offer fixture: ${offerErr.message}`);
  }
  return deal as { id: string; stage_entered_at: string };
}

async function newProperty(status = "available") {
  fixtureN += 1;
  const { data, error } = await svc
    .from("properties")
    .insert({
      org_id: ORG,
      reference: `ZZDC${RUN.slice(-4).toUpperCase()}${fixtureN}`,
      property_type: "apartment",
      status,
      asking_price: 300000,
    })
    .select("id, reference")
    .single();
  if (error) throw new Error(`property fixture: ${error.message}`);
  return data as { id: string; reference: string };
}

async function dealRow(id: string) {
  const { rows } = await pg.query(
    `select status, won_at, lost_at, lost_reason, final_value::text as final_value,
            stage_id, stage_entered_at, last_activity_at
       from deals where id = $1`,
    [id],
  );
  return rows[0] as {
    status: string;
    won_at: Date | null;
    lost_at: Date | null;
    lost_reason: string | null;
    final_value: string | null;
    stage_id: string;
    stage_entered_at: Date;
    last_activity_at: Date;
  };
}

async function eventsFor(entityId: string) {
  const { rows } = await pg.query(
    "select event_type, payload, actor_id from events where org_id = $1 and entity_id = $2 order by id",
    [ORG, entityId],
  );
  return rows as { event_type: string; payload: Record<string, unknown>; actor_id: string | null }[];
}

const count = (evs: { event_type: string }[], type: string) =>
  evs.filter((e) => e.event_type === type).length;

/** One line of evidence per scenario: what the database holds afterwards. */
async function evidence(label: string, dealId: string, outcomes: Record<string, Outcome>) {
  const row = await dealRow(dealId);
  const evs = await eventsFor(dealId);
  console.log(
    `[evidence] ${label}\n  row: status=${row.status} won_at=${row.won_at ? "set" : "null"} ` +
      `lost_at=${row.lost_at ? "set" : "null"} lost_reason=${JSON.stringify(row.lost_reason)} ` +
      `final_value=${row.final_value} stage=${row.stage_id === wonStage.id ? "won" : row.stage_id === lostStage.id ? "lost" : "open"}\n` +
      `  events: ${evs.map((e) => e.event_type).join(", ") || "(none)"}\n` +
      Object.entries(outcomes)
        .map(
          ([k, o]) =>
            `  ${k}: ${o.thrown ? `THREW ${JSON.stringify(o.thrown)}` : JSON.stringify(o.result)}`,
        )
        .join("\n"),
  );
}

/** Refuse ONE event type for ONE entity, in the database; returns the remover. */
async function failEvent(entityId: string, eventType: string): Promise<() => Promise<void>> {
  fixtureN += 1;
  const fn = `zz_dc_fail_${RUN}_${fixtureN}`;
  // uuid and event type are validated shapes, never user input — safe to inline
  if (!/^[0-9a-f-]{36}$/.test(entityId) || !/^[a-z_]+$/.test(eventType)) throw new Error("bad input");
  await pg.query(
    `create function public.${fn}() returns trigger language plpgsql as $f$
     begin
       if new.entity_id = '${entityId}'::uuid and new.event_type = '${eventType}' then
         raise exception 'injected failure: % event refused', new.event_type;
       end if;
       return new;
     end $f$`,
  );
  await pg.query(`revoke all on function public.${fn}() from public, anon, authenticated, service_role`);
  await pg.query(`create trigger ${fn} before insert on public.events for each row execute function public.${fn}()`);
  return async () => {
    await pg.query(`drop trigger if exists ${fn} on public.events`);
    await pg.query(`drop function if exists public.${fn}()`);
  };
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  // a previous run that died mid-test may have left an injector behind
  const { rows: stale } = await pg.query<{ tgname: string }>(
    "select tgname from pg_trigger where tgrelid = 'public.events'::regclass and tgname like 'zz_dc_fail_%'",
  );
  for (const t of stale) {
    await pg.query(`drop trigger if exists ${t.tgname} on public.events`);
    await pg.query(`drop function if exists public.${t.tgname}()`);
  }

  await ensureTestOrg(svc, ORG, `Deal close ${RUN}`, `deal-close-${RUN}`);
  admin = await createTestUser(svc, `dc-admin-${RUN}@test.local`, "admin", ORG);
  agent = await createTestUser(svc, `dc-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(admin.id, agent.id);

  const { data: stages } = await svc
    .from("deal_stages")
    .select("id, name, sort_order, is_won, is_lost")
    .eq("org_id", ORG)
    .eq("deal_type", "sale")
    .order("sort_order");
  openStage = stages!.find((s) => s.sort_order === 1)!;
  wonStage = stages!.find((s) => s.is_won)!;
  lostStage = stages!.find((s) => s.is_lost)!;
});

afterEach(() => {
  gate.reset();
  state.queue.length = 0;
});

afterAll(async () => {
  // children first: tasks and offers reference deals, reservations properties
  await pg.query("delete from tasks where org_id = $1", [ORG]);
  await pg.query("delete from offers where org_id = $1", [ORG]);
  await pg.query("delete from reservations where org_id = $1", [ORG]);
  await pg.query("delete from deals where org_id = $1", [ORG]);
  await pg.query("delete from properties where org_id = $1", [ORG]);
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
describe("competing close requests through the real actions", () => {
  it("two overlapping Lost requests: one transition, one Lost event, the second changes nothing", async () => {
    const deal = await newDeal();
    gate.hold("A", "B");
    const pA = start(agent, "A", markDealLost, { deal_id: deal.id, lost_reason: "Reason A — buyer withdrew" });
    const pB = start(agent, "B", markDealLost, { deal_id: deal.id, lost_reason: "Reason B — bought elsewhere" });
    await until("both close requests reached the gate", () =>
      gate.arrived("A") && gate.arrived("B"),
    );
    gate.release("A");
    gate.release("B");
    const [a, b] = await Promise.all([pA, pB]);
    await evidence("Lost/Lost overlapping", deal.id, { A: a, B: b });

    const evs = await eventsFor(deal.id);
    expect(count(evs, "lost"), "exactly one Lost event").toBe(1);
    const row = await dealRow(deal.id);
    expect(row.status).toBe("lost");
    // the committed reason is the one whose request was NOT told it was a repeat
    const firsts = [
      ["Reason A — buyer withdrew", a],
      ["Reason B — bought elsewhere", b],
    ].filter(([, o]) => !(o as Outcome).result?.notice) as [string, Outcome][];
    expect(firsts, "exactly one request reports a new close").toHaveLength(1);
    expect(row.lost_reason).toBe(firsts[0]![0]);
    for (const o of [a, b]) {
      expect(o.thrown, "the action never throws").toBeNull();
      expect(o.result?.error ?? null, "a repeat of the same outcome is not an error").toBeNull();
    }
  });

  /*
   * Against 6366ef8 this reproduced the stale read: both actions had read the
   * deal as open, and the second write overwrote the first. Against close_deal
   * the first request finishes before the second is released, so at the
   * database this is sequential; what it still guards is the ACTION layer — it
   * fails if an action ever reads the status again before writing — and the
   * exact conflict answer the loser gets, in both orders.
   */
  for (const firstOutcome of ["won", "lost"] as const) {
    it(`overlapping Won and Lost, ${firstOutcome} writes first: that outcome stands, the other writes nothing`, async () => {
      const deal = await newDeal({ accepted: 250000 });
      gate.hold("W", "L");
      const pW = start(agent, "W", markDealWon, { deal_id: deal.id });
      const pL = start(agent, "L", markDealLost, { deal_id: deal.id, lost_reason: "Buyer bought elsewhere" });
      await until("both actions reached their write", () => gate.arrived("W") && gate.arrived("L"));
      const [first, second] = firstOutcome === "won" ? (["W", "L"] as const) : (["L", "W"] as const);
      const pFirst = first === "W" ? pW : pL;
      gate.release(first);
      await pFirst; // the first request has finished entirely — events included
      gate.release(second);
      const [w, l] = await Promise.all([pW, pL]);
      await evidence(`Won/Lost, ${firstOutcome} first`, deal.id, { won: w, lost: l });

      const row = await dealRow(deal.id);
      const evs = await eventsFor(deal.id);
      expect(row.status, "the first outcome stands").toBe(firstOutcome);
      expect(count(evs, "won") + count(evs, "lost"), "one terminal event").toBe(1);
      expect(count(evs, firstOutcome)).toBe(1);
      if (firstOutcome === "won") {
        expect(row.lost_at).toBeNull();
        expect(row.lost_reason, "the Lost reason never lands on a won deal").toBeNull();
        expect(row.stage_id).toBe(wonStage.id);
        expect(row.final_value).toBe("250000.00");
      } else {
        expect(row.won_at).toBeNull();
        expect(row.final_value).toBeNull();
        expect(row.stage_id).toBe(lostStage.id);
      }
      const loser = firstOutcome === "won" ? l : w;
      expect(loser.thrown).toBeNull();
      expect(loser.result?.error ?? "", "the loser is told the deal is already closed").toMatch(
        new RegExp(`already marked ${firstOutcome}`, "i"),
      );
      expect(loser.result?.savedAt ?? null).toBeNull();
    });
  }

  it("two overlapping admin-override Won requests: one transition, one won_override, one Won", async () => {
    const deal = await newDeal();
    gate.hold("A", "B");
    const pA = start(admin, "A", markDealWon, { deal_id: deal.id, override: "on", final_value: "111000" });
    const pB = start(admin, "B", markDealWon, { deal_id: deal.id, override: "on", final_value: "222000" });
    await until("both reached their write", () => gate.arrived("A") && gate.arrived("B"));
    gate.release("A");
    gate.release("B");
    const [a, b] = await Promise.all([pA, pB]);
    await evidence("override Won/Won overlapping", deal.id, { A: a, B: b });

    const evs = await eventsFor(deal.id);
    expect(count(evs, "won"), "one Won event").toBe(1);
    expect(count(evs, "won_override"), "one override event").toBe(1);
    const won = evs.find((e) => e.event_type === "won")!;
    const row = await dealRow(deal.id);
    // the price on the row is the one the single Won event recorded
    expect(Number(row.final_value)).toBe(Number(won.payload.final_value));
    expect(won.payload.override).toBe(true);
  });

  it("a sequential Won then Lost: the second is refused and changes nothing", async () => {
    const deal = await newDeal({ accepted: 200000 });
    const w = await act(agent, "W", markDealWon, { deal_id: deal.id });
    const before = await dealRow(deal.id);
    const l = await act(agent, "L", markDealLost, { deal_id: deal.id, lost_reason: "Too late" });
    await evidence("sequential Won then Lost", deal.id, { won: w, lost: l });
    expect(w.result?.error ?? null).toBeNull();
    expect(l.thrown).toBeNull();
    expect(l.result?.error ?? "").toMatch(/already/i);
    expect(await dealRow(deal.id)).toEqual(before);
    const evs = await eventsFor(deal.id);
    expect(count(evs, "won")).toBe(1);
    expect(count(evs, "lost")).toBe(0);
  });

  it("a repeated Lost after completion writes no second event and keeps the first reason", async () => {
    const deal = await newDeal();
    const first = await act(agent, "A", markDealLost, { deal_id: deal.id, lost_reason: "First reason" });
    const before = await dealRow(deal.id);
    const again = await act(agent, "B", markDealLost, { deal_id: deal.id, lost_reason: "Second reason" });
    await evidence("repeated Lost", deal.id, { first, again });
    expect(first.result?.error ?? null).toBeNull();
    expect(again.thrown).toBeNull();
    expect(again.result?.error ?? null, "a repeat is not an error").toBeNull();
    expect(again.result?.notice ?? "", "…but it says nothing changed").toMatch(/already marked lost/i);
    expect(await dealRow(deal.id)).toEqual(before);
    expect(count(await eventsFor(deal.id), "lost")).toBe(1);
  });
});

describe("a failed event write through the real actions", () => {
  it("Lost: the event is refused, so the deal stays open with nothing written", async () => {
    const deal = await newDeal();
    const before = await dealRow(deal.id);
    const remove = await failEvent(deal.id, "lost");
    let out: Outcome;
    try {
      out = await act(agent, "A", markDealLost, { deal_id: deal.id, lost_reason: "Should roll back" });
    } finally {
      await remove();
    }
    await evidence("Lost with the lost event refused", deal.id, { A: out });
    expect(await dealRow(deal.id), "status, reason, stage and timestamps roll back").toEqual(before);
    expect(await eventsFor(deal.id)).toEqual([]);
    expect(out.thrown, "the action never throws").toBeNull();
    expect(out.result?.error, "the refusal is reported").toBeTruthy();
    expect(out.result?.savedAt ?? null).toBeNull();
  });

  for (const refused of ["won_override", "won"] as const) {
    it(`override Won: the ${refused} event is refused, so the deal stays open with nothing written`, async () => {
      const deal = await newDeal();
      const before = await dealRow(deal.id);
      const remove = await failEvent(deal.id, refused);
      let out: Outcome;
      try {
        out = await act(admin, "A", markDealWon, { deal_id: deal.id, override: "on", final_value: "50000" });
      } finally {
        await remove();
      }
      await evidence(`override Won with ${refused} refused`, deal.id, { A: out });
      expect(await dealRow(deal.id)).toEqual(before);
      expect(await eventsFor(deal.id)).toEqual([]);
      expect(out.thrown).toBeNull();
      expect(out.result?.error).toBeTruthy();
    });
  }
});

describe("Won follow-ups through the real actions", () => {
  async function liveHold(propertyId: string) {
    const { data, error } = await svc
      .from("reservations")
      .insert({
        org_id: ORG,
        property_id: propertyId,
        status: "held",
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    if (error) throw new Error(`reservation fixture: ${error.message}`);
    return data.id as string;
  }

  async function prompts(propertyId: string) {
    const { rows } = await pg.query(
      "select kind, deal_id, assignee_id, is_done from tasks where org_id = $1 and property_id = $2 order by kind",
      [ORG, propertyId],
    );
    return rows as { kind: string; deal_id: string | null; assignee_id: string; is_done: boolean }[];
  }

  it("overlapping Won requests raise each prompt exactly once", async () => {
    const prop = await newProperty();
    await liveHold(prop.id);
    const deal = await newDeal({ propertyId: prop.id, accepted: 300000 });
    gate.hold("A", "B");
    const pA = start(agent, "A", markDealWon, { deal_id: deal.id });
    const pB = start(agent, "B", markDealWon, { deal_id: deal.id });
    await until("both reached their write", () => gate.arrived("A") && gate.arrived("B"));
    gate.release("A");
    gate.release("B");
    const [a, b] = await Promise.all([pA, pB]);
    await evidence("Won/Won with prompts", deal.id, { A: a, B: b });

    const tasks = await prompts(prop.id);
    expect(tasks.filter((t) => t.kind === "listing_status_check")).toHaveLength(1);
    expect(tasks.filter((t) => t.kind === "reservation_still_live")).toHaveLength(1);
    const propEvents = await eventsFor(prop.id);
    expect(count(propEvents, "followup_task_created"), "one event per prompt").toBe(2);
    expect(count(await eventsFor(deal.id), "won")).toBe(1);
  });

  it("a follow-up that fails AFTER the close commits is reported as a won deal with a caveat, never as a failure", async () => {
    const prop = await newProperty();
    const deal = await newDeal({ propertyId: prop.id, accepted: 310000 });
    const remove = await failEvent(prop.id, "followup_task_created");
    let out: Outcome;
    try {
      out = await act(agent, "A", markDealWon, { deal_id: deal.id });
    } finally {
      await remove();
    }
    await evidence("Won with the follow-up event refused", deal.id, { A: out });
    const row = await dealRow(deal.id);
    expect(row.status, "the close committed").toBe("won");
    expect(count(await eventsFor(deal.id), "won")).toBe(1);
    expect(out.thrown, "the action never throws").toBeNull();
    expect(out.result?.error ?? null, "a committed close is not reported as a failure").toBeNull();
    expect(out.result?.savedAt).toBeTruthy();
    // the task WAS created — only its timeline line is missing, and the notice says exactly that
    expect(out.result?.notice ?? "").toMatch(/listing status was created, but its timeline entry could not be recorded/);
    const tasks = await prompts(prop.id);
    expect(tasks.filter((x) => x.kind === "listing_status_check"), "the reminder exists").toHaveLength(1);
  });
});
