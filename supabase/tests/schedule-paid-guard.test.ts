import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { REVERT_0145_SQL, readMigration0145 } from "./revert-0145";

/**
 * A payment schedule with a PAID instalment is never replaced or removed — not
 * when the "is anything paid?" check fails, not when a line is paid between
 * that check and the delete, and not through a session's direct API delete of
 * the line or of its reservation — through the REAL server actions against a
 * REAL PostgREST, with the session's RLS and aal2 token (T-schedule-paid-guard).
 *
 * At 217fbee `paidLineCount` (lib/actions/reservation-schedule.ts) read the
 * paid-line HEAD count as `count ?? 0` and never looked at `.error`;
 * `applyPaymentPlan` and `clearSchedule` refuse "once anything is paid"
 * through it and then delete EVERY line of the reservation. postgrest-js
 * answers a failed HEAD count with `count: null` (a 404 with no error at all,
 * an uncounted range with NaN), so a failed check read as "nothing paid": the
 * paid line was deleted with the rest, the action said it succeeded and wrote
 * its event. Nothing in the database refused it, and the check and the delete
 * are separate requests. Now the action refuses an unread count in words, and
 * 0145's BEFORE DELETE trigger refuses a user session's deletion of a paid
 * line — its own DELETE, or the cascade from its reservations DELETE.
 *
 * WHAT IT PINS (each case prints one `[evidence]` line):
 *   1. a paid-line count that fails (500, 502), answers 404, has no count, or
 *      an uncounted range (NaN) makes both actions refuse in words — every line
 *      kept, the paid one included, no write sent after the check, no event;
 *      also on a schedule with nothing paid (an unread count is not a zero);
 *   2. the controls hold: a paid line refuses with the existing words; with
 *      nothing paid the schedule is removed / replaced, with its event;
 *   3. the database refuses a paid line's deletion by a user session: a line
 *      marked paid by another session while the action's DELETE is held (the
 *      real race) and a count that answers 0 while a line is paid keep every
 *      line, said in the screen's words; a direct DELETE of the line, a bulk
 *      DELETE holding it, and the cascade from deleting its reservation are
 *      refused with 42501 for an admin and a listing manager; an unpaid line
 *      and an unpaid-only reservation still delete; un-marking, then removing,
 *      still works; an agent still deletes nothing (RLS);
 *   4. the trusted paths are not bound: service_role deletes a paid line and a
 *      reservation holding one; so does postgres;
 *   5. 0145 replays over its rollback text (preflight, postflight), and its
 *      preflight refuses a SECURITY DEFINER function that deletes lines; the
 *      restore pack's 0145 row reads true now and false for a disabled
 *      trigger, a current_user-only guard (the cascade's door) and a guard
 *      that refuses nothing — all inside rolled-back transactions.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();

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

import { applyPaymentPlan, clearSchedule, markInstallment, type ScheduleActionState } from "@/lib/actions/reservation-schedule";

// ---------------------------------------------------------------------------
// Sessions: one per user. Every REST request is recorded; the paid-line count
// can be answered instead of sent, and the lines' DELETE can be held while
// something else runs first.
// ---------------------------------------------------------------------------
/** The paid-line check, as the actions send it. */
const isPaidLineCount = (method: string, url: string) =>
  method === "HEAD" && /\/rest\/v1\/reservation_installments\?/.test(url) && url.includes("paid_at=not.is.null");
const isLinesDelete = (method: string, url: string) =>
  method === "DELETE" && /\/rest\/v1\/reservation_installments\?/.test(url);

const steer = {
  respond: null as null | (() => Response),
  hits: 0,
  beforeDelete: null as null | (() => Promise<void>),
  sent: [] as { method: string; url: string }[],
};
const sessions = new Map<TestUser, SupabaseClient>();

async function session(user: TestUser): Promise<SupabaseClient> {
  const known = sessions.get(user);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.includes("/rest/v1/")) steer.sent.push({ method, url });
        if (steer.respond && isPaidLineCount(method, url)) {
          steer.hits++;
          return steer.respond();
        }
        if (steer.beforeDelete && isLinesDelete(method, url)) {
          const run = steer.beforeDelete;
          steer.beforeDelete = null;
          await run();
        }
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  sessions.set(user, client);
  return client;
}

/** The answers a paid-line count can come back with. */
const ANSWERS = {
  /** a failed HEAD: a status, no body → postgrest-js: count null, error {message: ""} */
  failed500: () => new Response(null, { status: 500 }),
  failed502: () => new Response(null, { status: 502 }),
  /** a HEAD 404 → postgrest-js: status 204, error null, count null */
  head404: () => new Response(null, { status: 404 }),
  /** 200 with no Content-Range → count null, error null */
  noRange: () => new Response(null, { status: 200 }),
  /** an uncounted range → count NaN */
  uncounted: () => new Response(null, { status: 200, headers: { "content-range": "*/*" } }),
  /** "nothing is paid" — while a line IS paid: what the race looks like to the action */
  zeroWhilePaid: () => new Response(null, { status: 200, headers: { "content-range": "*/0" } }),
};

type Action = (prev: ScheduleActionState, fd: FormData) => Promise<ScheduleActionState>;
type Outcome = { result?: ScheduleActionState; thrown?: string; checked: number; writes: string[] };

/** An action's answer (or what it threw), whether the count was asked, and the writes it sent. */
async function press(
  user: TestUser,
  action: Action,
  fields: Record<string, string>,
  opts: { answer?: () => Response; beforeDelete?: () => Promise<void> } = {},
): Promise<Outcome> {
  const client = await session(user);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  steer.respond = opts.answer ?? null;
  steer.beforeDelete = opts.beforeDelete ?? null;
  steer.hits = 0;
  steer.sent = [];
  const writes = () => steer.sent.filter((r) => ["POST", "PATCH", "DELETE"].includes(r.method) && !r.url.includes("/rest/v1/events"))
    .map((r) => `${r.method} ${new URL(r.url).pathname.replace("/rest/v1/", "")}`);
  try {
    const result = await ctx.als.run(client, () => action({ error: null, savedAt: null }, fd));
    return { result, checked: steer.hits, writes: writes() };
  } catch (e) {
    return { thrown: e instanceof Error ? e.message : String(e), checked: steer.hits, writes: writes() };
  } finally {
    steer.respond = null;
    steer.beforeDelete = null;
  }
}

// ---------------------------------------------------------------------------
// Fixtures: a fresh priced property, plan and reservation per case
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let lm: TestUser;
let agent: TestUser;
const userIds: string[] = [];

interface Schedule {
  propertyId: string;
  reservationId: string;
  planId: string;
  /** the line ids; the first one paid when `paid` */
  lines: string[];
}

async function schedule(paid: boolean): Promise<Schedule> {
  const { rows: p } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type, asking_price) values ($1, $2, 'apartment', 300000) returning id",
    [ORG, `SG${TAG}-${randomUUID().slice(0, 8)}`],
  );
  const propertyId = p[0]!.id;
  const { rows: plan } = await pg.query<{ id: string }>(
    `insert into payment_plans (org_id, project_id, name, installments)
     values ($1, $2, 'Thirds', '[{"label":"Deposit","pct":30},{"label":"Frame","pct":30},{"label":"Keys","pct":40}]'::jsonb) returning id`,
    [ORG, propertyId],
  );
  const { rows: r } = await pg.query<{ id: string }>(
    "insert into reservations (org_id, property_id, expires_at, payment_plan_id) values ($1, $2, now() + interval '7 days', $3) returning id",
    [ORG, propertyId, plan[0]!.id],
  );
  const reservationId = r[0]!.id;
  const lines: string[] = [];
  for (const [i, [label, amount]] of ([["Deposit", 90000], ["Frame", 90000], ["Keys", 120000]] as const).entries()) {
    const isPaid = paid && i === 0;
    const { rows: l } = await pg.query<{ id: string }>(
      `insert into reservation_installments (org_id, reservation_id, sort_order, label, amount, paid_at, paid_amount)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [ORG, reservationId, i + 1, label, amount, isPaid ? new Date().toISOString() : null, isPaid ? amount : null],
    );
    lines.push(l[0]!.id);
  }
  return { propertyId, reservationId, planId: plan[0]!.id, lines };
}

/** What the database holds for a reservation's schedule, whole rows. */
async function linesOf(reservationId: string): Promise<{ id: string; label: string; paid: boolean; paid_amount: string | null }[]> {
  const { rows } = await pg.query<{ id: string; label: string; paid: boolean; paid_amount: string | null }>(
    `select id::text, label, paid_at is not null as paid, paid_amount::text
       from reservation_installments where reservation_id = $1 order by sort_order`,
    [reservationId],
  );
  return rows;
}

const reservationExists = async (id: string) =>
  (await pg.query("select 1 from reservations where id = $1", [id])).rowCount === 1;

async function scheduleEvents(propertyId: string): Promise<string[]> {
  const { rows } = await pg.query<{ t: string }>(
    "select event_type::text as t from events where org_id = $1 and entity_id = $2 and event_type::text like 'reservation_schedule_%' order by occurred_at",
    [ORG, propertyId],
  );
  return rows.map((r) => r.t);
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Schedule paid guard ${RUN}`, `schedule-paid-guard-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `spg-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  lm = await createTestUser(svc, `spg-lm-${RUN}@test.local`, "listing_manager", ORG);
  userIds.push(lm.id);
  agent = await createTestUser(svc, `spg-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
}, 300_000);

afterAll(async () => {
  // as postgres, paid lines included: maintenance and fixtures may always clean up
  await pg.query("delete from reservations where org_id = $1", [ORG]);
  await pg.query("delete from payment_plans where org_id = $1", [ORG]);
  await pg.query("delete from properties where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
}, 300_000);

const REFUSED_UNREAD = "Could not check whether any instalment is paid — nothing was changed. Try again.";
const REFUSED_CLEAR = "Instalments are marked paid — un-mark them before removing the schedule.";
const REFUSED_APPLY = /^Some instalments are already marked paid — un-mark them first/;
const KEPT = /^A paid instalment cannot be deleted — un-mark it first \(reservation_installments\.[0-9a-f-]{36}\)$/;

const ACTIONS = [
  ["clearSchedule", clearSchedule, (s: Schedule) => ({ reservation_id: s.reservationId })],
  ["applyPaymentPlan", applyPaymentPlan, (s: Schedule) => ({ reservation_id: s.reservationId, payment_plan_id: s.planId })],
] as const;

// ---------------------------------------------------------------------------
describe("an unread paid-line count is a refusal, never a zero", () => {
  const SHAPES = [
    ["fails (500)", ANSWERS.failed500],
    ["fails (502)", ANSWERS.failed502],
    ["answers 404 (no count, no error)", ANSWERS.head404],
    ["answers with no count", ANSWERS.noRange],
    ["answers an uncounted range (NaN)", ANSWERS.uncounted],
  ] as const;

  it.each(ACTIONS.flatMap(([name, action, fields]) => SHAPES.map(([label, answer]) => [name, label, action, fields, answer] as const)))(
    "%s, the count %s → refused in words; every line kept; no write after the check; no event",
    async (name, label, action, fields, answer) => {
      const s = await schedule(true);
      const before = await linesOf(s.reservationId);
      const o = await press(admin, action, fields(s), { answer });
      const after = await linesOf(s.reservationId);
      console.log(`[evidence] ${name}, count ${label}: ${o.thrown ? `threw "${o.thrown}"` : `"${o.result?.error}"`}; lines ${before.length} → ${after.length} (paid ${after.filter((l) => l.paid).length}); writes ${JSON.stringify(o.writes)}; events ${JSON.stringify(await scheduleEvents(s.propertyId))}`);
      expect(o.checked, "the paid-line count was asked").toBeGreaterThanOrEqual(1);
      expect(o.thrown).toBeUndefined();
      expect(o.result?.error).toBe(REFUSED_UNREAD);
      expect(o.writes, "nothing written after the check").toEqual([]);
      expect(after).toEqual(before);
      expect(await scheduleEvents(s.propertyId)).toEqual([]);
    },
    60_000,
  );

  it.each(ACTIONS)("%s on a schedule with NOTHING paid, the count fails → still refused (an unread count is not a zero)", async (name, action, fields) => {
    const s = await schedule(false);
    const before = await linesOf(s.reservationId);
    const o = await press(lm, action, fields(s), { answer: ANSWERS.failed500 });
    console.log(`[evidence] ${name}, nothing paid, count fails (listing manager): "${o.result?.error}"; writes ${JSON.stringify(o.writes)}`);
    expect(o.result?.error).toBe(REFUSED_UNREAD);
    expect(o.writes).toEqual([]);
    expect(await linesOf(s.reservationId)).toEqual(before);
  }, 60_000);

  it("controls: a paid line refuses with the existing words; with nothing paid the schedule is removed or replaced, with its event", async () => {
    const paid = await schedule(true);
    const clearPaid = await press(admin, clearSchedule, { reservation_id: paid.reservationId });
    const applyPaid = await press(admin, applyPaymentPlan, { reservation_id: paid.reservationId, payment_plan_id: paid.planId });
    console.log(`[evidence] controls, paid: clear "${clearPaid.result?.error}", apply "${applyPaid.result?.error}"; writes ${JSON.stringify([...clearPaid.writes, ...applyPaid.writes])}`);
    expect(clearPaid.result?.error).toBe(REFUSED_CLEAR);
    expect(applyPaid.result?.error).toMatch(REFUSED_APPLY);
    expect([...clearPaid.writes, ...applyPaid.writes]).toEqual([]);
    expect(await linesOf(paid.reservationId)).toHaveLength(3);

    const unpaid = await schedule(false);
    const cleared = await press(admin, clearSchedule, { reservation_id: unpaid.reservationId });
    expect(cleared.result?.error ?? null).toBeNull();
    expect(await linesOf(unpaid.reservationId)).toEqual([]);
    const reapplied = await press(admin, applyPaymentPlan, { reservation_id: unpaid.reservationId, payment_plan_id: unpaid.planId });
    expect(reapplied.result?.error ?? null).toBeNull();
    const fresh = await linesOf(unpaid.reservationId);
    console.log(`[evidence] controls, nothing paid: cleared → 0 lines; re-applied → ${fresh.length} lines; events ${JSON.stringify(await scheduleEvents(unpaid.propertyId))}`);
    expect(fresh.map((l) => l.label)).toEqual(["Deposit", "Frame", "Keys"]);
    expect(await scheduleEvents(unpaid.propertyId)).toEqual(["reservation_schedule_cleared", "reservation_schedule_applied"]);
  }, 60_000);
});

describe("the database keeps a paid line from user sessions (0145)", () => {
  it.each(ACTIONS)("%s: a line marked paid by another session while the DELETE is held is kept — said in the screen's words", async (name, action, fields) => {
    const s = await schedule(false);
    const o = await press(admin, action, fields(s), {
      // the action has checked (nothing paid) and is about to delete: an agent marks a line paid first
      beforeDelete: async () => {
        // straight through the agent's own session (not press(): that would reset the outer call's steering)
        const fd = new FormData();
        fd.set("installment_id", s.lines[1]!);
        fd.set("paid", "true");
        fd.set("paid_amount", "90000");
        const client = await session(agent);
        const marked = await ctx.als.run(client, () => markInstallment({ error: null, savedAt: null }, fd));
        if (marked.error) throw new Error(`the agent could not mark the line paid: ${marked.error}`);
      },
    });
    const after = await linesOf(s.reservationId);
    console.log(`[evidence] ${name}, paid in between (agent): "${o.result?.error}"; lines ${after.length} (paid ${after.filter((l) => l.paid).map((l) => l.label).join(",")}); events ${JSON.stringify(await scheduleEvents(s.propertyId))}`);
    expect(o.thrown).toBeUndefined();
    if (name === "clearSchedule") expect(o.result?.error).toBe(REFUSED_CLEAR);
    else expect(o.result?.error).toMatch(REFUSED_APPLY);
    expect(after.map((l) => [l.label, l.paid])).toEqual([["Deposit", false], ["Frame", true], ["Keys", false]]);
    expect(await scheduleEvents(s.propertyId)).toEqual([]);
  }, 60_000);

  it.each(ACTIONS)("%s: a count that says 0 while a line is paid → kept, said in the screen's words", async (name, action, fields) => {
    const s = await schedule(true);
    const before = await linesOf(s.reservationId);
    const o = await press(admin, action, fields(s), { answer: ANSWERS.zeroWhilePaid });
    const after = await linesOf(s.reservationId);
    console.log(`[evidence] ${name}, count 0 while a line is paid: "${o.result?.error}"; lines ${after.length} (paid ${after.filter((l) => l.paid).length}); writes ${JSON.stringify(o.writes)}`);
    expect(o.checked).toBeGreaterThanOrEqual(1);
    if (name === "clearSchedule") expect(o.result?.error).toBe(REFUSED_CLEAR);
    else expect(o.result?.error).toMatch(REFUSED_APPLY);
    expect(o.writes, "the DELETE was sent and refused whole; nothing inserted").toEqual(["DELETE reservation_installments"]);
    expect(after).toEqual(before);
    expect(await scheduleEvents(s.propertyId)).toEqual([]);
  }, 60_000);

  it("an admin's and a listing manager's own DELETE of a paid line, a bulk DELETE holding one, and the DELETE of its reservation are refused (42501); unpaid lines and an unpaid-only reservation still delete", async () => {
    for (const [who, user] of [["admin", admin], ["listing manager", lm]] as const) {
      const s = await schedule(true);
      const client = await session(user);
      const one = await client.from("reservation_installments").delete({ count: "exact" }).eq("id", s.lines[0]!);
      const bulk = await client.from("reservation_installments").delete({ count: "exact" }).eq("reservation_id", s.reservationId);
      const hold = await client.from("reservations").delete({ count: "exact" }).eq("id", s.reservationId);
      const kept = await linesOf(s.reservationId);
      const sibling = await client.from("reservation_installments").delete({ count: "exact" }).eq("id", s.lines[2]!);
      const unpaid = await schedule(false);
      const unpaidHold = await client.from("reservations").delete({ count: "exact" }).eq("id", unpaid.reservationId);
      console.log(
        `[evidence] ${who}: paid line → ${one.error ? `${one.error.code} "${one.error.message}"` : `deleted ${one.count}`}; bulk → ${bulk.error ? bulk.error.code : `deleted ${bulk.count}`}; ` +
          `reservation → ${hold.error ? hold.error.code : `deleted ${hold.count}`} (lines kept ${kept.length}); unpaid line → ${sibling.error ? sibling.error.code : `deleted ${sibling.count}`}; ` +
          `unpaid-only reservation → ${unpaidHold.error ? unpaidHold.error.code : `deleted ${unpaidHold.count}`}`,
      );
      expect(one.error?.code).toBe("42501");
      expect(one.error?.message).toMatch(KEPT);
      expect(bulk.error?.code, "a bulk delete holding a paid line is refused whole").toBe("42501");
      expect(hold.error?.code, "the cascade from the reservation's delete is bound").toBe("42501");
      expect(await reservationExists(s.reservationId)).toBe(true);
      expect(kept).toHaveLength(3);
      expect(sibling.error).toBeNull();
      expect(sibling.count).toBe(1);
      expect(unpaidHold.error).toBeNull();
      expect(unpaidHold.count).toBe(1);
      expect(await linesOf(unpaid.reservationId)).toEqual([]);
    }
  }, 60_000);

  it("un-marking the paid line, then removing the schedule, still works (listing manager); an agent still deletes nothing", async () => {
    const s = await schedule(true);
    const agentDelete = await (await session(agent)).from("reservation_installments").delete({ count: "exact" }).eq("id", s.lines[1]!);
    expect(agentDelete.error).toBeNull();
    expect(agentDelete.count, "RLS: only an admin or listing manager deletes lines").toBe(0);
    const unmarked = await press(lm, markInstallment, { installment_id: s.lines[0]!, paid: "false" });
    expect(unmarked.result?.error ?? null).toBeNull();
    const cleared = await press(lm, clearSchedule, { reservation_id: s.reservationId });
    console.log(`[evidence] agent delete → ${agentDelete.count} rows; un-marked; then removed (listing manager): "${cleared.result?.error ?? "ok"}", ${(await linesOf(s.reservationId)).length} lines left`);
    expect(cleared.result?.error ?? null).toBeNull();
    expect(await linesOf(s.reservationId)).toEqual([]);
  }, 60_000);

  it("the trusted paths are not bound: service_role deletes a paid line and a reservation holding one; so does postgres", async () => {
    const a = await schedule(true);
    const line = await svc.from("reservation_installments").delete({ count: "exact" }).eq("id", a.lines[0]!);
    const hold = await svc.from("reservations").delete({ count: "exact" }).eq("id", a.reservationId);
    const b = await schedule(true);
    const { rowCount } = await pg.query("delete from reservations where id = $1", [b.reservationId]);
    console.log(`[evidence] service_role: paid line → ${line.error ? line.error.code : line.count}, reservation → ${hold.error ? hold.error.code : hold.count}; postgres: reservation → ${rowCount}`);
    expect(line.error).toBeNull();
    expect(line.count).toBe(1);
    expect(hold.error).toBeNull();
    expect(hold.count).toBe(1);
    expect(rowCount).toBe(1);
    expect(await linesOf(b.reservationId)).toEqual([]);
  }, 60_000);
});

describe("0145 itself", () => {
  /** Runs `sqls` as postgres in ONE transaction that is always rolled back. */
  async function rolledBack(sqls: string[]): Promise<{ error: string | null; last: unknown }> {
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("begin");
      let last: unknown = null;
      for (const sql of sqls) last = (await c.query(sql)) as unknown;
      return { error: null, last };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), last: null };
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  }

  it("replays over its rollback text — preflight and postflight pass; the rollback leaves no guard", async () => {
    const reverted = await rolledBack([
      REVERT_0145_SQL,
      "do $$ begin if exists (select 1 from pg_trigger where tgname = 'reservation_installments_keep_paid') then raise exception 'still there'; end if; end $$",
    ]);
    const replay = await rolledBack([REVERT_0145_SQL, readMigration0145()]);
    console.log(`[evidence] 0145 rollback: ${reverted.error ?? "guard gone"}; replay over it: ${replay.error ?? "applied"}`);
    expect(reverted.error).toBeNull();
    expect(replay.error).toBeNull();
  }, 60_000);

  /** The restore pack's 0145 row, exactly as scripts/backup/verify-restore.sql carries it. */
  const packRow = () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'SECURITY: a paid instalment line is kept from user sessions");
    const to = pack.indexOf("\n  union all\n", from);
    if (from < 0 || to < 0) throw new Error("the pack carries no 0145 row");
    return `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
  };

  it("the restore pack's 0145 row passes now, and reads a disabled trigger, a current_user-only guard and a guard that refuses nothing", async () => {
    const now = await rolledBack([packRow()]);
    expect(now.error).toBeNull();
    expect((now.last as { rows: { expected: string; actual: string }[] }).rows[0]).toMatchObject({ expected: "true", actual: "true" });
    const drifts = [
      "alter table public.reservation_installments disable trigger reservation_installments_keep_paid",
      `create or replace function public.trg_installment_paid_kept() returns trigger language plpgsql security invoker
         set search_path = public, pg_temp as $f$ begin
           if current_user not in ('authenticated', 'anon') then return old; end if;
           if old.paid_at is not null then raise exception 'kept' using errcode = '42501'; end if;
           return old; end $f$`,
      `create or replace function public.trg_installment_paid_kept() returns trigger language plpgsql security invoker
         set search_path = public, pg_temp as $f$ begin return old; end $f$`,
    ];
    for (const drift of drifts) {
      const r = await rolledBack([drift, packRow()]);
      expect(r.error, drift).toBeNull();
      const row = (r.last as { rows: { expected: string; actual: string }[] }).rows[0]!;
      expect(row.actual, drift).toBe("false");
    }
  }, 60_000);

  it("its preflight refuses a SECURITY DEFINER function that deletes instalment lines — nothing changed", async () => {
    const planted = await rolledBack([
      REVERT_0145_SQL,
      `create function public.zz_spg_deleter(p uuid) returns void language sql security definer set search_path = public as $f$ delete from public.reservation_installments where id = p $f$`,
      readMigration0145(),
    ]);
    console.log(`[evidence] 0145 over a planted deleter: ${planted.error}`);
    expect(planted.error).toMatch(/^0145 aborted: a SECURITY DEFINER function deletes instalment lines or reservations \(public\.zz_spg_deleter\)/);
  }, 60_000);
});
