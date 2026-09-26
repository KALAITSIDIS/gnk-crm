import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * 0119: a task belongs to the organisation of the deal it names, and a deal's
 * reminder supersession stays inside that organisation.
 *
 * THE GAP, as it stood at 0118 (BACKLOG "The deal nudge supersession writes
 * across organisations"): `tasks.deal_id` referenced `deals(id)` alone and
 * `tasks_insert` / `tasks_update` check only the caller's organisation, so a
 * member of organisation B who knew an organisation-A deal id could plant a
 * task of B on it (INSERT, PATCH or UPSERT); and `trg_supersede_deal_nudges`
 * matched by `deal_id` alone, so A closing the deal — or logging contact on
 * it — completed B's task and wrote a `superseded` event into B's chain,
 * attributed to the A user. Ten tests were RED against 0118's exact catalogue
 * before the migration: the five "B cannot…", the first three "…leaves B
 * untouched" (the fourth pins 0118's own protections and was already green)
 * and the two catalogue tests.
 *
 * TWO KINDS OF CALLER, as in deal-close.test.ts: supabase-js clients through
 * PostgREST — exactly how the app writes tasks and closes deals — and one `pg`
 * session as postgres for fixtures, verification and cleanup. That session
 * also PLANTS the cross-organisation row the constraint now refuses (with
 * `session_replication_role = replica`, which skips the referential check the
 * way a row written before a NOT VALID constraint, or loaded by a replica-mode
 * restore, escapes it): the trigger's own predicate is what must protect
 * against a row the constraint could not stop.
 *
 * TWO THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN = Date.now().toString(36);

let o: Client; // postgres: fixtures, planting, verification, cleanup
let svc: SupabaseClient;

let adminA: TestUser;
let agentA: TestUser; // owns A's deals
let agentA2: TestUser; // another staff member of A — a reminder's assignee
let adminB: TestUser;
let agentB: TestUser;
const userIds: string[] = [];
const stageOf: Record<string, string> = {};
let n = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function newDeal(org: string, owner: string, opts: { lastContactAt?: string | null } = {}) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by, last_contact_at)
     values ($1, 'sale', $2, $3, $4, $4, $5) returning id`,
    [org, stageOf[org], `ZZTEST org-isolation ${RUN} ${n}`, owner, opts.lastContactAt ?? null],
  );
  return rows[0]!.id;
}

/** A row as postgres — a fixture, not a probe. */
async function seedTask(t: {
  org: string;
  deal?: string | null;
  assignee: string;
  kind?: string | null;
  title?: string;
}) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into tasks (org_id, title, due_at, assignee_id, created_by, deal_id, kind)
     values ($1, $2, now() + interval '1 day', $3, $3, $4, $5) returning id`,
    [t.org, t.title ?? `ZZTEST task ${RUN} ${n}`, t.assignee, t.deal ?? null, t.kind ?? null],
  );
  return rows[0]!.id;
}

/**
 * The row 0119's constraint refuses, written past it: organisation B's task
 * naming organisation A's deal. `session_replication_role = replica` disables
 * the referential triggers for this transaction only — the SET is permitted to
 * postgres on the pinned local image (CI runs the same one); this file is never
 * pointed at hosted, where postgres is not a superuser. The row is otherwise
 * ordinary and committed.
 */
async function plantCrossOrgTask(org: string, foreignDeal: string, assignee: string) {
  n += 1;
  await o.query("begin");
  try {
    await o.query("set local session_replication_role = replica");
    const { rows } = await o.query<{ id: string }>(
      `insert into tasks (org_id, title, due_at, assignee_id, created_by, deal_id, kind)
       values ($1, $2, now() + interval '1 day', $3, $3, $4, 'deal_no_contact') returning id`,
      [org, `ZZTEST planted ${RUN} ${n}`, assignee, foreignDeal],
    );
    await o.query("commit");
    return rows[0]!.id;
  } catch (e) {
    await o.query("rollback");
    throw e;
  }
}

async function taskRow(id: string) {
  const { rows } = await o.query<{ org_id: string; deal_id: string | null; is_done: boolean; done_at: Date | null }>(
    "select org_id, deal_id, is_done, done_at from tasks where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

async function eventsMark() {
  const { rows } = await o.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events");
  return rows[0]!.m;
}

/**
 * Events written after `mark` in the given organisation(s) — always one of the
 * two this file owns. Never the whole table: the local stack's own crons
 * (lead-sla every 10 minutes, the nightly sweeps) write into other
 * organisations on their own schedule, and that is not this trigger's doing.
 */
async function eventsSince(mark: string, orgs: string | string[] = [ORG_A, ORG_B]) {
  const { rows } = await o.query<{
    id: string;
    org_id: string;
    entity_type: string;
    entity_id: string;
    event_type: string;
    actor_id: string | null;
    payload: Record<string, unknown>;
  }>(
    `select id::text, org_id, entity_type, entity_id, event_type, actor_id, payload
       from events where id > $1::bigint and org_id = any($2::uuid[]) order by id`,
    [mark, Array.isArray(orgs) ? orgs : [orgs]],
  );
  return rows;
}

async function chainOk(org: string) {
  const { data, error } = await svc.rpc("verify_events_chain", { p_org: org });
  expect(error).toBeNull();
  return data as boolean;
}

/** Refuse ONE event type for ONE entity, in the database (committed); returns the remover. */
async function failEvent(entityId: string, eventType: string) {
  n += 1;
  const fn = `zz_tdo_fail_${RUN}_${n}`;
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

const closeLost = (client: SupabaseClient, dealId: string, reason = "Buyer withdrew") =>
  client.rpc("close_deal", {
    p_deal_id: dealId,
    p_outcome: "lost",
    p_final_value: null,
    p_lost_reason: reason,
    p_override: false,
  });

/** What lib/actions/deals.ts logDealContact writes: the one column, as the user. */
const logContact = (client: SupabaseClient, dealId: string) =>
  client.from("deals").update({ last_contact_at: new Date().toISOString() }).eq("id", dealId).select("id");

type Fixture = {
  deal: string;
  mine: string; // A's reminder, assigned to the deal's agent
  colleague: string; // A's reminder, assigned to another staff member of A
  plain: string; // A's ordinary task on the deal (no kind) — never superseded
  planted: string; // B's task naming A's deal, written past the constraint
  ownB: string; // B's reminder on B's own deal — a control
  dealB: string;
};

/** The shape every "leaves B untouched" test starts from. */
async function fixture(): Promise<Fixture> {
  const deal = await newDeal(ORG_A, agentA.id);
  const dealB = await newDeal(ORG_B, agentB.id);
  return {
    deal,
    dealB,
    mine: await seedTask({ org: ORG_A, deal, assignee: agentA.id, kind: "deal_no_contact" }),
    colleague: await seedTask({ org: ORG_A, deal, assignee: agentA2.id, kind: "deal_no_contact" }),
    plain: await seedTask({ org: ORG_A, deal, assignee: agentA.id }),
    planted: await plantCrossOrgTask(ORG_B, deal, agentB.id),
    ownB: await seedTask({ org: ORG_B, deal: dealB, assignee: agentB.id, kind: "deal_no_contact" }),
  };
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  const { rows: stale } = await o.query<{ tgname: string }>(
    "select tgname from pg_trigger where tgrelid = 'public.events'::regclass and tgname like 'zz_tdo_fail_%'",
  );
  for (const t of stale) {
    await o.query(`drop trigger if exists ${t.tgname} on public.events`);
    await o.query(`drop function if exists public.${t.tgname}()`);
  }

  await ensureTestOrg(svc, ORG_A, `org-isolation A ${RUN}`, `org-isolation-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `org-isolation B ${RUN}`, `org-isolation-b-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors ({} messages)
  adminA = await createTestUser(svc, `tdo-admin-a-${RUN}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `tdo-agent-a-${RUN}@test.local`, "agent", ORG_A);
  agentA2 = await createTestUser(svc, `tdo-agent-a2-${RUN}@test.local`, "agent", ORG_A);
  adminB = await createTestUser(svc, `tdo-admin-b-${RUN}@test.local`, "admin", ORG_B);
  agentB = await createTestUser(svc, `tdo-agent-b-${RUN}@test.local`, "agent", ORG_B);
  userIds.push(adminA.id, agentA.id, agentA2.id, adminB.id, agentB.id);

  for (const org of [ORG_A, ORG_B]) {
    const { rows } = await o.query<{ id: string }>(
      "select id from deal_stages where org_id = $1 and deal_type = 'sale' order by sort_order limit 1",
      [org],
    );
    stageOf[org] = rows[0]!.id;
  }
});

afterAll(async () => {
  // every task of BOTH organisations before any deal: the planted rows name
  // the other organisation's deal (and, against 0118, so did B's probes)
  for (const org of [ORG_A, ORG_B]) await o.query("delete from tasks where org_id = $1", [org]);
  for (const org of [ORG_A, ORG_B]) {
    await o.query("delete from offers where org_id = $1", [org]);
    await o.query("delete from deals where org_id = $1", [org]);
  }
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const org of [ORG_A, ORG_B]) {
    await o.query("delete from profiles where org_id = $1", [org]);
    await o.query("delete from events where org_id = $1", [org]);
    await o.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await o.query("delete from chain_checks where org_id = $1", [org]);
    await o.query("delete from deal_stages where org_id = $1", [org]);
    await o.query("delete from districts where org_id = $1", [org]);
    await o.query("delete from organizations where id = $1", [org]);
  }
  await o.end();
});

// ---------------------------------------------------------------------------
describe("the premise: organisation B cannot read organisation A's deal", () => {
  it("neither B's admin nor B's agent sees it; A's agent does", async () => {
    const deal = await newDeal(ORG_A, agentA.id);
    for (const c of [adminB.client, agentB.client]) {
      const r = await c.from("deals").select("id").eq("id", deal);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([]);
    }
    const mine = await agentA.client.from("deals").select("id").eq("id", deal);
    expect(mine.data).toEqual([{ id: deal }]);
  });
});

describe("B cannot create, re-point or upsert a task onto A's deal (23503, nothing written)", () => {
  // KNOWN GAP at 0118, now a regression: the single-column key accepted every
  // one of these (201 / 200) — tasks_insert / tasks_update check only the
  // caller's organisation. A foreign-key refusal is a 409 with code 23503.
  const shape = (deal: string, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    title: `ZZTEST planted by B ${RUN}`,
    deal_id: deal,
    ...extra,
  });

  it("INSERT — as B's agent and as B's admin, a reminder or an ordinary task", async () => {
    const deal = await newDeal(ORG_A, agentA.id);
    const attempts = [
      { who: "B's agent", client: agentB.client, row: shape(deal, { assignee_id: agentB.id, kind: "deal_no_contact" }) },
      { who: "B's admin", client: adminB.client, row: shape(deal, { assignee_id: adminB.id }) },
    ];
    for (const a of attempts) {
      const r = await a.client.from("tasks").insert(a.row).select("id");
      expect(r.error?.code, a.who).toBe("23503");
      expect(r.data, a.who).toBeNull();
    }
    const { rows } = await o.query("select count(*)::int as c from tasks where deal_id = $1", [deal]);
    expect(rows[0]!.c, "no row landed").toBe(0);
  });

  it("UPDATE — a task of B, with or without a deal of its own, cannot be pointed at A's deal", async () => {
    const dealA = await newDeal(ORG_A, agentA.id);
    const dealB = await newDeal(ORG_B, agentB.id);
    const bare = await seedTask({ org: ORG_B, assignee: agentB.id });
    const linked = await seedTask({ org: ORG_B, deal: dealB, assignee: agentB.id, kind: "deal_no_contact" });
    for (const [id, who, client] of [
      [bare, "agent, task without a deal", agentB.client],
      [linked, "agent, task on B's own deal", agentB.client],
      [linked, "admin, task on B's own deal", adminB.client],
    ] as const) {
      const r = await client.from("tasks").update({ deal_id: dealA }).eq("id", id).select("id");
      expect(r.error?.code, who).toBe("23503");
    }
    expect((await taskRow(bare))!.deal_id).toBeNull();
    expect((await taskRow(linked))!.deal_id).toBe(dealB);
  });

  it("UPSERT — onto an existing task of B (merge) and as a new id: refused, nothing written", async () => {
    const dealA = await newDeal(ORG_A, agentA.id);
    const existing = await seedTask({ org: ORG_B, assignee: agentB.id });
    const merge = await agentB.client
      .from("tasks")
      .upsert({ id: existing, ...shape(dealA, { assignee_id: agentB.id }) }, { onConflict: "id" })
      .select("id");
    expect(merge.error?.code).toBe("23503");
    expect((await taskRow(existing))!.deal_id).toBeNull();

    const fresh = randomUUID();
    const insert = await adminB.client
      .from("tasks")
      .upsert({ id: fresh, ...shape(dealA, { assignee_id: adminB.id }) }, { onConflict: "id" })
      .select("id");
    expect(insert.error?.code).toBe("23503");
    expect(await taskRow(fresh)).toBeNull();
  });

  it("a task's organisation cannot be moved away from its deal's — by a user session (RLS) or by the service role (the key)", async () => {
    const deal = await newDeal(ORG_A, agentA.id);
    const task = await seedTask({ org: ORG_A, deal, assignee: agentA.id, kind: "deal_no_contact" });
    // tasks_update's WITH CHECK: the new row must be in the caller's organisation
    const user = await adminA.client.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
    expect(user.error?.code).toBe("42501");
    // the maintenance role is not exempt from a foreign key (unlike 0118's
    // role-keyed guard): the pair (B, A's deal) does not exist
    const maintenance = await svc.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
    expect(maintenance.error?.code).toBe("23503");
    expect((await taskRow(task))!.org_id).toBe(ORG_A);
  });

  it("the refusal no longer tells B whether an A deal id exists", async () => {
    // at 0118 an existing A id answered 201 and a missing id 23503 — an oracle
    const real = await newDeal(ORG_A, agentA.id);
    const missing = randomUUID();
    const a = await agentB.client.from("tasks").insert(shape(real, { assignee_id: agentB.id })).select("id");
    const b = await agentB.client.from("tasks").insert(shape(missing, { assignee_id: agentB.id })).select("id");
    expect(a.error?.code).toBe("23503");
    expect(b.error?.code).toBe("23503");
    expect(a.error?.message).toBe(b.error?.message);
  });
});

describe("same-organisation links, tasks without a deal, embeds and maintenance stay as they were", () => {
  it("A's agent and admin link tasks to A's deals; a task without a deal is fine; re-pointing within A is fine", async () => {
    const d1 = await newDeal(ORG_A, agentA.id);
    const d2 = await newDeal(ORG_A, agentA.id);
    const linked = await agentA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST own ${RUN}`, deal_id: d1, assignee_id: agentA.id, created_by: agentA.id })
      .select("id")
      .single();
    expect(linked.error).toBeNull();
    const none = await adminA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST no deal ${RUN}`, assignee_id: adminA.id, created_by: adminA.id })
      .select("id")
      .single();
    expect(none.error).toBeNull();
    expect((await taskRow(none.data!.id))!.deal_id).toBeNull();

    const moved = await agentA.client.from("tasks").update({ deal_id: d2 }).eq("id", linked.data!.id).select("id");
    expect(moved.error).toBeNull();
    expect(moved.data).toEqual([{ id: linked.data!.id }]);
    const cleared = await agentA.client.from("tasks").update({ deal_id: null }).eq("id", linked.data!.id).select("id");
    expect(cleared.error).toBeNull();
    expect((await taskRow(linked.data!.id))!.deal_id).toBeNull();
  });

  it("PostgREST still resolves the one relationship in both directions (no PGRST201)", async () => {
    // replacing the single-column key rather than adding beside it is what
    // keeps `deals(...)` from tasks and `tasks(...)` from deals unambiguous
    const deal = await newDeal(ORG_A, agentA.id);
    const task = await seedTask({ org: ORG_A, deal, assignee: agentA.id });
    const fromTasks = await adminA.client.from("tasks").select("id, deals(id, title)").eq("id", task).single();
    expect(fromTasks.error).toBeNull();
    // untyped clients infer every embed as an array; the shape is asserted here
    expect((fromTasks.data as unknown as { deals: { id: string } | null }).deals?.id).toBe(deal);
    const fromDeals = await adminA.client.from("deals").select("id, tasks(id)").eq("id", deal).single();
    expect(fromDeals.error).toBeNull();
    expect((fromDeals.data as unknown as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual([task]);
  });

  it("the nightly sweep still mints a reminder in the deal's own organisation (its insert meets the new key)", async () => {
    const stale = await newDeal(ORG_A, agentA.id, {
      lastContactAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    });
    const r = await svc.rpc("create_followup_nudges", { p_org: ORG_A });
    expect(r.error).toBeNull();
    const { rows } = await o.query<{ org_id: string; assignee_id: string }>(
      "select org_id, assignee_id from tasks where deal_id = $1 and kind = 'deal_no_contact' and not is_done",
      [stale],
    );
    expect(rows).toEqual([{ org_id: ORG_A, assignee_id: agentA.id }]);
  });

  it("deletion: a deal with tasks still cannot be deleted (NO ACTION, as before); a task can, and then the deal", async () => {
    const deal = await newDeal(ORG_A, agentA.id);
    const task = await seedTask({ org: ORG_A, deal, assignee: agentA.id });
    await expect(o.query("delete from deals where id = $1", [deal])).rejects.toMatchObject({ code: "23503" });
    const gone = await svc.from("tasks").delete().eq("id", task).select("id");
    expect(gone.error).toBeNull();
    expect(gone.data).toEqual([{ id: task }]);
    const dealGone = await svc.from("deals").delete().eq("id", deal).select("id");
    expect(dealGone.error).toBeNull();
    expect(dealGone.data).toEqual([{ id: deal }]);
  });
});

describe("closing or contacting A's deal leaves B's task and B's chain untouched", () => {
  // KNOWN GAP at 0118, now a regression: the planted row was completed and a
  // `superseded` event landed in B's chain, actor = the A user.
  async function expectUntouched(f: Fixture, mark: string) {
    expect(await taskRow(f.planted), "B's planted task").toMatchObject({ is_done: false, done_at: null, org_id: ORG_B });
    expect(await taskRow(f.ownB), "B's own reminder").toMatchObject({ is_done: false, done_at: null });
    expect(await eventsSince(mark, ORG_B), "nothing was written into B's chain").toEqual([]);
    expect(await chainOk(ORG_B)).toBe(true);
    expect(await chainOk(ORG_A)).toBe(true);
  }

  it("close_deal: A's two reminders complete — the colleague's too — with one `superseded` event each, actor = the closer, reason deal_closed; the ordinary task stays open", async () => {
    const f = await fixture();
    const mark = await eventsMark();
    const r = await closeLost(agentA.client, f.deal);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ result: "closed", status: "lost" });

    for (const id of [f.mine, f.colleague]) {
      const row = await taskRow(id);
      expect(row!.is_done, id).toBe(true);
      expect(row!.done_at, id).not.toBeNull();
    }
    expect((await taskRow(f.plain))!.is_done, "an ordinary task on the deal is not a reminder").toBe(false);

    const superseded = (await eventsSince(mark, ORG_A)).filter((e) => e.event_type === "superseded");
    expect(superseded.map((e) => e.entity_id).sort()).toEqual([f.mine, f.colleague].sort());
    for (const e of superseded) {
      expect(e.entity_type).toBe("task");
      expect(e.actor_id).toBe(agentA.id);
      expect(e.payload).toEqual({ kind: "deal_no_contact", deal_id: f.deal, reason: "deal_closed" });
    }
    await expectUntouched(f, mark);
  });

  it("logging contact (the trigger's other branch): A's reminders complete with reason deal_contacted; B untouched", async () => {
    const f = await fixture();
    const mark = await eventsMark();
    const r = await logContact(agentA.client, f.deal);
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ id: f.deal }]);

    for (const id of [f.mine, f.colleague]) expect((await taskRow(id))!.is_done, id).toBe(true);
    const superseded = (await eventsSince(mark, ORG_A)).filter((e) => e.event_type === "superseded");
    expect(superseded.map((e) => e.entity_id).sort()).toEqual([f.mine, f.colleague].sort());
    for (const e of superseded) {
      expect(e.actor_id).toBe(agentA.id);
      expect(e.payload).toEqual({ kind: "deal_no_contact", deal_id: f.deal, reason: "deal_contacted" });
    }
    await expectUntouched(f, mark);
  });

  it("a refused event during the close rolls the reminders back too; B untouched either way; the deal closes on retry", async () => {
    const f = await fixture();
    const mark = await eventsMark();
    const remove = await failEvent(f.deal, "lost");
    let refused: Awaited<ReturnType<typeof closeLost>>;
    try {
      refused = await closeLost(agentA.client, f.deal);
    } finally {
      await remove();
    }
    expect(refused.error?.message ?? "").toMatch(/injected failure/);
    expect(refused.data).toBeNull();
    for (const id of [f.mine, f.colleague]) expect((await taskRow(id))!.is_done, id).toBe(false);
    expect(await eventsSince(mark), "no event of the failed close survived").toEqual([]);
    const { rows } = await o.query("select status::text from deals where id = $1", [f.deal]);
    expect(rows[0]!.status).toBe("open");
    await expectUntouched(f, mark);

    const retry = await closeLost(agentA.client, f.deal);
    expect(retry.data).toMatchObject({ result: "closed" });
    for (const id of [f.mine, f.colleague]) expect((await taskRow(id))!.is_done, id).toBe(true);
    await expectUntouched(f, mark);
  });

  it("the deal-close protections stand: B cannot close A's deal, a direct PATCH cannot, and the planted row grants B nothing", async () => {
    const f = await fixture();
    const mark = await eventsMark();
    for (const c of [adminB.client, agentB.client]) {
      const r = await closeLost(c, f.deal);
      expect(r.error?.message).toBe("Deal not found");
    }
    const patch = await agentA.client
      .from("deals")
      .update({ status: "won", won_at: new Date().toISOString() })
      .eq("id", f.deal)
      .select("id");
    expect(patch.error?.message).toBe("Deal is open — it is marked won only from the deal page (close_deal)");
    // B still cannot read the deal its planted task names
    expect((await agentB.client.from("deals").select("id").eq("id", f.deal)).data).toEqual([]);
    const { rows } = await o.query("select status::text from deals where id = $1", [f.deal]);
    expect(rows[0]!.status).toBe("open");
    expect(await eventsSince(mark)).toEqual([]);
  });
});

describe("the catalogue: one tenant-bound, validated relationship; the trigger scoped in its own text", () => {
  it("tasks (org_id, deal_id) -> deals (org_id, id), validated, NO ACTION; the single-column key is gone; the referenced unique key and the index exist", async () => {
    const { rows } = await o.query<{
      conname: string;
      cols: string[];
      refcols: string[];
      convalidated: boolean;
      confdeltype: string;
      confupdtype: string;
    }>(
      // ::text[] — node-pg hands a name[] back as its literal text
      `select conname, convalidated, confdeltype, confupdtype,
              (select array_agg(a.attname::text order by k.ord) from unnest(conkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = conrelid and a.attnum = k.attnum)::text[] as cols,
              (select array_agg(a.attname::text order by k.ord) from unnest(confkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = confrelid and a.attnum = k.attnum)::text[] as refcols
         from pg_constraint
        where conrelid = 'public.tasks'::regclass and confrelid = 'public.deals'::regclass and contype = 'f'`,
    );
    expect(rows).toEqual([
      {
        conname: "tasks_org_deal_fkey",
        cols: ["org_id", "deal_id"],
        refcols: ["org_id", "id"],
        convalidated: true,
        confdeltype: "a",
        confupdtype: "a",
      },
    ]);
    const { rows: keys } = await o.query<{ conname: string; contype: string }>(
      `select conname, contype from pg_constraint
        where (conrelid = 'public.deals'::regclass and conname = 'deals_org_id_id_key')
           or (conrelid = 'public.tasks'::regclass and conname = 'tasks_deal_id_fkey')
        order by 1`,
    );
    expect(keys).toEqual([{ conname: "deals_org_id_id_key", contype: "u" }]);
    const { rows: idx } = await o.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'tasks' and indexname = 'tasks_org_deal_idx'",
    );
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toMatch(/\(org_id, deal_id\) WHERE \(deal_id IS NOT NULL\)/);
  });

  it("trg_supersede_deal_nudges scopes its UPDATE to the deal's organisation, stays a definer nobody can call, and is still 0025's AFTER UPDATE WHEN trigger", async () => {
    const { rows } = await o.query<{ src: string; secdef: boolean; config: string[]; anon: boolean; auth: boolean }>(
      `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.oid = 'public.trg_supersede_deal_nudges()'::regprocedure`,
    );
    const code = rows[0]!.src.replace(/--[^\n]*/g, "");
    expect(code).toMatch(/where t\.deal_id = new\.id\s+and t\.org_id = new\.org_id\s+and t\.kind = 'deal_no_contact'/);
    expect(rows[0]).toMatchObject({ secdef: true, config: ["search_path=public"], anon: false, auth: false });
    const { rows: trg } = await o.query<{ def: string }>(
      "select pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = 'public.deals'::regclass and tgname = 'deals_supersede_nudges'",
    );
    expect(trg[0]!.def).toBe(
      "CREATE TRIGGER deals_supersede_nudges AFTER UPDATE ON public.deals FOR EACH ROW WHEN (((old.last_contact_at IS DISTINCT FROM new.last_contact_at) OR (old.status IS DISTINCT FROM new.status))) EXECUTE FUNCTION trg_supersede_deal_nudges()",
    );
  });
});
