import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * 0121: a task belongs to the organisation of the mandate it names, and the
 * two mandate sweeps — `raise_key_recall_tasks` (0091) and `expire_mandates`
 * (0053) — look for, and complete, only the mandate's own organisation's
 * reminders. The mandate twin of 0119 (deals) and 0120 (viewings).
 *
 * THE GAP, as it stood at 0120: `tasks.mandate_id` referenced `mandates(id)`
 * alone (0006) and `tasks_insert` / `tasks_update` check only the caller's
 * organisation, so a member of organisation B who knew an organisation-A
 * mandate id could plant a task of B on it (INSERT, PATCH or UPSERT) although
 * B cannot read the mandate. Then:
 *   * the key-recall raiser's duplicate guard matched `t.mandate_id` alone, so
 *     B's `key_recall` row stopped A's legitimate "Return keys" reminder from
 *     ever being raised;
 *   * its self-heal matched `t.mandate_id = m.id` alone, so once A's keys went
 *     back it completed B's task and wrote a `superseded` event into B's
 *     chain — attributed to A's admin when `setMandateStatus` made the call;
 *   * `expire_mandates` steps 2 and 3 had the same two joins for
 *     `mandate_renewal` (system-attributed): a planted row suppressed A's
 *     renewal reminder, or was completed by the nightly run — which also told
 *     B whether its guessed expiry date was A's.
 * The tests marked "RED at 0120" below failed against 0120's exact catalogue
 * before the migration; the rest pin what must not change.
 *
 * TWO KINDS OF CALLER: supabase-js clients through PostgREST (users, and the
 * service role exactly as `setMandateStatus` calls the raiser —
 * `createAdminClient().rpc(...)`), and one `pg` session as postgres — the role
 * pg_cron runs `expire_mandates()` as — for fixtures, verification, cleanup,
 * the scheduled sweep, and PLANTING the cross-organisation row the constraint
 * now refuses (`session_replication_role = replica`, which skips the
 * referential check the way a row written before a NOT VALID constraint, or
 * loaded by a replica-mode restore, escapes it). The functions' own
 * predicates are what must protect against a row the constraint could not stop.
 *
 * THE SCHEDULED SWEEP runs inside a transaction that is ROLLED BACK: it is
 * global (every organisation on this database), and a committed run would also
 * flip, raise and complete other files' fixtures. Its reads happen on the same
 * connection before the rollback, which sees exactly what the cron's own
 * commit would.
 *
 * TWO THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN = Date.now().toString(36);

let o: Client; // postgres: fixtures, planting, the cron's role, verification, cleanup
let svc: SupabaseClient; // service_role: how setMandateStatus reaches the raiser

let adminA: TestUser;
let agentA: TestUser; // A's properties' agent — the fallback's first arm
let adminB: TestUser;
let agentB: TestUser;
const userIds: string[] = [];
let n = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type Status = "draft" | "active" | "expired" | "terminated";

/** A property of its own for every mandate: one ACTIVE mandate per property (0036). */
async function newMandate(
  org: string,
  opts: {
    status?: Status;
    expiryInDays?: number; // relative to the database's current_date, as the sweep reads it
    agent?: string | null;
    createdBy?: string | null;
  } = {},
) {
  n += 1;
  const { rows: p } = await o.query<{ id: string; reference: string }>(
    `insert into properties (org_id, reference, property_type, assigned_agent_id)
     values ($1, $2, 'apartment', $3) returning id, reference`,
    [org, `TMO${RUN}${n}`.toUpperCase(), opts.agent === undefined ? null : opts.agent],
  );
  const { rows: m } = await o.query<{ id: string }>(
    `insert into mandates (org_id, property_id, status, type, start_date, expiry_date,
                           renewal_reminder_days, created_by)
     values ($1, $2, $3::mandate_status, 'open', current_date - 200, current_date + $4::int, 30, $5)
     returning id`,
    [org, p[0]!.id, opts.status ?? "terminated", opts.expiryInDays ?? -10, opts.createdBy ?? null],
  );
  return { mandate: m[0]!.id, property: p[0]!.id, reference: p[0]!.reference };
}

async function addKey(org: string, property: string, status: "in_office" | "checked_out" | "with_owner" | "lost") {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into property_keys (org_id, property_id, key_code, status)
     values ($1, $2, $3, $4::key_status) returning id`,
    [org, property, `TMO-K${n}`, status],
  );
  return rows[0]!.id;
}

async function returnAllKeys(property: string) {
  await o.query("update property_keys set status = 'with_owner' where property_id = $1", [property]);
}

/** A row as postgres — a fixture, not a probe. */
async function seedTask(t: {
  org: string;
  mandate?: string | null;
  assignee: string;
  kind?: string | null;
  dueSql?: string; // an SQL expression for due_at
}) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into tasks (org_id, title, due_at, assignee_id, created_by, mandate_id, kind)
     values ($1, $2, ${t.dueSql ?? "now() + interval '1 day'"}, $3, $3, $4, $5) returning id`,
    [t.org, `ZZTEST task ${RUN} ${n}`, t.assignee, t.mandate ?? null, t.kind ?? null],
  );
  return rows[0]!.id;
}

/**
 * The row 0121's constraint refuses, written past it: organisation B's task
 * naming organisation A's mandate. `session_replication_role = replica`
 * disables the referential triggers for this transaction only — the SET is
 * permitted to postgres on the pinned local image (CI runs the same one); this
 * file is never pointed at hosted, where postgres is not a superuser. The row
 * is otherwise ordinary and committed.
 */
async function plantCrossOrgTask(
  org: string,
  foreignMandate: string,
  assignee: string,
  kind: "key_recall" | "mandate_renewal",
  dueSql = "now() + interval '1 day'",
) {
  n += 1;
  await o.query("begin");
  try {
    await o.query("set local session_replication_role = replica");
    const { rows } = await o.query<{ id: string }>(
      `insert into tasks (org_id, title, due_at, assignee_id, created_by, mandate_id, kind)
       values ($1, $2, ${dueSql}, $3, $3, $4, $5) returning id`,
      [org, `ZZTEST planted ${RUN} ${n}`, assignee, foreignMandate, kind],
    );
    await o.query("commit");
    return rows[0]!.id;
  } catch (e) {
    await o.query("rollback");
    throw e;
  }
}

type TaskRow = {
  id: string;
  org_id: string;
  mandate_id: string | null;
  property_id: string | null;
  assignee_id: string | null;
  kind: string | null;
  title: string;
  is_done: boolean;
  done_at: Date | null;
};

async function taskRow(id: string) {
  const { rows } = await o.query<TaskRow>(
    "select id, org_id, mandate_id, property_id, assignee_id, kind, title, is_done, done_at from tasks where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

/** Every task naming a mandate, in one organisation, of one kind. */
async function tasksOn(mandate: string, org: string, kind: string) {
  const { rows } = await o.query<TaskRow>(
    `select id, org_id, mandate_id, property_id, assignee_id, kind, title, is_done, done_at
       from tasks where mandate_id = $1 and org_id = $2 and kind = $3 order by created_at, id`,
    [mandate, org, kind],
  );
  return rows;
}

async function eventsMark() {
  const { rows } = await o.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events");
  return rows[0]!.m;
}

type EventRow = {
  id: string;
  org_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
};

/**
 * Events written after `mark` in the given organisation(s) — always one of the
 * two this file owns. Never the whole table: the local stack's own crons write
 * into every organisation on their own schedule.
 */
async function eventsSince(mark: string, orgs: string | string[] = [ORG_A, ORG_B]) {
  const { rows } = await o.query<EventRow>(
    `select id::text, org_id, entity_type, entity_id, event_type, actor_id, payload
       from events where id > $1::bigint and org_id = any($2::uuid[]) order by id`,
    [mark, Array.isArray(orgs) ? orgs : [orgs]],
  );
  return rows;
}

/**
 * Events written after `mark` into `org`'s chain that concern a mandate of
 * ANOTHER organisation — as the entity itself, through the task that is the
 * entity, or through the payload's `mandate_id` — or that carry another
 * organisation's user as actor. The nightly sweep is global and also serves
 * this file's other fixtures (B's own reminders legitimately complete in B's
 * chain), so a sweep test cannot ask for an empty chain; it asks for this to
 * be empty, which is the property under test.
 */
async function foreignWrites(mark: string, org: string) {
  const { rows } = await o.query<EventRow>(
    `select e.id::text, e.org_id, e.entity_type, e.entity_id, e.event_type, e.actor_id, e.payload
       from events e
      where e.id > $1::bigint and e.org_id = $2
        and (exists (select 1 from mandates m
                      where m.org_id <> e.org_id
                        and (   (e.entity_type = 'mandate' and m.id = e.entity_id)
                             or (e.entity_type = 'task'
                                 and m.id = (select t.mandate_id from tasks t where t.id = e.entity_id))
                             or (e.payload->>'mandate_id' ~ '^[0-9a-f-]{36}$'
                                 and m.id = (e.payload->>'mandate_id')::uuid)))
             or exists (select 1 from profiles p where p.id = e.actor_id and p.org_id <> e.org_id))
      order by e.id`,
    [mark, org],
  );
  return rows;
}

/** On the pg connection, so it also reads inside the sweep's open transaction. */
async function chainOk(org: string) {
  const { rows } = await o.query<{ ok: boolean }>("select public.verify_events_chain($1) as ok", [org]);
  return rows[0]!.ok;
}

/** Refuse ONE event type for ONE entity, in the database (committed); returns the remover. */
async function failEvent(entityId: string, eventType: string) {
  n += 1;
  const fn = `zz_tmo_fail_${RUN}_${n}`;
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

/** What setMandateStatus sends after a termination: the service role, the acting admin as p_actor. */
const raiseAsAction = (mandate: string, actor: string) =>
  svc.rpc("raise_key_recall_tasks", { p_mandate: mandate, p_actor: actor });

/**
 * The nightly run, as pg_cron makes it (`select expire_mandates()` as postgres,
 * 03:00 UTC), `times` times in one transaction; `check` reads the result on the
 * same connection; then everything is ROLLED BACK (see the header).
 */
async function inNightlySweep(times: number, check: () => Promise<void>) {
  await o.query("begin");
  try {
    for (let i = 0; i < times; i += 1) await o.query("select public.expire_mandates()");
    await check();
  } finally {
    await o.query("rollback");
  }
}

/** The Cyprus wall clock of a task's due_at, and its distance in Cyprus days from its creation. */
async function dueShape(id: string) {
  const { rows } = await o.query<{ local_time: string; days: number; local_date: string }>(
    `select to_char(due_at at time zone 'Asia/Nicosia', 'HH24:MI:SS') as local_time,
            ((due_at at time zone 'Asia/Nicosia')::date - (created_at at time zone 'Asia/Nicosia')::date) as days,
            to_char((due_at at time zone 'Asia/Nicosia')::date, 'YYYY-MM-DD') as local_date
       from tasks where id = $1`,
    [id],
  );
  return rows[0]!;
}

async function expiryOf(mandate: string) {
  const { rows } = await o.query<{ d: string }>("select to_char(expiry_date, 'YYYY-MM-DD') as d from mandates where id = $1", [
    mandate,
  ]);
  return rows[0]!.d;
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  const { rows: stale } = await o.query<{ tgname: string }>(
    "select tgname from pg_trigger where tgrelid = 'public.events'::regclass and tgname like 'zz_tmo_fail_%'",
  );
  for (const t of stale) {
    await o.query(`drop trigger if exists ${t.tgname} on public.events`);
    await o.query(`drop function if exists public.${t.tgname}()`);
  }

  await ensureTestOrg(svc, ORG_A, `mandate-isolation A ${RUN}`, `mandate-isolation-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `mandate-isolation B ${RUN}`, `mandate-isolation-b-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors ({} messages)
  adminA = await createTestUser(svc, `tmo-admin-a-${RUN}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `tmo-agent-a-${RUN}@test.local`, "agent", ORG_A);
  adminB = await createTestUser(svc, `tmo-admin-b-${RUN}@test.local`, "admin", ORG_B);
  agentB = await createTestUser(svc, `tmo-agent-b-${RUN}@test.local`, "agent", ORG_B);
  userIds.push(adminA.id, agentA.id, adminB.id, agentB.id);
});

afterAll(async () => {
  // every task of BOTH organisations before any mandate: the planted rows name
  // the other organisation's mandate
  for (const org of [ORG_A, ORG_B]) await o.query("delete from tasks where org_id = $1", [org]);
  for (const org of [ORG_A, ORG_B]) {
    await o.query("delete from property_keys where org_id = $1", [org]);
    await o.query("delete from mandates where org_id = $1", [org]);
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
describe("the premise: organisation B cannot read organisation A's mandate", () => {
  it("neither B's admin nor B's agent sees it; A's admin does", async () => {
    const { mandate } = await newMandate(ORG_A, { agent: agentA.id });
    for (const c of [adminB.client, agentB.client]) {
      const r = await c.from("mandates").select("id").eq("id", mandate);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([]);
    }
    const mine = await adminA.client.from("mandates").select("id").eq("id", mandate);
    expect(mine.data).toEqual([{ id: mandate }]);
  });
});

describe("B cannot create, re-point or upsert a task onto A's mandate (23503, nothing written) — RED at 0120", () => {
  const shape = (mandate: string, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    title: `ZZTEST planted by B ${RUN}`,
    mandate_id: mandate,
    ...extra,
  });

  it("INSERT — as B's agent and as B's admin, a key_recall, a mandate_renewal or an ordinary task", async () => {
    const { mandate } = await newMandate(ORG_A, { agent: agentA.id });
    const attempts = [
      { who: "B's agent, key_recall", client: agentB.client, row: shape(mandate, { assignee_id: agentB.id, kind: "key_recall" }) },
      { who: "B's admin, mandate_renewal", client: adminB.client, row: shape(mandate, { assignee_id: adminB.id, kind: "mandate_renewal" }) },
      { who: "B's admin, no kind", client: adminB.client, row: shape(mandate, { assignee_id: adminB.id }) },
    ];
    for (const a of attempts) {
      const r = await a.client.from("tasks").insert(a.row).select("id");
      expect(r.error?.code, a.who).toBe("23503");
      expect(r.data, a.who).toBeNull();
    }
    const { rows } = await o.query("select count(*)::int as c from tasks where mandate_id = $1", [mandate]);
    expect(rows[0]!.c, "no row landed").toBe(0);
  });

  it("UPDATE — a task of B, with or without a mandate of its own, cannot be pointed at A's mandate", async () => {
    const { mandate: mandateA } = await newMandate(ORG_A, { agent: agentA.id });
    const { mandate: mandateB } = await newMandate(ORG_B, { agent: agentB.id });
    const bare = await seedTask({ org: ORG_B, assignee: agentB.id });
    const linked = await seedTask({ org: ORG_B, mandate: mandateB, assignee: agentB.id, kind: "key_recall" });
    for (const [id, who, client] of [
      [bare, "agent, task without a mandate", agentB.client],
      [linked, "agent, task on B's own mandate", agentB.client],
      [linked, "admin, task on B's own mandate", adminB.client],
    ] as const) {
      const r = await client.from("tasks").update({ mandate_id: mandateA }).eq("id", id).select("id");
      expect(r.error?.code, who).toBe("23503");
    }
    expect((await taskRow(bare))!.mandate_id).toBeNull();
    expect((await taskRow(linked))!.mandate_id).toBe(mandateB);
  });

  it("UPSERT — onto an existing task of B (merge) and as a new id: refused, nothing written", async () => {
    const { mandate: mandateA } = await newMandate(ORG_A, { agent: agentA.id });
    const existing = await seedTask({ org: ORG_B, assignee: agentB.id });
    const merge = await agentB.client
      .from("tasks")
      .upsert({ id: existing, ...shape(mandateA, { assignee_id: agentB.id, kind: "key_recall" }) }, { onConflict: "id" })
      .select("id");
    expect(merge.error?.code).toBe("23503");
    expect(await taskRow(existing)).toMatchObject({ mandate_id: null, kind: null, org_id: ORG_B });

    const fresh = randomUUID();
    const insert = await adminB.client
      .from("tasks")
      .upsert({ id: fresh, ...shape(mandateA, { assignee_id: adminB.id, kind: "key_recall" }) }, { onConflict: "id" })
      .select("id");
    expect(insert.error?.code).toBe("23503");
    expect(await taskRow(fresh)).toBeNull();
  });

  it("a task's organisation cannot be moved away from its mandate's — by a user session (RLS) or by the service role (the key)", async () => {
    const { mandate } = await newMandate(ORG_A, { agent: agentA.id });
    const task = await seedTask({ org: ORG_A, mandate, assignee: agentA.id, kind: "key_recall" });
    const user = await adminA.client.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
    expect(user.error?.code).toBe("42501");
    const maintenance = await svc.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
    expect(maintenance.error?.code).toBe("23503");
    expect((await taskRow(task))!.org_id).toBe(ORG_A);
  });

  it("the refusal no longer tells B whether an A mandate id exists", async () => {
    // at 0120 an existing A id answered 201 and a missing id 23503 — an oracle
    const { mandate: real } = await newMandate(ORG_A, { agent: agentA.id });
    const missing = randomUUID();
    const a = await agentB.client.from("tasks").insert(shape(real, { assignee_id: agentB.id })).select("id");
    const b = await agentB.client.from("tasks").insert(shape(missing, { assignee_id: agentB.id })).select("id");
    expect(a.error?.code).toBe("23503");
    expect(b.error?.code).toBe("23503");
    expect(a.error?.message).toBe(b.error?.message);
  });
});

describe("same-organisation links, tasks without a mandate, embeds and deletion stay as they were", () => {
  it("A's agent and admin link tasks to A's mandates; a task without a mandate is fine; re-pointing within A is fine", async () => {
    const { mandate: m1 } = await newMandate(ORG_A, { agent: agentA.id });
    const { mandate: m2 } = await newMandate(ORG_A, { agent: agentA.id });
    const linked = await agentA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST own ${RUN}`, mandate_id: m1, assignee_id: agentA.id, created_by: agentA.id })
      .select("id")
      .single();
    expect(linked.error).toBeNull();
    const byAdmin = await adminA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST admin own ${RUN}`, mandate_id: m2, assignee_id: adminA.id, created_by: adminA.id })
      .select("id")
      .single();
    expect(byAdmin.error).toBeNull();
    const none = await adminA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST no mandate ${RUN}`, assignee_id: adminA.id, created_by: adminA.id })
      .select("id")
      .single();
    expect(none.error).toBeNull();
    expect((await taskRow(none.data!.id))!.mandate_id).toBeNull();

    const moved = await agentA.client.from("tasks").update({ mandate_id: m2 }).eq("id", linked.data!.id).select("id");
    expect(moved.error).toBeNull();
    expect(moved.data).toEqual([{ id: linked.data!.id }]);
    const cleared = await agentA.client.from("tasks").update({ mandate_id: null }).eq("id", linked.data!.id).select("id");
    expect(cleared.error).toBeNull();
    expect((await taskRow(linked.data!.id))!.mandate_id).toBeNull();
  });

  it("PostgREST still resolves the one relationship in both directions (no PGRST201)", async () => {
    const { mandate } = await newMandate(ORG_A, { agent: agentA.id });
    const task = await seedTask({ org: ORG_A, mandate, assignee: agentA.id });
    // untyped clients infer every embed as an array; the shape is asserted here
    const fromTasks = await adminA.client.from("tasks").select("id, mandates(id, status)").eq("id", task).single();
    expect(fromTasks.error).toBeNull();
    expect((fromTasks.data as unknown as { mandates: { id: string; status: string } | null }).mandates).toEqual({
      id: mandate,
      status: "terminated",
    });
    const fromMandates = await adminA.client.from("mandates").select("id, tasks(id)").eq("id", mandate).single();
    expect(fromMandates.error).toBeNull();
    expect((fromMandates.data as unknown as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual([task]);
    // mandates_safe — the view every UI mandate read goes through (doc 04) —
    // exposes (org_id, id), so PostgREST carries the composite relationship onto it
    const viaView = await adminA.client.from("tasks").select("id, mandates_safe(id, status)").eq("id", task).single();
    expect(viaView.error).toBeNull();
    expect((viaView.data as unknown as { mandates_safe: { id: string } | null }).mandates_safe?.id).toBe(mandate);
    const fromView = await adminA.client.from("mandates_safe").select("id, tasks(id)").eq("id", mandate).single();
    expect(fromView.error).toBeNull();
    expect((fromView.data as unknown as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual([task]);
  });

  it("deletion: a mandate with tasks still cannot be deleted, directly or by its property's cascade (NO ACTION, as before); no user session can delete a mandate; the task itself deletes as before", async () => {
    const { mandate, property } = await newMandate(ORG_A, { agent: agentA.id });
    const task = await seedTask({ org: ORG_A, mandate, assignee: adminA.id }); // no property_id: only the mandate key holds it
    // the refusal is the tasks → mandates key's (its name changes with 0121; its rule does not)
    const byTaskKey = { code: "23503", constraint: expect.stringMatching(/^tasks_(org_mandate|mandate_id)_fkey$/) };
    await expect(o.query("delete from mandates where id = $1", [mandate])).rejects.toMatchObject(byTaskKey);
    // properties → mandates is ON DELETE CASCADE (0001); the task's key still refuses the cascaded delete
    await expect(o.query("delete from properties where id = $1", [property])).rejects.toMatchObject(byTaskKey);
    const asAdmin = await adminA.client.from("mandates").delete().eq("id", mandate).select("id");
    expect(asAdmin.error?.code, "no DELETE grant on mandates").toBe("42501");
    expect((await o.query("select count(*)::int as c from mandates where id = $1", [mandate])).rows[0]!.c).toBe(1);

    const gone = await adminA.client.from("tasks").delete().eq("id", task).select("id");
    expect(gone.error).toBeNull();
    expect(gone.data).toEqual([{ id: task }]);
    await o.query("delete from properties where id = $1", [property]);
    expect((await o.query("select count(*)::int as c from mandates where id = $1", [mandate])).rows[0]!.c).toBe(0);
  });
});

describe("the privileged functions stay service-only / cron-only", () => {
  it("anon and authenticated users cannot execute raise_key_recall_tasks; nothing is written", async () => {
    const { mandate, property } = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, property, "checked_out");
    const mark = await eventsMark();
    for (const [who, client] of [
      ["anon", anonClient()],
      ["A's agent", agentA.client],
      ["A's admin", adminA.client],
      ["B's admin", adminB.client],
    ] as const) {
      const r = await client.rpc("raise_key_recall_tasks", { p_mandate: mandate, p_actor: adminA.id });
      expect(r.error?.code, who).toBe("42501");
    }
    expect(await tasksOn(mandate, ORG_A, "key_recall")).toEqual([]);
    expect(await eventsSince(mark)).toEqual([]);
  });

  it("expire_mandates is callable by nobody over PostgREST — not even the service role (0022); pg_cron runs it as postgres", async () => {
    for (const [who, client] of [
      ["anon", anonClient()],
      ["A's admin", adminA.client],
      ["service role", svc],
    ] as const) {
      const r = await client.rpc("expire_mandates");
      expect(r.error?.code, who).toBe("42501");
    }
    const { rows } = await o.query<{ command: string; username: string }>(
      "select command, username from cron.job where jobname = 'expire-mandates'",
    );
    expect(rows).toEqual([{ command: "select expire_mandates()", username: "postgres" }]);
  });
});

describe("key recall at edit time (setMandateStatus's service-role call, the admin as p_actor)", () => {
  it("a legitimate ended mandate with held keys raises ONE reminder in its own organisation, attributed to the admin; a repeat raises none", async () => {
    const { mandate, property, reference } = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, property, "checked_out");
    await addKey(ORG_A, property, "in_office");
    await addKey(ORG_A, property, "with_owner"); // already where it belongs
    await addKey(ORG_A, property, "lost"); // cannot be handed back
    const mark = await eventsMark();

    const r = await raiseAsAction(mandate, adminA.id);
    expect(r.error).toBeNull();
    expect(r.data).toBe(1);
    const [task, ...more] = await tasksOn(mandate, ORG_A, "key_recall");
    expect(more).toEqual([]);
    expect(task).toMatchObject({
      org_id: ORG_A,
      property_id: property,
      assignee_id: agentA.id, // the fallback's first arm: the property's agent
      is_done: false,
      title: `Return keys: ${reference} — 2 keys still held (mandate terminated)`,
    });
    // seven CYPRUS days of grace, to the minute before midnight (0091)
    expect(await dueShape(task!.id)).toMatchObject({ local_time: "23:59:00", days: 7 });

    const events = await eventsSince(mark);
    expect(events.map((e) => [e.org_id, e.entity_type, e.entity_id, e.event_type, e.actor_id])).toEqual([
      [ORG_A, "mandate", mandate, "key_recall_task_created", adminA.id],
    ]);
    expect(events[0]!.payload).toEqual({ task_id: task!.id, assignee_id: agentA.id, property_id: property, keys: 2 });

    const again = await raiseAsAction(mandate, adminA.id);
    expect(again.error).toBeNull();
    expect(again.data).toBe(0);
    expect(await tasksOn(mandate, ORG_A, "key_recall")).toHaveLength(1);
    expect(await eventsSince(mark)).toHaveLength(1);
    expect(await chainOk(ORG_A)).toBe(true);
  });

  it("the assignee fallback is unchanged: no active agent and no creator → the organisation's oldest active admin", async () => {
    const { mandate, property } = await newMandate(ORG_A, { agent: null, createdBy: null });
    await addKey(ORG_A, property, "in_office");
    const r = await raiseAsAction(mandate, adminA.id);
    expect(r.data).toBe(1);
    const { rows } = await o.query<{ id: string }>(
      `select id from profiles where org_id = $1 and role = 'admin' and is_active order by created_at limit 1`,
      [ORG_A],
    );
    expect((await tasksOn(mandate, ORG_A, "key_recall"))[0]!.assignee_id).toBe(rows[0]!.id);
  });

  it("B's planted key_recall row cannot stop A's reminder: A's is raised, B's row and B's chain are untouched — RED at 0120", async () => {
    const { mandate, property } = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, property, "checked_out");
    const planted = await plantCrossOrgTask(ORG_B, mandate, agentB.id, "key_recall");
    const mark = await eventsMark();

    const r = await raiseAsAction(mandate, adminA.id);
    expect(r.error).toBeNull();
    expect(r.data, "A's legitimate reminder is raised despite B's row").toBe(1);
    expect(await tasksOn(mandate, ORG_A, "key_recall")).toHaveLength(1);
    expect(await taskRow(planted)).toMatchObject({ org_id: ORG_B, mandate_id: mandate, is_done: false, done_at: null });
    expect(await eventsSince(mark, ORG_B), "nothing was written into B's chain").toEqual([]);
    expect((await eventsSince(mark, ORG_A)).map((e) => [e.event_type, e.actor_id])).toEqual([
      ["key_recall_task_created", adminA.id],
    ]);
    expect(await chainOk(ORG_A)).toBe(true);
    expect(await chainOk(ORG_B)).toBe(true);
  });

  it("once no key is held, only A's reminder completes — `superseded` in A's chain, actor = A's admin; B's planted row stays open and B's chain empty — RED at 0120", async () => {
    const { mandate, property } = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, property, "checked_out");
    expect((await raiseAsAction(mandate, adminA.id)).data).toBe(1);
    const [mine] = await tasksOn(mandate, ORG_A, "key_recall");
    const planted = await plantCrossOrgTask(ORG_B, mandate, agentB.id, "key_recall");
    // B's own reminder on B's own mandate, keys returned too — a control the
    // edit-time call (p_mandate = A's) must not touch either
    const own = await newMandate(ORG_B, { agent: agentB.id });
    await addKey(ORG_B, own.property, "with_owner");
    const ownB = await seedTask({ org: ORG_B, mandate: own.mandate, assignee: agentB.id, kind: "key_recall" });

    await returnAllKeys(property);
    const mark = await eventsMark();
    const r = await raiseAsAction(mandate, adminA.id);
    expect(r.error).toBeNull();
    expect(r.data).toBe(0);

    expect((await taskRow(mine!.id))!.is_done).toBe(true);
    expect((await taskRow(mine!.id))!.done_at).not.toBeNull();
    const a = await eventsSince(mark, ORG_A);
    expect(a.map((e) => [e.entity_type, e.entity_id, e.event_type, e.actor_id])).toEqual([
      ["task", mine!.id, "superseded", adminA.id],
    ]);
    expect(a[0]!.payload).toEqual({ kind: "key_recall", mandate_id: mandate, reason: "keys_returned" });

    expect(await taskRow(planted), "B's planted row").toMatchObject({ org_id: ORG_B, is_done: false, done_at: null });
    expect(await taskRow(ownB), "B's own reminder").toMatchObject({ is_done: false, done_at: null });
    expect(await eventsSince(mark, ORG_B), "nothing was written into B's chain").toEqual([]);
    expect(await chainOk(ORG_A)).toBe(true);
    expect(await chainOk(ORG_B)).toBe(true);
  });

  it("the action's own renewal supersession (supersedeRenewalTasks, the admin's RLS client) completes A's renewal rows only — B's planted row naming A's mandate is outside its reach", async () => {
    const { mandate } = await newMandate(ORG_A, { status: "active", expiryInDays: 10, agent: agentA.id });
    const mine = await seedTask({ org: ORG_A, mandate, assignee: agentA.id, kind: "mandate_renewal" });
    const recall = await seedTask({ org: ORG_A, mandate, assignee: agentA.id, kind: "key_recall" });
    const planted = await plantCrossOrgTask(ORG_B, mandate, agentB.id, "mandate_renewal");
    // lib/actions/mandates.ts supersedeRenewalTasks: the same filter, as the signed-in admin
    const r = await adminA.client
      .from("tasks")
      .update({ is_done: true, done_at: new Date().toISOString() })
      .eq("mandate_id", mandate)
      .eq("kind", "mandate_renewal")
      .eq("is_done", false)
      .select("id");
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ id: mine }]);
    expect((await taskRow(recall))!.is_done, "a key_recall row is not a renewal").toBe(false);
    expect(await taskRow(planted)).toMatchObject({ org_id: ORG_B, is_done: false, done_at: null });
  });

  it("a refused `key_recall_task_created` event rolls the call's task back (no task, no event); the retry raises it", async () => {
    const { mandate, property } = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, property, "checked_out");
    const mark = await eventsMark();
    const remove = await failEvent(mandate, "key_recall_task_created");
    let refused: Awaited<ReturnType<typeof raiseAsAction>>;
    try {
      refused = await raiseAsAction(mandate, adminA.id);
    } finally {
      await remove();
    }
    expect(refused.error?.message ?? "").toMatch(/injected failure/);
    expect(await tasksOn(mandate, ORG_A, "key_recall"), "the task insert rolled back with the event").toEqual([]);
    expect(await eventsSince(mark)).toEqual([]);

    const retry = await raiseAsAction(mandate, adminA.id);
    expect(retry.error).toBeNull();
    expect(retry.data).toBe(1);
    expect(await chainOk(ORG_A)).toBe(true);
  });

  it("a refused `superseded` event rolls the completion back (task still open, no event); the retry completes it", async () => {
    const { mandate, property } = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, property, "in_office");
    expect((await raiseAsAction(mandate, adminA.id)).data).toBe(1);
    const [mine] = await tasksOn(mandate, ORG_A, "key_recall");
    await returnAllKeys(property);
    const mark = await eventsMark();
    const remove = await failEvent(mine!.id, "superseded");
    let refused: Awaited<ReturnType<typeof raiseAsAction>>;
    try {
      refused = await raiseAsAction(mandate, adminA.id);
    } finally {
      await remove();
    }
    expect(refused.error?.message ?? "").toMatch(/injected failure/);
    expect(await taskRow(mine!.id)).toMatchObject({ is_done: false, done_at: null });
    expect(await eventsSince(mark)).toEqual([]);

    expect((await raiseAsAction(mandate, adminA.id)).error).toBeNull();
    expect((await taskRow(mine!.id))!.is_done).toBe(true);
    expect(await chainOk(ORG_A)).toBe(true);
  });

  it("the server action is NOT one transaction: the termination commits on its own, a failed raise leaves no task, and the nightly run raises it (system-attributed)", async () => {
    const { mandate, property } = await newMandate(ORG_A, { status: "active", expiryInDays: 200, agent: agentA.id });
    await addKey(ORG_A, property, "checked_out");
    // setMandateStatus's own write: the status, as the admin, through RLS — committed here
    const term = await adminA.client.from("mandates").update({ status: "terminated" }).eq("id", mandate).select("id");
    expect(term.error).toBeNull();
    expect(term.data).toEqual([{ id: mandate }]);
    const mark = await eventsMark();
    const remove = await failEvent(mandate, "key_recall_task_created");
    let refused: Awaited<ReturnType<typeof raiseAsAction>>;
    try {
      refused = await raiseAsAction(mandate, adminA.id);
    } finally {
      await remove();
    }
    expect(refused.error?.message ?? "").toMatch(/injected failure/);
    const { rows } = await o.query<{ status: string }>("select status::text from mandates where id = $1", [mandate]);
    expect(rows[0]!.status, "the termination stands: it committed before the call").toBe("terminated");
    expect(await tasksOn(mandate, ORG_A, "key_recall")).toEqual([]);

    await inNightlySweep(1, async () => {
      const raised = await tasksOn(mandate, ORG_A, "key_recall");
      expect(raised).toHaveLength(1);
      const ev = (await eventsSince(mark, ORG_A)).filter((e) => e.entity_id === mandate);
      expect(ev.map((e) => [e.event_type, e.actor_id])).toEqual([["key_recall_task_created", null]]);
    });
  });
});

describe("the nightly run (expire_mandates as pg_cron runs it: every organisation, actor = system)", () => {
  it("raises each organisation's own reminders in one pass, once however often it runs; B's planted rows neither block A's nor get completed; B's chain gets only B's own", async () => {
    // A: two ended mandates, one with keys still held (raise), one with none (a planted B row must not be completed)
    const held = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, held.property, "checked_out");
    const returned = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, returned.property, "with_owner");
    const blocking = await plantCrossOrgTask(ORG_B, held.mandate, agentB.id, "key_recall");
    const completing = await plantCrossOrgTask(ORG_B, returned.mandate, agentB.id, "key_recall");
    // B: its own ended mandate with a key held — the job must serve B too
    const ownB = await newMandate(ORG_B, { agent: agentB.id });
    await addKey(ORG_B, ownB.property, "in_office");
    const mark = await eventsMark();

    await inNightlySweep(2, async () => {
      expect(await tasksOn(held.mandate, ORG_A, "key_recall"), "A's reminder is raised — once").toHaveLength(1);
      expect(await tasksOn(returned.mandate, ORG_A, "key_recall"), "nothing held, nothing raised").toEqual([]);
      expect(await tasksOn(ownB.mandate, ORG_B, "key_recall"), "B's own reminder is raised — once").toHaveLength(1);
      expect(await taskRow(blocking)).toMatchObject({ is_done: false, done_at: null });
      expect(await taskRow(completing)).toMatchObject({ is_done: false, done_at: null });

      const mine = [held.mandate, returned.mandate, blocking, completing, ownB.mandate];
      const a = (await eventsSince(mark, ORG_A)).filter((e) => mine.includes(e.entity_id));
      expect(a.map((e) => [e.entity_id, e.event_type, e.actor_id])).toEqual([
        [held.mandate, "key_recall_task_created", null],
      ]);
      const b = (await eventsSince(mark, ORG_B)).filter((e) => mine.includes(e.entity_id));
      expect(
        b.map((e) => [e.entity_id, e.event_type, e.actor_id]),
        "B's chain holds B's own reminder — never a completion of a row naming A's mandate",
      ).toEqual([[ownB.mandate, "key_recall_task_created", null]]);
      expect(await foreignWrites(mark, ORG_B), "nothing in B's chain concerns A's mandates").toEqual([]);
      expect(await foreignWrites(mark, ORG_A)).toEqual([]);
      expect(await chainOk(ORG_A)).toBe(true);
      expect(await chainOk(ORG_B)).toBe(true);
    });
  });

  it("an active mandate that expires overnight is flipped and its keys chased in the same pass, system-attributed", async () => {
    const m = await newMandate(ORG_A, { status: "active", expiryInDays: -1, agent: agentA.id });
    await addKey(ORG_A, m.property, "checked_out");
    const mark = await eventsMark();
    await inNightlySweep(1, async () => {
      const { rows } = await o.query<{ status: string }>("select status::text from mandates where id = $1", [m.mandate]);
      expect(rows[0]!.status).toBe("expired");
      const [task, ...more] = await tasksOn(m.mandate, ORG_A, "key_recall");
      expect(more).toEqual([]);
      expect(task!.title).toMatch(/— 1 key still held \(mandate expired\)$/);
      const ev = (await eventsSince(mark, ORG_A)).filter((e) => e.entity_id === m.mandate);
      expect(ev.map((e) => [e.event_type, e.actor_id, e.payload])).toEqual([
        ["status_changed", null, { from: "active", to: "expired", expiry_date: expect.any(String) }],
        ["key_recall_task_created", null, { task_id: task!.id, assignee_id: agentA.id, property_id: m.property, keys: 1 }],
      ]);
    });
  });

  it("mandate renewal: A's reminder is raised on the expiry's Cyprus end of day, once, although B planted a renewal row on the same day — RED at 0120", async () => {
    const m = await newMandate(ORG_A, { status: "active", expiryInDays: 10, agent: agentA.id });
    const expiry = await expiryOf(m.mandate);
    // the same Cyprus DAY as A's expiry — the duplicate guard's key
    const planted = await plantCrossOrgTask(
      ORG_B,
      m.mandate,
      agentB.id,
      "mandate_renewal",
      `('${expiry}'::date + time '12:00') at time zone 'Asia/Nicosia'`,
    );
    const mark = await eventsMark();
    await inNightlySweep(2, async () => {
      const [task, ...more] = await tasksOn(m.mandate, ORG_A, "mandate_renewal");
      expect(more, "one reminder however often the job runs").toEqual([]);
      expect(task, "A's renewal reminder exists").toBeDefined();
      expect(task).toMatchObject({ assignee_id: agentA.id, property_id: m.property, is_done: false });
      expect(await dueShape(task!.id)).toMatchObject({ local_time: "23:59:00", local_date: expiry });
      expect(await taskRow(planted)).toMatchObject({ is_done: false, done_at: null });
      const a = (await eventsSince(mark, ORG_A)).filter((e) => e.entity_id === m.mandate);
      expect(a.map((e) => [e.event_type, e.actor_id, e.payload])).toEqual([
        ["renewal_task_created", null, { assignee_id: agentA.id }],
      ]);
      expect(await foreignWrites(mark, ORG_B)).toEqual([]);
    });
  });

  it("mandate renewal: the nightly self-heal completes A's stale reminder only — B's planted row on a different day stays open and B's chain empty (no oracle on A's expiry) — RED at 0120", async () => {
    const m = await newMandate(ORG_A, { status: "active", expiryInDays: 10, agent: agentA.id });
    const expiry = await expiryOf(m.mandate);
    const other = `('${expiry}'::date + 3 + time '12:00') at time zone 'Asia/Nicosia'`;
    // A's own reminder, stale: its expiry moved (the self-heal's legitimate target)
    const stale = await seedTask({ org: ORG_A, mandate: m.mandate, assignee: agentA.id, kind: "mandate_renewal", dueSql: other });
    const planted = await plantCrossOrgTask(ORG_B, m.mandate, agentB.id, "mandate_renewal", other);
    const mark = await eventsMark();
    await inNightlySweep(1, async () => {
      expect((await taskRow(stale))!.is_done, "A's stale reminder completes").toBe(true);
      expect(await taskRow(planted), "B's row is not A's to complete").toMatchObject({ is_done: false, done_at: null });
      const a = (await eventsSince(mark, ORG_A)).filter((e) => [stale, planted].includes(e.entity_id));
      expect(a.map((e) => [e.entity_id, e.event_type, e.actor_id, e.payload])).toEqual([
        [stale, "superseded", null, { mandate_id: m.mandate, reason: "mandate_renewed_or_inactive" }],
      ]);
      expect(await foreignWrites(mark, ORG_B), "B's row was not completed into B's chain").toEqual([]);
    });
  });

  it("the kinds stay distinct: a key_recall row survives the renewal self-heal, and neither kind's guard is satisfied by the other's row", async () => {
    // an ended mandate with keys held and an open RENEWAL row: the recall is still raised
    const ended = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, ended.property, "checked_out");
    await seedTask({ org: ORG_A, mandate: ended.mandate, assignee: agentA.id, kind: "mandate_renewal" });
    // an active mandate in its window with a KEY_RECALL row dated on its expiry: the renewal is still raised
    const active = await newMandate(ORG_A, { status: "active", expiryInDays: 10, agent: agentA.id });
    const expiry = await expiryOf(active.mandate);
    await seedTask({
      org: ORG_A,
      mandate: active.mandate,
      assignee: agentA.id,
      kind: "key_recall",
      dueSql: `('${expiry}'::date + time '12:00') at time zone 'Asia/Nicosia'`,
    });
    // a raised recall on a third, ended mandate (keys still out): the nightly
    // renewal self-heal, which completes every open RENEWAL row whose mandate
    // is not active, must leave it open — the 0053 regression pin, run as the
    // cron runs it (rls.test.ts #37 calls it through the service role, which
    // cannot execute it)
    const survivor = await newMandate(ORG_A, { agent: agentA.id });
    await addKey(ORG_A, survivor.property, "in_office");
    expect((await raiseAsAction(survivor.mandate, adminA.id)).data).toBe(1);
    const [recall] = await tasksOn(survivor.mandate, ORG_A, "key_recall");

    await inNightlySweep(1, async () => {
      expect(await tasksOn(ended.mandate, ORG_A, "key_recall")).toHaveLength(1);
      expect((await tasksOn(active.mandate, ORG_A, "mandate_renewal")).filter((t) => !t.is_done)).toHaveLength(1);
      expect((await taskRow(recall!.id))!.is_done, "expire_mandates() must not complete a key_recall task").toBe(false);
    });
  });
});

describe("the catalogue: one tenant-bound, validated relationship; both sweeps scoped in their own text — RED at 0120", () => {
  it("tasks (org_id, mandate_id) -> mandates (org_id, id), validated, NO ACTION, MATCH SIMPLE; the single-column key is gone; the referenced unique key and the index exist; 0119's and 0120's keys untouched", async () => {
    const { rows } = await o.query<{
      conname: string;
      cols: string[];
      refcols: string[];
      convalidated: boolean;
      confdeltype: string;
      confupdtype: string;
      confmatchtype: string;
    }>(
      // ::text[] — node-pg hands a name[] back as its literal text
      `select conname, convalidated, confdeltype, confupdtype, confmatchtype,
              (select array_agg(a.attname::text order by k.ord) from unnest(conkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = conrelid and a.attnum = k.attnum)::text[] as cols,
              (select array_agg(a.attname::text order by k.ord) from unnest(confkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = confrelid and a.attnum = k.attnum)::text[] as refcols
         from pg_constraint
        where conrelid = 'public.tasks'::regclass and confrelid = 'public.mandates'::regclass and contype = 'f'`,
    );
    expect(rows).toEqual([
      {
        conname: "tasks_org_mandate_fkey",
        cols: ["org_id", "mandate_id"],
        refcols: ["org_id", "id"],
        convalidated: true,
        confdeltype: "a",
        confupdtype: "a",
        confmatchtype: "s",
      },
    ]);
    const { rows: keys } = await o.query<{ conname: string; contype: string; convalidated: boolean }>(
      `select conname, contype, convalidated from pg_constraint
        where (conrelid = 'public.mandates'::regclass and conname = 'mandates_org_id_id_key')
           or (conrelid = 'public.tasks'::regclass
               and conname in ('tasks_mandate_id_fkey', 'tasks_org_deal_fkey', 'tasks_org_viewing_fkey'))
        order by 1`,
    );
    expect(keys).toEqual([
      { conname: "mandates_org_id_id_key", contype: "u", convalidated: true },
      { conname: "tasks_org_deal_fkey", contype: "f", convalidated: true },
      { conname: "tasks_org_viewing_fkey", contype: "f", convalidated: true },
    ]);
    const { rows: idx } = await o.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'tasks' and indexname in ('tasks_org_mandate_idx', 'tasks_mandate_idx')
        order by 1`,
    );
    expect(idx.map((i) => i.indexname)).toEqual(["tasks_mandate_idx", "tasks_org_mandate_idx"]);
    expect(idx[1]!.indexdef).toMatch(/\(org_id, mandate_id\) WHERE \(mandate_id IS NOT NULL\)/);
  });

  it("raise_key_recall_tasks scopes its duplicate guard and its self-heal to the mandate's organisation, and stays a service-only definer", async () => {
    const { rows } = await o.query<{ src: string; secdef: boolean; config: string[]; anon: boolean; auth: boolean; service: boolean }>(
      `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as service
         from pg_proc p where p.oid = 'public.raise_key_recall_tasks(uuid, uuid)'::regprocedure`,
    );
    const code = rows[0]!.src.replace(/--[^\n]*/g, "");
    expect(code).toMatch(/where t\.mandate_id = c\.mandate_id\s+and t\.org_id = c\.org_id\s+and t\.kind = 'key_recall'/);
    expect(code).toMatch(/where t\.mandate_id = m\.id\s+and t\.org_id = m\.org_id\s+and t\.kind = 'key_recall'/);
    expect(code).not.toMatch(/current_org_id/);
    expect(rows[0]).toMatchObject({ secdef: true, config: ["search_path=public"], anon: false, auth: false, service: true });
  });

  it("expire_mandates scopes its renewal guard and its renewal self-heal to the mandate's organisation, and stays callable by nobody but its owner", async () => {
    const { rows } = await o.query<{ src: string; secdef: boolean; config: string[]; anon: boolean; auth: boolean; service: boolean }>(
      `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as service
         from pg_proc p where p.oid = 'public.expire_mandates()'::regprocedure`,
    );
    const code = rows[0]!.src.replace(/--[^\n]*/g, "");
    expect(code).toMatch(/where t\.mandate_id = m\.id\s+and t\.org_id = m\.org_id\s+and t\.kind = 'mandate_renewal'\s+and \(t\.due_at/);
    expect(code).toMatch(/where t\.mandate_id = m\.id\s+and t\.org_id = m\.org_id\s+and t\.kind = 'mandate_renewal'\s+and not t\.is_done/);
    expect(code).toMatch(/select raise_key_recall_tasks\(\);\s*$/);
    expect(code).not.toMatch(/current_org_id/);
    expect(rows[0]).toMatchObject({ secdef: true, config: ["search_path=public"], anon: false, auth: false, service: false });
  });
});
