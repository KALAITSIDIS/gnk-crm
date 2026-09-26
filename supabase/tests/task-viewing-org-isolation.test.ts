import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * 0120: a task belongs to the organisation of the viewing it names, and a
 * viewing's feedback-reminder supersession stays inside that organisation —
 * the viewing twin of 0119 (task-deal-org-isolation.test.ts).
 *
 * THE GAP, as it stood at 0119: `tasks.viewing_id` referenced `viewings(id)`
 * alone and `tasks_insert` / `tasks_update` check only the caller's
 * organisation, so a member of organisation B who knew an organisation-A
 * viewing id could plant a task of B on it (INSERT, PATCH or UPSERT); and
 * `trg_supersede_viewing_nudges` (0020) matched by `viewing_id` alone, so A
 * saving feedback on the viewing — or moving its status — completed B's task
 * and wrote a `superseded` event into B's chain, attributed to the A user.
 * The tests marked "RED at 0119" below failed against 0119's exact catalogue
 * before the migration; the rest pin what must not change.
 *
 * TWO KINDS OF CALLER, as in 0119's file: supabase-js clients through
 * PostgREST — exactly how the app saves feedback and moves a viewing's status
 * (lib/actions/viewings.ts: `update({ feedback })`, `update({ status })` with a
 * compare-and-set on `scheduled`) — and one `pg` session as postgres for
 * fixtures, verification and cleanup. That session also PLANTS the
 * cross-organisation row the constraint now refuses (with
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
let agentA: TestUser; // A's viewings' agent
let agentA2: TestUser; // another staff member of A — a reminder's assignee
let adminB: TestUser;
let agentB: TestUser;
const userIds: string[] = [];
const propertyOf: Record<string, string> = {};
const contactOf: Record<string, string> = {};
let n = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function newViewing(
  org: string,
  agent: string,
  opts: { status?: "scheduled" | "completed"; hoursAgo?: number } = {},
) {
  const { rows } = await o.query<{ id: string }>(
    `insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at, status, created_by)
     values ($1, $2, $3, $4, now() - make_interval(hours => $5), $6, $4) returning id`,
    // default age 1h: younger than any feedback window, so the local stack's
    // nightly sweep (03:15 UTC, every organisation) mints nothing for a fixture
    [org, propertyOf[org], contactOf[org], agent, opts.hoursAgo ?? 1, opts.status ?? "completed"],
  );
  return rows[0]!.id;
}

/** A row as postgres — a fixture, not a probe. */
async function seedTask(t: {
  org: string;
  viewing?: string | null;
  assignee: string;
  kind?: string | null;
  title?: string;
}) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into tasks (org_id, title, due_at, assignee_id, created_by, viewing_id, property_id, kind)
     values ($1, $2, now() + interval '1 day', $3, $3, $4, $5, $6) returning id`,
    [t.org, t.title ?? `ZZTEST task ${RUN} ${n}`, t.assignee, t.viewing ?? null, propertyOf[t.org], t.kind ?? null],
  );
  return rows[0]!.id;
}

/**
 * The row 0120's constraint refuses, written past it: organisation B's
 * reminder naming organisation A's viewing. `session_replication_role =
 * replica` disables the referential triggers for this transaction only — the
 * SET is permitted to postgres on the pinned local image (CI runs the same
 * one); this file is never pointed at hosted, where postgres is not a
 * superuser. The row is otherwise ordinary and committed.
 */
async function plantCrossOrgTask(org: string, foreignViewing: string, assignee: string) {
  n += 1;
  await o.query("begin");
  try {
    await o.query("set local session_replication_role = replica");
    const { rows } = await o.query<{ id: string }>(
      `insert into tasks (org_id, title, due_at, assignee_id, created_by, viewing_id, kind)
       values ($1, $2, now() + interval '1 day', $3, $3, $4, 'viewing_feedback') returning id`,
      [org, `ZZTEST planted ${RUN} ${n}`, assignee, foreignViewing],
    );
    await o.query("commit");
    return rows[0]!.id;
  } catch (e) {
    await o.query("rollback");
    throw e;
  }
}

async function taskRow(id: string) {
  const { rows } = await o.query<{ org_id: string; viewing_id: string | null; is_done: boolean; done_at: Date | null }>(
    "select org_id, viewing_id, is_done, done_at from tasks where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

async function viewingRow(id: string) {
  const { rows } = await o.query<{ status: string; feedback: unknown }>(
    "select status::text, feedback from viewings where id = $1",
    [id],
  );
  return rows[0]!;
}

async function eventsMark() {
  const { rows } = await o.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events");
  return rows[0]!.m;
}

/**
 * Events written after `mark` in the given organisation(s) — always one of the
 * two this file owns. Never the whole table: the local stack's own crons write
 * into every organisation on their own schedule (lead-sla every 10 minutes;
 * the nightly sweep into these two as well — which is why fixture viewings are
 * younger than any feedback window), and that is not this trigger's doing.
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
  const fn = `zz_tvo_fail_${RUN}_${n}`;
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

/** What lib/actions/viewings.ts saveViewingFeedback writes: the one column, as the user. */
const saveFeedback = (client: SupabaseClient, viewingId: string) =>
  client
    .from("viewings")
    .update({ feedback: { rating: 4, liked: null, disliked: null, comment: null } })
    .eq("id", viewingId)
    .select("id");

/** What updateViewingStatus writes: a compare-and-set on `scheduled`, as the user. */
const cancelViewing = (client: SupabaseClient, viewingId: string) =>
  client.from("viewings").update({ status: "cancelled" }).eq("id", viewingId).eq("status", "scheduled").select("id");

type Fixture = {
  viewing: string;
  mine: string; // A's reminder, assigned to the viewing's agent
  colleague: string; // A's reminder, assigned to another staff member of A
  plain: string; // A's ordinary task on the viewing (no kind) — never superseded
  planted: string; // B's reminder naming A's viewing, written past the constraint
  ownB: string; // B's reminder on B's own viewing — a control
  viewingB: string;
};

/** The shape every "leaves B untouched" test starts from. */
async function fixture(status: "scheduled" | "completed" = "completed"): Promise<Fixture> {
  const viewing = await newViewing(ORG_A, agentA.id, { status });
  const viewingB = await newViewing(ORG_B, agentB.id);
  return {
    viewing,
    viewingB,
    mine: await seedTask({ org: ORG_A, viewing, assignee: agentA.id, kind: "viewing_feedback" }),
    colleague: await seedTask({ org: ORG_A, viewing, assignee: agentA2.id, kind: "viewing_feedback" }),
    plain: await seedTask({ org: ORG_A, viewing, assignee: agentA.id }),
    planted: await plantCrossOrgTask(ORG_B, viewing, agentB.id),
    ownB: await seedTask({ org: ORG_B, viewing: viewingB, assignee: agentB.id, kind: "viewing_feedback" }),
  };
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  const { rows: stale } = await o.query<{ tgname: string }>(
    "select tgname from pg_trigger where tgrelid = 'public.events'::regclass and tgname like 'zz_tvo_fail_%'",
  );
  for (const t of stale) {
    await o.query(`drop trigger if exists ${t.tgname} on public.events`);
    await o.query(`drop function if exists public.${t.tgname}()`);
  }

  await ensureTestOrg(svc, ORG_A, `viewing-isolation A ${RUN}`, `viewing-isolation-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `viewing-isolation B ${RUN}`, `viewing-isolation-b-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors ({} messages)
  adminA = await createTestUser(svc, `tvo-admin-a-${RUN}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `tvo-agent-a-${RUN}@test.local`, "agent", ORG_A);
  agentA2 = await createTestUser(svc, `tvo-agent-a2-${RUN}@test.local`, "agent", ORG_A);
  adminB = await createTestUser(svc, `tvo-admin-b-${RUN}@test.local`, "admin", ORG_B);
  agentB = await createTestUser(svc, `tvo-agent-b-${RUN}@test.local`, "agent", ORG_B);
  userIds.push(adminA.id, agentA.id, agentA2.id, adminB.id, agentB.id);

  for (const org of [ORG_A, ORG_B]) {
    const { rows: p } = await o.query<{ id: string }>(
      `insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id`,
      [org, `TVO${RUN}${org === ORG_A ? "A" : "B"}`],
    );
    propertyOf[org] = p[0]!.id;
    const { rows: c } = await o.query<{ id: string }>(
      `insert into contacts (org_id, first_name) values ($1, 'ZZTEST viewing buyer') returning id`,
      [org],
    );
    contactOf[org] = c[0]!.id;
  }
});

afterAll(async () => {
  // every task of BOTH organisations before any viewing: the planted rows name
  // the other organisation's viewing
  for (const org of [ORG_A, ORG_B]) await o.query("delete from tasks where org_id = $1", [org]);
  for (const org of [ORG_A, ORG_B]) {
    await o.query("delete from viewings where org_id = $1", [org]);
    await o.query("delete from contacts where org_id = $1", [org]);
    await o.query("delete from properties where org_id = $1", [org]);
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
describe("the premise: organisation B cannot read organisation A's viewing", () => {
  it("neither B's admin nor B's agent sees it; A's agent does", async () => {
    const viewing = await newViewing(ORG_A, agentA.id);
    for (const c of [adminB.client, agentB.client]) {
      const r = await c.from("viewings").select("id").eq("id", viewing);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([]);
    }
    const mine = await agentA.client.from("viewings").select("id").eq("id", viewing);
    expect(mine.data).toEqual([{ id: viewing }]);
  });
});

describe("B cannot create, re-point or upsert a task onto A's viewing (23503, nothing written) — RED at 0119", () => {
  const shape = (viewing: string, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    title: `ZZTEST planted by B ${RUN}`,
    viewing_id: viewing,
    ...extra,
  });

  it("INSERT — as B's agent and as B's admin, a reminder or an ordinary task", async () => {
    const viewing = await newViewing(ORG_A, agentA.id);
    const attempts = [
      { who: "B's agent", client: agentB.client, row: shape(viewing, { assignee_id: agentB.id, kind: "viewing_feedback" }) },
      { who: "B's admin", client: adminB.client, row: shape(viewing, { assignee_id: adminB.id }) },
    ];
    for (const a of attempts) {
      const r = await a.client.from("tasks").insert(a.row).select("id");
      expect(r.error?.code, a.who).toBe("23503");
      expect(r.data, a.who).toBeNull();
    }
    const { rows } = await o.query("select count(*)::int as c from tasks where viewing_id = $1", [viewing]);
    expect(rows[0]!.c, "no row landed").toBe(0);
  });

  it("UPDATE — a task of B, with or without a viewing of its own, cannot be pointed at A's viewing", async () => {
    const viewingA = await newViewing(ORG_A, agentA.id);
    const viewingB = await newViewing(ORG_B, agentB.id);
    const bare = await seedTask({ org: ORG_B, assignee: agentB.id });
    const linked = await seedTask({ org: ORG_B, viewing: viewingB, assignee: agentB.id, kind: "viewing_feedback" });
    for (const [id, who, client] of [
      [bare, "agent, task without a viewing", agentB.client],
      [linked, "agent, task on B's own viewing", agentB.client],
      [linked, "admin, task on B's own viewing", adminB.client],
    ] as const) {
      const r = await client.from("tasks").update({ viewing_id: viewingA }).eq("id", id).select("id");
      expect(r.error?.code, who).toBe("23503");
    }
    expect((await taskRow(bare))!.viewing_id).toBeNull();
    expect((await taskRow(linked))!.viewing_id).toBe(viewingB);
  });

  it("UPSERT — onto an existing task of B (merge) and as a new id: refused, nothing written", async () => {
    const viewingA = await newViewing(ORG_A, agentA.id);
    const existing = await seedTask({ org: ORG_B, assignee: agentB.id });
    const merge = await agentB.client
      .from("tasks")
      .upsert({ id: existing, ...shape(viewingA, { assignee_id: agentB.id }) }, { onConflict: "id" })
      .select("id");
    expect(merge.error?.code).toBe("23503");
    expect((await taskRow(existing))!.viewing_id).toBeNull();

    const fresh = randomUUID();
    const insert = await adminB.client
      .from("tasks")
      .upsert({ id: fresh, ...shape(viewingA, { assignee_id: adminB.id }) }, { onConflict: "id" })
      .select("id");
    expect(insert.error?.code).toBe("23503");
    expect(await taskRow(fresh)).toBeNull();
  });

  it("a task's organisation cannot be moved away from its viewing's — by a user session (RLS) or by the service role (the key)", async () => {
    const viewing = await newViewing(ORG_A, agentA.id);
    const task = await seedTask({ org: ORG_A, viewing, assignee: agentA.id, kind: "viewing_feedback" });
    const user = await adminA.client.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
    expect(user.error?.code).toBe("42501");
    const maintenance = await svc.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
    expect(maintenance.error?.code).toBe("23503");
    expect((await taskRow(task))!.org_id).toBe(ORG_A);
  });

  it("the refusal no longer tells B whether an A viewing id exists", async () => {
    // at 0119 an existing A id answered 201 and a missing id 23503 — an oracle
    const real = await newViewing(ORG_A, agentA.id);
    const missing = randomUUID();
    const a = await agentB.client.from("tasks").insert(shape(real, { assignee_id: agentB.id })).select("id");
    const b = await agentB.client.from("tasks").insert(shape(missing, { assignee_id: agentB.id })).select("id");
    expect(a.error?.code).toBe("23503");
    expect(b.error?.code).toBe("23503");
    expect(a.error?.message).toBe(b.error?.message);
  });
});

describe("same-organisation links, tasks without a viewing, embeds, the sweep and deletion stay as they were", () => {
  it("A's agent and admin link tasks to A's viewings; a task without a viewing is fine; re-pointing within A is fine", async () => {
    const v1 = await newViewing(ORG_A, agentA.id);
    const v2 = await newViewing(ORG_A, agentA.id);
    const linked = await agentA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST own ${RUN}`, viewing_id: v1, assignee_id: agentA.id, created_by: agentA.id })
      .select("id")
      .single();
    expect(linked.error).toBeNull();
    const none = await adminA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST no viewing ${RUN}`, assignee_id: adminA.id, created_by: adminA.id })
      .select("id")
      .single();
    expect(none.error).toBeNull();
    expect((await taskRow(none.data!.id))!.viewing_id).toBeNull();

    const moved = await agentA.client.from("tasks").update({ viewing_id: v2 }).eq("id", linked.data!.id).select("id");
    expect(moved.error).toBeNull();
    expect(moved.data).toEqual([{ id: linked.data!.id }]);
    const cleared = await agentA.client.from("tasks").update({ viewing_id: null }).eq("id", linked.data!.id).select("id");
    expect(cleared.error).toBeNull();
    expect((await taskRow(linked.data!.id))!.viewing_id).toBeNull();
  });

  it("PostgREST still resolves the one relationship in both directions (no PGRST201)", async () => {
    const viewing = await newViewing(ORG_A, agentA.id);
    const task = await seedTask({ org: ORG_A, viewing, assignee: agentA.id });
    // untyped clients infer every embed as an array; the shape is asserted here
    const fromTasks = await adminA.client.from("tasks").select("id, viewings(id, status)").eq("id", task).single();
    expect(fromTasks.error).toBeNull();
    expect((fromTasks.data as unknown as { viewings: { id: string } | null }).viewings?.id).toBe(viewing);
    const fromViewings = await adminA.client.from("viewings").select("id, tasks(id)").eq("id", viewing).single();
    expect(fromViewings.error).toBeNull();
    expect((fromViewings.data as unknown as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual([task]);
  });

  it("the nightly sweep still mints a feedback reminder in the viewing's own organisation (its insert meets the new key)", async () => {
    // the window is one global setting (Settings → Nudges, 0052): read it, never assume 48h
    const { rows: h } = await o.query<{ h: number }>(
      "select public.nudge_threshold('viewing_feedback_hours', 48)::int as h",
    );
    const due = await newViewing(ORG_A, agentA.id, { status: "completed", hoursAgo: h[0]!.h + 24 });
    const r = await svc.rpc("create_followup_nudges", { p_org: ORG_A });
    expect(r.error).toBeNull();
    const { rows } = await o.query<{ org_id: string; assignee_id: string }>(
      "select org_id, assignee_id from tasks where viewing_id = $1 and kind = 'viewing_feedback' and not is_done",
      [due],
    );
    expect(rows).toEqual([{ org_id: ORG_A, assignee_id: agentA.id }]);
  });

  it("deletion: a viewing with tasks still cannot be deleted (NO ACTION, as before); no user session can delete a viewing at all", async () => {
    const viewing = await newViewing(ORG_A, agentA.id);
    const task = await seedTask({ org: ORG_A, viewing, assignee: agentA.id });
    await expect(o.query("delete from viewings where id = $1", [viewing])).rejects.toMatchObject({ code: "23503" });
    const asAdmin = await adminA.client.from("viewings").delete().eq("id", viewing).select("id");
    expect(asAdmin.error?.code, "no DELETE grant on viewings").toBe("42501");
    const gone = await svc.from("tasks").delete().eq("id", task).select("id");
    expect(gone.error).toBeNull();
    expect(gone.data).toEqual([{ id: task }]);
    await o.query("delete from viewings where id = $1", [viewing]);
    expect((await o.query("select count(*)::int as c from viewings where id = $1", [viewing])).rows[0]!.c).toBe(0);
  });
});

describe("saving feedback on, or moving, A's viewing leaves B's task and B's chain untouched", () => {
  async function expectUntouched(f: Fixture, mark: string) {
    expect(await taskRow(f.planted), "B's planted task").toMatchObject({ is_done: false, done_at: null, org_id: ORG_B });
    expect(await taskRow(f.ownB), "B's own reminder").toMatchObject({ is_done: false, done_at: null });
    expect(await eventsSince(mark, ORG_B), "nothing was written into B's chain").toEqual([]);
    expect(await chainOk(ORG_B)).toBe(true);
    expect(await chainOk(ORG_A)).toBe(true);
  }

  async function expectSupersededByA(f: Fixture, mark: string, actor: string) {
    for (const id of [f.mine, f.colleague]) {
      const row = await taskRow(id);
      expect(row!.is_done, id).toBe(true);
      expect(row!.done_at, id).not.toBeNull();
    }
    expect((await taskRow(f.plain))!.is_done, "an ordinary task on the viewing is not a reminder").toBe(false);
    const superseded = (await eventsSince(mark, ORG_A)).filter((e) => e.event_type === "superseded");
    expect(superseded.map((e) => e.entity_id).sort()).toEqual([f.mine, f.colleague].sort());
    for (const e of superseded) {
      expect(e.entity_type).toBe("task");
      expect(e.actor_id).toBe(actor);
      expect(e.payload).toEqual({
        kind: "viewing_feedback",
        viewing_id: f.viewing,
        reason: "feedback_logged_or_viewing_reopened",
      });
    }
  }

  it("feedback saved by A's agent (saveViewingFeedback's write): A's two reminders complete — the colleague's too — with one `superseded` event each, actor = the agent; the ordinary task stays open — RED at 0119", async () => {
    const f = await fixture("completed");
    const mark = await eventsMark();
    const r = await saveFeedback(agentA.client, f.viewing);
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ id: f.viewing }]);
    await expectSupersededByA(f, mark, agentA.id);
    await expectUntouched(f, mark);
  });

  it("the status branch (updateViewingStatus's write, scheduled → cancelled): A's reminders complete, B untouched — RED at 0119", async () => {
    const f = await fixture("scheduled");
    const mark = await eventsMark();
    const r = await cancelViewing(agentA.client, f.viewing);
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ id: f.viewing }]);
    await expectSupersededByA(f, mark, agentA.id);
    await expectUntouched(f, mark);
  });

  it("a refused `superseded` event rolls the feedback write back with the reminders; B untouched either way; the save succeeds on retry — RED at 0119", async () => {
    const f = await fixture("completed");
    const mark = await eventsMark();
    const remove = await failEvent(f.mine, "superseded");
    let refused: Awaited<ReturnType<typeof saveFeedback>>;
    try {
      refused = await saveFeedback(agentA.client, f.viewing);
    } finally {
      await remove();
    }
    expect(refused.error?.message ?? "").toMatch(/injected failure/);
    expect((await viewingRow(f.viewing)).feedback, "the feedback write rolled back").toBeNull();
    for (const id of [f.mine, f.colleague]) expect((await taskRow(id))!.is_done, id).toBe(false);
    expect(await eventsSince(mark), "no event of the failed write survived").toEqual([]);
    await expectUntouched(f, mark);

    const retry = await saveFeedback(agentA.client, f.viewing);
    expect(retry.error).toBeNull();
    await expectSupersededByA(f, mark, agentA.id);
    await expectUntouched(f, mark);
  });

  it("the viewing protections stand: B cannot write feedback on A's viewing (0 rows), and the planted row gives B no read of it", async () => {
    const f = await fixture("completed");
    const mark = await eventsMark();
    for (const c of [adminB.client, agentB.client]) {
      const r = await saveFeedback(c, f.viewing);
      expect(r.error).toBeNull();
      expect(r.data, "RLS refuses an UPDATE by matching zero rows").toEqual([]);
    }
    expect((await agentB.client.from("viewings").select("id").eq("id", f.viewing)).data).toEqual([]);
    expect((await viewingRow(f.viewing)).feedback).toBeNull();
    expect(await eventsSince(mark)).toEqual([]);
    for (const id of [f.mine, f.colleague, f.planted]) expect((await taskRow(id))!.is_done, id).toBe(false);
  });
});

describe("the catalogue: one tenant-bound, validated relationship; the trigger scoped in its own text — RED at 0119", () => {
  it("tasks (org_id, viewing_id) -> viewings (org_id, id), validated, NO ACTION; the single-column key is gone; the referenced unique key and the index exist; 0119's deal key untouched", async () => {
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
        where conrelid = 'public.tasks'::regclass and confrelid = 'public.viewings'::regclass and contype = 'f'`,
    );
    expect(rows).toEqual([
      {
        conname: "tasks_org_viewing_fkey",
        cols: ["org_id", "viewing_id"],
        refcols: ["org_id", "id"],
        convalidated: true,
        confdeltype: "a",
        confupdtype: "a",
      },
    ]);
    const { rows: keys } = await o.query<{ conname: string; contype: string }>(
      `select conname, contype from pg_constraint
        where (conrelid = 'public.viewings'::regclass and conname = 'viewings_org_id_id_key')
           or (conrelid = 'public.tasks'::regclass and conname in ('tasks_viewing_id_fkey', 'tasks_org_deal_fkey'))
        order by 1`,
    );
    expect(keys).toEqual([
      { conname: "tasks_org_deal_fkey", contype: "f" },
      { conname: "viewings_org_id_id_key", contype: "u" },
    ]);
    const { rows: idx } = await o.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'tasks' and indexname = 'tasks_org_viewing_idx'",
    );
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toMatch(/\(org_id, viewing_id\) WHERE \(viewing_id IS NOT NULL\)/);
  });

  it("trg_supersede_viewing_nudges scopes its UPDATE to the viewing's organisation, stays a definer nobody can call, and is still 0020's AFTER UPDATE WHEN trigger", async () => {
    const { rows } = await o.query<{ src: string; secdef: boolean; config: string[]; anon: boolean; auth: boolean }>(
      `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.oid = 'public.trg_supersede_viewing_nudges()'::regprocedure`,
    );
    const code = rows[0]!.src.replace(/--[^\n]*/g, "");
    expect(code).toMatch(/where t\.viewing_id = new\.id\s+and t\.org_id = new\.org_id\s+and t\.kind = 'viewing_feedback'/);
    expect(rows[0]).toMatchObject({ secdef: true, config: ["search_path=public"], anon: false, auth: false });
    const { rows: trg } = await o.query<{ def: string }>(
      "select pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = 'public.viewings'::regclass and tgname = 'viewings_supersede_nudges'",
    );
    expect(trg[0]!.def).toBe(
      "CREATE TRIGGER viewings_supersede_nudges AFTER UPDATE ON public.viewings FOR EACH ROW WHEN (((old.feedback IS DISTINCT FROM new.feedback) OR (old.status IS DISTINCT FROM new.status))) EXECUTE FUNCTION trg_supersede_viewing_nudges()",
    );
  });
});
