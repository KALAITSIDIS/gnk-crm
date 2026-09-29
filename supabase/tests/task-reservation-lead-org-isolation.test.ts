import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { K0125, MD5_0124, REVERT_0125_SQL, SIG_0125 as SIG, strip0125 } from "./revert-0125";

/**
 * 0125: a task belongs to the organisation of the reservation, instalment line
 * and lead it names, and the four sweeps that look tasks up by those ids —
 * warn_expiring_reservations, remind_due_installments, raise_lead_sla_tasks
 * (their bodies as 0124 left them) and expire_reservations (0090) — look for,
 * and complete, only the parent's own organisation's tasks. The reservation /
 * instalment / lead twin of 0119–0121 (deals, viewings, mandates).
 *
 * THE GAP, as it stood at 0124 (measured through PostgREST): tasks.
 * reservation_id (0047), installment_id (0051) and lead_id (0098) referenced
 * their parent by id alone, and tasks_insert / tasks_update check only the
 * CALLER's organisation. So a member of B who learned an A id could write a
 * task of B naming A's hold, line or lead (201 — and a missing id answered
 * 23503: an existence oracle). The sweeps then matched tasks by that id alone:
 *   * each duplicate guard counted B's row as A's reminder — A's reservation
 *     and instalment reminders were suppressed for that date, A's lead-SLA
 *     reminder for ever (its guard is "one task per lead, ever");
 *   * each self-heal (and expire_reservations' superseded arm) completed B's
 *     row on A's state and wrote a `superseded` event into B's chain — so B
 *     learned A's hold lapsing or moving (and by planting on several days,
 *     A's exact expiry date), A's line being paid or rescheduled (the event
 *     carries A's line LABEL), A's lead being answered.
 * The tests marked "RED at 0124" failed against 0124's catalogue before the
 * migration; the rest pin what must not change.
 *
 * TWO KINDS OF CALLER, as in 0119–0124: supabase-js through PostgREST (aal2
 * sessions, and the service role), and one `pg` session as postgres — pg_cron's
 * role — for fixtures, verification, cleanup, the sweeps and the migration
 * replays. EVERY SWEEP AND REPLAY RUNS IN ONE TRANSACTION ROLLED BACK after its
 * reads (the sweeps run as the cron runs them: every organisation, p_org
 * null); the cross-organisation task the new keys refuse is planted past them
 * with `session_replication_role = replica` inside it — the way a row written
 * before a NOT VALID constraint, or loaded by a replica-mode restore, escapes
 * a key. That the plant is uncommitted matters only if a body WRONGLY updates
 * it: PostgreSQL then re-checks the key on the update (the row is its own
 * transaction's) and the sweep fails — a missing predicate still fails the
 * test, loudly. This file is never pointed at hosted.
 *
 * TWO THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORGS = [ORG_A, ORG_B];
const RUN = Date.now().toString(36);

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, "..", "migrations", "0125_task_reservation_lead_org_isolation.sql");

let o: Client;
let svc: SupabaseClient;

let adminA: TestUser;
let agentA: TestUser;
let adminB: TestUser;
let agentB: TestUser;
const userIds: string[] = [];
let n = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function newProperty(org: string) {
  n += 1;
  const { rows } = await o.query<{ id: string; reference: string }>(
    `insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id, reference`,
    [org, `TRL${RUN}${n}`.toUpperCase()],
  );
  return rows[0]!;
}

async function newHold(org: string, opts: { status?: string; expiresInHours?: number } = {}) {
  const p = await newProperty(org);
  const { rows } = await o.query<{ id: string }>(
    `insert into reservations (org_id, property_id, status, held_from, expires_at)
     values ($1, $2, $3::reservation_status, now() - interval '2 days', now() + make_interval(hours => $4::int)) returning id`,
    [org, p.id, opts.status ?? "held", opts.expiresInHours ?? 24 * 10],
  );
  return rows[0]!.id;
}

async function newLine(org: string, reservation: string, opts: { sort?: number; dueInDays?: number; label?: string } = {}) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into reservation_installments (org_id, reservation_id, sort_order, label, amount, due_date)
     values ($1, $2, $3, $4, 1000, current_date + $5::int) returning id`,
    [org, reservation, opts.sort ?? n, opts.label ?? `Line ${RUN} ${n}`, opts.dueInDays ?? 3],
  );
  return rows[0]!.id;
}

async function newLead(org: string, opts: { minutesAgo?: number; source?: string } = {}) {
  const { rows } = await o.query<{ id: string }>(
    `insert into leads (org_id, source, status, received_at)
     values ($1, $2::lead_source, 'new', now() - make_interval(mins => $3::int)) returning id`,
    [org, opts.source ?? "website", opts.minutesAgo ?? 120],
  );
  return rows[0]!.id;
}

type TaskSpec = {
  org: string;
  kind: string | null;
  reservation?: string | null;
  installment?: string | null;
  lead?: string | null;
  /** the Cyprus day it is due (end of that day, as the sweeps key it); null = now() */
  dueDate?: string | null;
  assignee?: string | null;
};

/** A task written as postgres. `plant` = past the keys, inside the caller's transaction. */
async function insertTask(t: TaskSpec, plant = false) {
  n += 1;
  const sql = `insert into tasks (org_id, title, due_at, assignee_id, reservation_id, installment_id, lead_id, kind)
               values ($1, $2,
                       case when $3::date is null then now()
                            else ($3::date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia' end,
                       $4, $5, $6, $7, $8)
               returning id`;
  const params = [
    t.org,
    `ZZTEST ${plant ? "planted" : "seeded"} ${RUN} ${n}`,
    t.dueDate ?? null,
    t.assignee ?? null,
    t.reservation ?? null,
    t.installment ?? null,
    t.lead ?? null,
    t.kind,
  ];
  if (!plant) return (await o.query<{ id: string }>(sql, params)).rows[0]!.id;
  await o.query("set local session_replication_role = replica");
  try {
    return (await o.query<{ id: string }>(sql, params)).rows[0]!.id;
  } finally {
    await o.query("set local session_replication_role = origin");
  }
}

async function count(sql: string, params: unknown[] = []) {
  const { rows } = await o.query<{ c: number }>(sql, params);
  return rows[0]!.c;
}

async function row<T>(sql: string, params: unknown[]) {
  const { rows } = await o.query(sql, params);
  return (rows[0] ?? null) as T | null;
}

async function rolledBack(body: () => Promise<void>) {
  await o.query("begin");
  try {
    await body();
  } finally {
    await o.query("rollback");
  }
}

type TaskRow = { id: string; org_id: string; kind: string | null; is_done: boolean };

/** Every task naming the parent, oldest first. */
async function tasksOn(column: "reservation_id" | "installment_id" | "lead_id", id: string) {
  const { rows } = await o.query<TaskRow>(
    `select id, org_id, kind, is_done from tasks where ${column} = $1 order by created_at, id`,
    [id],
  );
  return rows;
}

async function isDone(task: string) {
  return (await row<{ is_done: boolean }>("select is_done from tasks where id = $1", [task]))!.is_done;
}

/** Events in `org`'s chain about any of `tasks` (the self-heals' `superseded`). */
async function eventsAbout(org: string, tasks: string[]) {
  const { rows } = await o.query<{ event_type: string; payload: Record<string, unknown> }>(
    "select event_type, payload from events where org_id = $1 and entity_id = any($2::uuid[]) order by id",
    [org, tasks],
  );
  return rows;
}

async function chainOk(org: string) {
  const { rows } = await o.query<{ ok: boolean }>("select public.verify_events_chain($1) as ok", [org]);
  return rows[0]!.ok;
}

async function holdExpiryDay(hold: string) {
  return (await row<{ d: string }>("select to_char((expires_at at time zone 'Asia/Nicosia')::date, 'YYYY-MM-DD') as d from reservations where id = $1", [hold]))!.d;
}

async function lineDueDay(line: string) {
  return (await row<{ d: string }>("select to_char(due_date, 'YYYY-MM-DD') as d from reservation_installments where id = $1", [line]))!.d;
}

async function plusDays(day: string, k: number) {
  return (await row<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') as d", [day, k]))!.d;
}

async function bodyOf(sig: string) {
  const { rows } = await o.query<{ s: string }>("select replace(prosrc, E'\\r', '') as s from pg_proc where oid = $1::regprocedure", [sig]);
  return rows[0]!.s;
}

async function bodyMd5(sig: string) {
  const { rows } = await o.query<{ m: string }>("select md5(replace(prosrc, E'\\r', '')) as m from pg_proc where oid = $1::regprocedure", [sig]);
  return rows[0]!.m;
}

const md5 = async (s: string) => (await o.query<{ m: string }>("select md5($1) as m", [s])).rows[0]!.m;

/** How many times `k` occurs in `s`. */
const occurrences = (s: string, k: string) => s.split(k).length - 1;

/** The foreign keys from tasks onto the three parents. */
async function taskKeys() {
  const { rows } = await o.query<{ conname: string; def: string; convalidated: boolean }>(
    `select conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint
      where conrelid = 'public.tasks'::regclass and contype = 'f'
        and confrelid in ('public.reservations'::regclass, 'public.reservation_installments'::regclass, 'public.leads'::regclass)
      order by conname collate "C"`,
  );
  return rows;
}

const KEYS_0125 = [
  { conname: "tasks_org_installment_fkey", def: "FOREIGN KEY (org_id, installment_id) REFERENCES reservation_installments(org_id, id) ON DELETE CASCADE", convalidated: true },
  { conname: "tasks_org_lead_fkey", def: "FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id)", convalidated: true },
  { conname: "tasks_org_reservation_fkey", def: "FOREIGN KEY (org_id, reservation_id) REFERENCES reservations(org_id, id) ON DELETE CASCADE", convalidated: true },
];
const KEYS_0124 = [
  { conname: "tasks_installment_id_fkey", def: "FOREIGN KEY (installment_id) REFERENCES reservation_installments(id) ON DELETE CASCADE", convalidated: true },
  { conname: "tasks_lead_id_fkey", def: "FOREIGN KEY (lead_id) REFERENCES leads(id)", convalidated: true },
  { conname: "tasks_reservation_id_fkey", def: "FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE", convalidated: true },
];

/** 0124's catalogue for this file's objects, inside the caller's transaction. */
const revertTo0124 = () => o.query(REVERT_0125_SQL);

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG_A, `task-res-lead A ${RUN}`, `task-res-lead-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `task-res-lead B ${RUN}`, `task-res-lead-b-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors ({} messages)
  adminA = await createTestUser(svc, `trl-admin-a-${RUN}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `trl-agent-a-${RUN}@test.local`, "agent", ORG_A);
  adminB = await createTestUser(svc, `trl-admin-b-${RUN}@test.local`, "admin", ORG_B);
  agentB = await createTestUser(svc, `trl-agent-b-${RUN}@test.local`, "agent", ORG_B);
  userIds.push(adminA.id, agentA.id, adminB.id, agentB.id);
});

afterAll(async () => {
  // every task of both organisations first: at 0124 a task of B could name A's parents
  await o.query("delete from tasks where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from reservation_installments where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from reservations where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from notification_jobs where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from leads where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const org of ORGS) {
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
describe("the premise: organisation B cannot read A's reservation, instalment line or lead", () => {
  it("B's admin and agent see none of them; A's admin does", async () => {
    const hold = await newHold(ORG_A);
    const line = await newLine(ORG_A, hold);
    const lead = await newLead(ORG_A, { source: "phone" });
    for (const c of [adminB.client, agentB.client]) {
      expect((await c.from("reservations").select("id").eq("id", hold)).data).toEqual([]);
      expect((await c.from("reservation_installments").select("id").eq("id", line)).data).toEqual([]);
      expect((await c.from("leads").select("id").eq("id", lead)).data).toEqual([]);
    }
    expect((await adminA.client.from("reservation_installments").select("id").eq("id", line)).data).toEqual([{ id: line }]);
  });
});

const LINKS = [
  { column: "reservation_id", kind: "reservation_expiring", key: "tasks_org_reservation_fkey" },
  { column: "installment_id", kind: "installment_due", key: "tasks_org_installment_fkey" },
  { column: "lead_id", kind: "lead_unanswered", key: "tasks_org_lead_fkey" },
] as const;
type Link = (typeof LINKS)[number];

/** The TaskSpec field for a link. */
function on(link: Link, id: string): Pick<TaskSpec, "reservation" | "installment" | "lead"> {
  if (link.column === "reservation_id") return { reservation: id };
  if (link.column === "installment_id") return { installment: id };
  return { lead: id };
}

/** One A parent of each kind. */
async function aParents() {
  const hold = await newHold(ORG_A);
  const line = await newLine(ORG_A, hold);
  const lead = await newLead(ORG_A, { source: "phone" });
  return { reservation_id: hold, installment_id: line, lead_id: lead } as Record<Link["column"], string>;
}

describe("B cannot create, re-point or upsert a task onto A's hold, line or lead (23503, nothing written) — RED at 0124", () => {
  const shape = (who: TestUser, link: Link, id: string, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    title: `ZZTEST by B ${RUN}`,
    assignee_id: who.id,
    created_by: who.id,
    [link.column]: id,
    ...extra,
  });

  it("INSERT — as B's agent and as B's admin, with the sweep's kind or none", async () => {
    const a = await aParents();
    for (const link of LINKS) {
      for (const [who, extra] of [
        [agentB, { kind: link.kind }],
        [adminB, {}],
      ] as const) {
        const r = await who.client.from("tasks").insert(shape(who, link, a[link.column], extra)).select("id");
        expect(r.error?.code, `${who.email} ${link.column}`).toBe("23503");
        expect(r.data).toBeNull();
      }
      expect(await count(`select count(*)::int as c from tasks where ${link.column} = $1`, [a[link.column]]), link.column).toBe(0);
    }
  });

  it("UPDATE — a task of B, bare or on B's own parent, cannot be pointed at A's", async () => {
    const a = await aParents();
    const bHold = await newHold(ORG_B);
    for (const link of LINKS) {
      const bare = await insertTask({ org: ORG_B, kind: null, assignee: agentB.id });
      const linked = await insertTask({ org: ORG_B, kind: null, assignee: agentB.id, reservation: bHold });
      for (const [id, who] of [
        [bare, agentB],
        [linked, adminB],
      ] as const) {
        const r = await who.client.from("tasks").update({ [link.column]: a[link.column] }).eq("id", id).select("id");
        expect(r.error?.code, `${who.email} ${link.column}`).toBe("23503");
      }
      expect(await count(`select count(*)::int as c from tasks where ${link.column} = $1`, [a[link.column]]), link.column).toBe(0);
    }
  });

  it("UPSERT — onto an existing task of B (merge) and as a new id: refused, nothing written", async () => {
    const a = await aParents();
    for (const link of LINKS) {
      const existing = await insertTask({ org: ORG_B, kind: null, assignee: agentB.id });
      const merge = await agentB.client
        .from("tasks")
        .upsert({ id: existing, ...shape(agentB, link, a[link.column], { kind: link.kind }) }, { onConflict: "id" })
        .select("id");
      expect(merge.error?.code, link.column).toBe("23503");
      const fresh = randomUUID();
      const ins = await adminB.client
        .from("tasks")
        .upsert({ id: fresh, ...shape(adminB, link, a[link.column]) }, { onConflict: "id" })
        .select("id");
      expect(ins.error?.code, link.column).toBe("23503");
      expect(await row("select id from tasks where id = $1", [fresh])).toBeNull();
      expect(await row<{ v: string | null }>(`select ${link.column} as v from tasks where id = $1`, [existing])).toEqual({ v: null });
    }
  });

  it("the refusal no longer tells B whether an A id exists, and carries nothing of A's", async () => {
    const a = await aParents();
    for (const link of LINKS) {
      const missing = randomUUID();
      const real = await agentB.client.from("tasks").insert(shape(agentB, link, a[link.column])).select("id");
      const none = await agentB.client.from("tasks").insert(shape(agentB, link, missing)).select("id");
      expect(real.error?.code, `${link.column}: an existing A id`).toBe("23503");
      expect(none.error?.code, `${link.column}: a missing id`).toBe("23503");
      expect(real.error?.message).toBe(none.error?.message);
      expect((real.error?.details ?? "").replace(a[link.column], "<id>")).toBe((none.error?.details ?? "").replace(missing, "<id>"));
      expect(JSON.stringify(real.error)).not.toContain(ORG_A);
    }
  });

  it("a task's organisation cannot move off its parent's — by a user session (RLS) or by the service role (the key)", async () => {
    const a = await aParents();
    for (const link of LINKS) {
      const task = await insertTask({ org: ORG_A, kind: link.kind, assignee: adminA.id, ...on(link, a[link.column]) });
      const user = await adminA.client.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
      expect(user.error?.code, link.column).toBe("42501");
      const maintenance = await svc.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
      expect(maintenance.error?.code, link.column).toBe("23503");
      expect((await row<{ org_id: string }>("select org_id from tasks where id = $1", [task]))!.org_id).toBe(ORG_A);
    }
  });

  it("the service role and the table owner are refused too (the keys bind every writer)", async () => {
    const a = await aParents();
    for (const link of LINKS) {
      const s = await svc.from("tasks").insert({ org_id: ORG_B, title: `ZZTEST svc ${RUN}`, [link.column]: a[link.column] }).select("id");
      expect(s.error?.code, link.column).toBe("23503");
      await expect(
        insertTask({ org: ORG_B, kind: link.kind, ...on(link, a[link.column]) }),
      ).rejects.toMatchObject({ code: "23503", constraint: link.key });
    }
  });
});

describe("same-organisation links, embeds and deletion stay as they were", () => {
  it("A's agent and admin link tasks to A's hold, line and lead; re-point within A; clear; a task with none is fine", async () => {
    const a1 = await aParents();
    const a2 = await aParents();
    for (const link of LINKS) {
      const mine = await agentA.client
        .from("tasks")
        .insert({ org_id: ORG_A, title: `ZZTEST own ${RUN}`, assignee_id: agentA.id, created_by: agentA.id, [link.column]: a1[link.column] })
        .select("id")
        .single();
      expect(mine.error, link.column).toBeNull();
      const moved = await adminA.client.from("tasks").update({ [link.column]: a2[link.column] }).eq("id", mine.data!.id).select("id");
      expect(moved.error, link.column).toBeNull();
      expect(moved.data).toEqual([{ id: mine.data!.id }]);
      const cleared = await agentA.client.from("tasks").update({ [link.column]: null }).eq("id", mine.data!.id).select("id");
      expect(cleared.error, link.column).toBeNull();
    }
    const none = await adminA.client.from("tasks").insert({ org_id: ORG_A, title: `ZZTEST none ${RUN}`, assignee_id: adminA.id }).select("id").single();
    expect(none.error).toBeNull();
  });

  it("the two app writers' shapes are accepted: transitionReservation's follow-up (the caller's session) and raiseLiveHoldCheck's prompt (the service role)", async () => {
    const hold = await newHold(ORG_A);
    // lib/actions/reservations.ts — on `converted`, as A's admin
    const followUp = await adminA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST follow-up ${RUN}`, assignee_id: adminA.id, created_by: adminA.id, property_id: null, deal_id: null, reservation_id: hold })
      .select("id");
    expect(followUp.error).toBeNull();
    // lib/services/followup-tasks.ts — the admin client, org_id and the live hold read together
    const prompt = await svc
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST live hold ${RUN}`, assignee_id: adminA.id, reservation_id: hold, kind: "reservation_still_live" })
      .select("id");
    expect(prompt.error).toBeNull();
  });

  it("PostgREST resolves ONE relationship each way (no PGRST201)", async () => {
    const a = await aParents();
    const task = await insertTask({ org: ORG_A, kind: null, assignee: adminA.id, reservation: a.reservation_id, installment: a.installment_id, lead: a.lead_id });
    const fromTask = await adminA.client
      .from("tasks")
      .select("id, reservations(id), reservation_installments(id), leads(id)")
      .eq("id", task)
      .single();
    expect(fromTask.error).toBeNull();
    const t = fromTask.data as unknown as { reservations: { id: string }; reservation_installments: { id: string }; leads: { id: string } };
    expect([t.reservations.id, t.reservation_installments.id, t.leads.id]).toEqual([a.reservation_id, a.installment_id, a.lead_id]);
    for (const [table, id] of [
      ["reservations", a.reservation_id],
      ["reservation_installments", a.installment_id],
      ["leads", a.lead_id],
    ] as const) {
      const back = await adminA.client.from(table).select("id, tasks(id)").eq("id", id).single();
      expect(back.error, table).toBeNull();
      expect((back.data as unknown as { tasks: { id: string }[] }).tasks.map((x) => x.id), table).toEqual([task]);
    }
  });

  it("deletion: a reservation takes its tasks and its lines' tasks with it (CASCADE); clearSchedule's delete takes the line's task; a lead with a task cannot be deleted (NO ACTION)", async () => {
    const hold = await newHold(ORG_A);
    const line = await newLine(ORG_A, hold);
    const onHold = await insertTask({ org: ORG_A, kind: "reservation_expiring", reservation: hold });
    const onLine = await insertTask({ org: ORG_A, kind: "installment_due", reservation: hold, installment: line });
    await o.query("delete from reservations where id = $1", [hold]);
    expect(await count("select count(*)::int as c from tasks where id = any($1::uuid[])", [[onHold, onLine]])).toBe(0);

    const hold2 = await newHold(ORG_A);
    const line2 = await newLine(ORG_A, hold2);
    const onLine2 = await insertTask({ org: ORG_A, kind: "installment_due", installment: line2 });
    // lib/actions/reservation-schedule.ts clearSchedule, as A's admin
    const cleared = await adminA.client.from("reservation_installments").delete({ count: "exact" }).eq("reservation_id", hold2);
    expect(cleared.error).toBeNull();
    expect(cleared.count).toBe(1);
    expect(await row("select id from tasks where id = $1", [onLine2])).toBeNull();

    const lead = await newLead(ORG_A, { source: "phone" });
    await insertTask({ org: ORG_A, kind: "lead_unanswered", lead });
    await expect(o.query("delete from leads where id = $1", [lead])).rejects.toMatchObject({
      code: "23503",
      constraint: expect.stringMatching(/^tasks_(org_lead|lead_id)_fkey$/),
    });
  });
});

describe("the sweeps look for, and complete, only the parent's own organisation's tasks (B's rows planted past the keys, rolled back) — RED at 0124", () => {
  it("warn_expiring_reservations' guard: B's row on A's hold, dated A's expiry day, no longer stands in for A's reminder", async () => {
    await rolledBack(async () => {
      const hold = await newHold(ORG_A, { expiresInHours: 24 });
      const day = await holdExpiryDay(hold);
      const plant = await insertTask({ org: ORG_B, kind: "reservation_expiring", reservation: hold, dueDate: day }, true);
      await o.query("select public.warn_expiring_reservations()");
      await o.query("select public.warn_expiring_reservations()");
      const onHold = await tasksOn("reservation_id", hold);
      expect(onHold.filter((t) => t.org_id === ORG_A).map((t) => [t.kind, t.is_done]), "A's own reminder, once").toEqual([["reservation_expiring", false]]);
      expect(await isDone(plant)).toBe(false);
      expect(await eventsAbout(ORG_B, [plant])).toEqual([]);
      expect(await chainOk(ORG_A)).toBe(true);
    });
  });

  it("warn_expiring_reservations' self-heal: B's rows on A's hold, dated around it, stay open — no oracle on A's expiry day; A's own stale reminder still completes", async () => {
    await rolledBack(async () => {
      const hold = await newHold(ORG_A, { expiresInHours: 24 });
      const day = await holdExpiryDay(hold);
      const stale = await insertTask({ org: ORG_A, kind: "reservation_expiring", reservation: hold, dueDate: await plusDays(day, 4) });
      const plants = [
        await insertTask({ org: ORG_B, kind: "reservation_expiring", reservation: hold, dueDate: day }, true),
        await insertTask({ org: ORG_B, kind: "reservation_expiring", reservation: hold, dueDate: await plusDays(day, 1) }, true),
        await insertTask({ org: ORG_B, kind: "reservation_expiring", reservation: hold, dueDate: await plusDays(day, -1) }, true),
      ];
      await o.query("select public.warn_expiring_reservations()");
      for (const p of plants) expect(await isDone(p), "B's row is not completed by A's hold").toBe(false);
      expect(await eventsAbout(ORG_B, plants)).toEqual([]);
      expect(await isDone(stale), "A's own stale reminder (the positive control)").toBe(true);
      expect((await eventsAbout(ORG_A, [stale])).map((e) => [e.event_type, e.payload.reason])).toEqual([["superseded", "reservation_extended"]]);
      expect(await chainOk(ORG_A)).toBe(true);
      expect(await chainOk(ORG_B)).toBe(true);
    });
  });

  it("remind_due_installments' guard: B's row on A's line, dated its due day, no longer stands in for A's reminder", async () => {
    await rolledBack(async () => {
      const hold = await newHold(ORG_A);
      const line = await newLine(ORG_A, hold, { dueInDays: 2 });
      const plant = await insertTask({ org: ORG_B, kind: "installment_due", installment: line, dueDate: await lineDueDay(line) }, true);
      await o.query("select public.remind_due_installments()");
      await o.query("select public.remind_due_installments()");
      const onLine = await tasksOn("installment_id", line);
      expect(onLine.filter((t) => t.org_id === ORG_A).map((t) => [t.kind, t.is_done]), "A's own reminder, once").toEqual([["installment_due", false]]);
      expect(await isDone(plant)).toBe(false);
      expect(await eventsAbout(ORG_B, [plant])).toEqual([]);
    });
  });

  it("remind_due_installments' self-heal: A's line being paid no longer completes B's row, nor writes A's line label into B's chain; A's own reminder still completes", async () => {
    await rolledBack(async () => {
      const hold = await newHold(ORG_A);
      const label = `A-secret-label ${RUN}`;
      const line = await newLine(ORG_A, hold, { dueInDays: 2, label });
      const day = await lineDueDay(line);
      const mine = await insertTask({ org: ORG_A, kind: "installment_due", reservation: hold, installment: line, dueDate: day });
      const plant = await insertTask({ org: ORG_B, kind: "installment_due", installment: line, dueDate: day }, true);
      await o.query("update reservation_installments set paid_at = now(), paid_amount = amount where id = $1", [line]);
      await o.query("select public.remind_due_installments()");
      expect(await isDone(plant), "B's row is not completed by A's payment").toBe(false);
      expect(await eventsAbout(ORG_B, [plant])).toEqual([]);
      expect(await count("select count(*)::int as c from events where org_id = $1 and payload::text like '%' || $2 || '%'", [ORG_B, label])).toBe(0);
      expect(await isDone(mine), "A's own reminder (the positive control)").toBe(true);
      expect((await eventsAbout(ORG_A, [mine])).map((e) => [e.event_type, e.payload.reason, e.payload.label])).toEqual([["superseded", "installment_paid", label]]);
      expect(await chainOk(ORG_B)).toBe(true);
    });
  });

  it("raise_lead_sla_tasks' guard: B's row on A's lead no longer stops A's lead from EVER being chased", async () => {
    await rolledBack(async () => {
      const lead = await newLead(ORG_A, { minutesAgo: 120 });
      const plant = await insertTask({ org: ORG_B, kind: "lead_unanswered", lead }, true);
      await o.query("select public.raise_lead_sla_tasks(null, 60)");
      await o.query("select public.raise_lead_sla_tasks(null, 60)");
      const onLead = await tasksOn("lead_id", lead);
      expect(onLead.filter((t) => t.org_id === ORG_A).map((t) => [t.kind, t.is_done]), "A's own SLA task, once").toEqual([["lead_unanswered", false]]);
      expect(await isDone(plant)).toBe(false);
    });
  });

  it("raise_lead_sla_tasks' self-heal: A's lead being answered no longer completes B's row (no oracle on A's first response); A's own task still completes", async () => {
    await rolledBack(async () => {
      const lead = await newLead(ORG_A, { minutesAgo: 120 });
      const mine = await insertTask({ org: ORG_A, kind: "lead_unanswered", lead });
      const plant = await insertTask({ org: ORG_B, kind: "lead_unanswered", lead }, true);
      await o.query("update leads set first_response_at = now() where id = $1", [lead]);
      await o.query("select public.raise_lead_sla_tasks(null, 60)");
      expect(await isDone(plant), "B's row is not completed by A's answer").toBe(false);
      expect(await eventsAbout(ORG_B, [plant])).toEqual([]);
      expect(await isDone(mine), "A's own task (the positive control)").toBe(true);
      expect((await eventsAbout(ORG_A, [mine])).map((e) => [e.event_type, e.payload.reason])).toEqual([["superseded", "lead_answered_or_closed"]]);
      expect(await chainOk(ORG_B)).toBe(true);
    });
  });

  it("expire_reservations' superseded arm: A's hold lapsing no longer completes B's row on it (no oracle on A's hold); A's own prompt still completes", async () => {
    await rolledBack(async () => {
      const hold = await newHold(ORG_A, { expiresInHours: -1 });
      const mine = await insertTask({ org: ORG_A, kind: "reservation_still_live", reservation: hold });
      const plant = await insertTask({ org: ORG_B, kind: "reservation_still_live", reservation: hold }, true);
      await o.query("select public.expire_reservations()");
      expect((await row<{ status: string }>("select status::text from reservations where id = $1", [hold]))!.status).toBe("expired");
      expect(await isDone(plant), "B's row is not completed by A's hold lapsing").toBe(false);
      expect(await eventsAbout(ORG_B, [plant])).toEqual([]);
      expect(await isDone(mine), "A's own prompt (the positive control)").toBe(true);
      expect((await eventsAbout(ORG_A, [mine])).map((e) => [e.event_type, e.payload.kind])).toEqual([["superseded", "reservation_still_live"]]);
      expect(await chainOk(ORG_A)).toBe(true);
      expect(await chainOk(ORG_B)).toBe(true);
    });
  });
});

describe("the catalogue: three tenant-bound, validated relationships; the four sweeps scoped in their own text — RED at 0124", () => {
  it("each link is ONE composite key (validated, its delete rule kept), the old keys gone; the referenced key and the indexes exist; the earlier tenant keys untouched", async () => {
    expect(await taskKeys()).toEqual(KEYS_0125);
    const { rows: k } = await o.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'reservation_installments_org_id_id_key' and contype = 'u'",
    );
    expect(k.map((x) => x.def)).toEqual(["UNIQUE (org_id, id)"]);
    const { rows: idx } = await o.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public'
          and indexname in ('tasks_org_reservation_idx', 'tasks_org_installment_idx', 'tasks_org_lead_idx')
        order by indexname collate "C"`,
    );
    expect(idx.map((i) => i.indexdef)).toEqual([
      "CREATE INDEX tasks_org_installment_idx ON public.tasks USING btree (org_id, installment_id) WHERE (installment_id IS NOT NULL)",
      "CREATE INDEX tasks_org_lead_idx ON public.tasks USING btree (org_id, lead_id) WHERE (lead_id IS NOT NULL)",
      "CREATE INDEX tasks_org_reservation_idx ON public.tasks USING btree (org_id, reservation_id) WHERE (reservation_id IS NOT NULL)",
    ]);
    expect(
      await count(
        `select count(*)::int as c from pg_constraint where convalidated and conname in
           ('tasks_org_deal_fkey', 'tasks_org_viewing_fkey', 'tasks_org_mandate_fkey', 'reservations_org_id_id_key',
            'reservations_org_property_fkey', 'reservation_installments_org_reservation_fkey', 'leads_org_property_fkey', 'leads_org_id_id_key')`,
      ),
    ).toBe(8);
    // no unique index on tasks may answer (23505) before a key does
    expect(await count("select count(*)::int as c from pg_index where indrelid = 'public.tasks'::regclass and indisunique and not indisprimary")).toBe(0);
  });

  it("the four sweeps scope their task guards and self-heals to the parent's organisation; nothing else moved; definer, search_path, volatility and ACLs kept", async () => {
    const code = async (sig: string) => (await bodyOf(sig)).replace(/--[^\n]*/g, "");
    const warn = await code(SIG.warn);
    expect(warn).toMatch(/select 1 from tasks t\s+where t\.reservation_id = d\.id\s+and t\.org_id = d\.org_id\s+and t\.kind = 'reservation_expiring'/);
    expect(warn).toMatch(/from reservations r\s+where t\.reservation_id = r\.id\s+and t\.org_id = r\.org_id\s+and t\.kind = 'reservation_expiring'/);
    const remind = await code(SIG.remind);
    expect(remind).toMatch(/select 1 from tasks t\s+where t\.installment_id = d\.id\s+and t\.org_id = d\.org_id\s+and t\.kind = 'installment_due'/);
    expect(remind).toMatch(/where t\.installment_id = i\.id\s+and t\.org_id = i\.org_id\s+and t\.kind = 'installment_due'/);
    const sla = await code(SIG.sla);
    expect(sla).toMatch(/select 1 from tasks t where t\.lead_id = l\.id and t\.org_id = l\.org_id and t\.kind = 'lead_unanswered'\)/);
    expect(sla).toMatch(/from leads l\s+where t\.lead_id = l\.id\s+and t\.org_id = l\.org_id\s+and t\.kind = 'lead_unanswered'/);
    const expire = await code(SIG.expire);
    expect(expire).toMatch(/from expired e\s+where t\.reservation_id = e\.id\s+and t\.org_id = e\.org_id\s+and t\.kind = 'reservation_still_live'/);
    // each added line exactly where it belongs, and nowhere else
    const raw = { warn: await bodyOf(SIG.warn), remind: await bodyOf(SIG.remind), sla: await bodyOf(SIG.sla), expire: await bodyOf(SIG.expire) };
    expect([occurrences(raw.warn, K0125.guard), occurrences(raw.warn, K0125.warnHeal)]).toEqual([1, 1]);
    expect([occurrences(raw.remind, K0125.guard), occurrences(raw.remind, K0125.remindHeal)]).toEqual([1, 1]);
    expect([occurrences(raw.sla, K0125.slaGuardNew), occurrences(raw.sla, K0125.slaHeal)]).toEqual([1, 1]);
    expect(occurrences(raw.expire, K0125.expireHeal)).toBe(1);
    for (const [k, sig] of Object.entries(SIG) as [keyof typeof SIG, string][]) {
      expect(await md5(strip0125(await bodyOf(sig))), `${k}: 0124's / 0090's body plus exactly 0125's lines`).toBe(MD5_0124[k]);
      // every organisation in one run: row by row, never the session's
      expect(await bodyOf(sig), k).not.toMatch(/current_org_id\(\)/);
    }
    // 0089 / 0090: expire_reservations must never learn about properties (the declined coupling)
    const def = (await o.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [SIG.expire])).rows[0]!.d;
    expect(def).not.toMatch(/\bproperties\b/i);
    const { rows } = await o.query<{ p: string; secdef: boolean; vol: string; config: string[]; anon: boolean; auth: boolean; svc: boolean; comment: string }>(
      `select p.oid::regprocedure::text as p, p.prosecdef as secdef, p.provolatile::text as vol, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              obj_description(p.oid, 'pg_proc') as comment
         from pg_proc p where p.oid = any($1::regprocedure[]) order by p.oid::regprocedure::text collate "C"`,
      [Object.values(SIG)],
    );
    expect(rows.map((r) => ({ p: r.p, secdef: r.secdef, vol: r.vol, config: r.config, anon: r.anon, auth: r.auth, svc: r.svc }))).toEqual([
      { p: "expire_reservations()", secdef: true, vol: "v", config: ["search_path=public"], anon: false, auth: false, svc: true },
      { p: "raise_lead_sla_tasks(uuid,integer)", secdef: true, vol: "v", config: ["search_path=public"], anon: false, auth: false, svc: true },
      { p: "remind_due_installments(uuid)", secdef: true, vol: "v", config: ["search_path=public"], anon: false, auth: false, svc: true },
      { p: "warn_expiring_reservations(uuid)", secdef: true, vol: "v", config: ["search_path=public"], anon: false, auth: false, svc: true },
    ]);
    for (const r of rows) expect(r.comment, r.p).toContain(" Since 0125");
  });
});

describe("the migration file: upgrade from 0124, refusal over existing mismatches or a changed body, re-run, concurrent writers", () => {
  const file = () => readFileSync(MIGRATION, "utf8");

  it("applies over 0124's catalogue and this database's accumulated data: the keys validate, the probes run, each body is the old one plus 0125's lines", async () => {
    const notices: string[] = [];
    const listen = (msg: { message?: string }) => notices.push(msg.message ?? "");
    o.on("notice", listen);
    try {
      await rolledBack(async () => {
        await revertTo0124();
        expect(await taskKeys()).toEqual(KEYS_0124);
        for (const [k, sig] of Object.entries(SIG) as [keyof typeof SIG, string][]) expect(await bodyMd5(sig), k).toBe(MD5_0124[k]);
        expect(await count("select count(*)::int as c from pg_proc where oid = any($1::regprocedure[]) and obj_description(oid, 'pg_proc') like '%0125%'", [Object.values(SIG)])).toBe(0);
        await o.query(file());
        expect(await taskKeys()).toEqual(KEYS_0125);
        for (const [k, sig] of Object.entries(SIG) as [keyof typeof SIG, string][]) expect(await md5(strip0125(await bodyOf(sig))), k).toBe(MD5_0124[k]);
      });
    } finally {
      o.off("notice", listen);
    }
    expect(notices.some((x) => x.startsWith("0125: preflight passed"))).toBe(true);
    expect(notices.some((x) => x.startsWith("0125: probes refused by their keys: {reservation,installment,lead}"))).toBe(true);
  });

  // The message is the proof: the PREFLIGHT refused (with all three counts),
  // so it ran before the key additions, which would otherwise have failed
  // 23503 on these rows.
  it("refuses over existing mismatches in its preflight, with all three counts, and changes nothing", async () => {
    await rolledBack(async () => {
      await revertTo0124();
      const a = await aParents();
      const planted = [
        await insertTask({ org: ORG_B, kind: "reservation_expiring", reservation: a.reservation_id }),
        await insertTask({ org: ORG_B, kind: "installment_due", installment: a.installment_id }),
        await insertTask({ org: ORG_B, kind: "lead_unanswered", lead: a.lead_id }),
      ];
      await o.query("savepoint before_0125");
      await expect(o.query(file())).rejects.toThrow(
        /^0125 aborted: 1 task\(s\) name a reservation of another organisation, 1 task\(s\) name an instalment line of another organisation, 1 task\(s\) name a lead of another organisation — nothing was changed/,
      );
      await o.query("rollback to savepoint before_0125");
      expect(await taskKeys()).toEqual(KEYS_0124);
      expect(await count("select count(*)::int as c from tasks where id = any($1::uuid[]) and org_id = $2", [planted, ORG_B])).toBe(3);
    });
  });

  it("refuses over a single mismatch on ANY one of the three links (each count gates the file on its own)", async () => {
    const expected = {
      reservation_id: "1 task\\(s\\) name a reservation of another organisation, 0 task\\(s\\) name an instalment line of another organisation, 0 task\\(s\\) name a lead",
      installment_id: "0 task\\(s\\) name a reservation of another organisation, 1 task\\(s\\) name an instalment line of another organisation, 0 task\\(s\\) name a lead",
      lead_id: "0 task\\(s\\) name a reservation of another organisation, 0 task\\(s\\) name an instalment line of another organisation, 1 task\\(s\\) name a lead",
    };
    for (const link of LINKS) {
      await rolledBack(async () => {
        await revertTo0124();
        const a = await aParents();
        await insertTask({ org: ORG_B, kind: link.kind, ...on(link, a[link.column]) });
        await o.query("savepoint before_0125");
        await expect(o.query(file()), link.column).rejects.toThrow(new RegExp(`^0125 aborted: ${expected[link.column]}`));
        await o.query("rollback to savepoint before_0125");
      });
    }
  });

  // One hand edit per function, as a hotfix typed into an SQL editor would
  // be: each must be refused by name — not just the first the loop checks.
  const TAMPER: { name: string; sig: string; from: string; to: string }[] = [
    { name: "warn_expiring_reservations", sig: SIG.warn, from: "'Reservation on '", to: "'Hold on '" },
    { name: "remind_due_installments", sig: SIG.remind, from: "'Instalment \"'", to: "'Line \"'" },
    { name: "raise_lead_sla_tasks", sig: SIG.sla, from: "'Website enquiry unanswered for over an hour'", to: "'Web enquiry unanswered'" },
    { name: "expire_reservations", sig: SIG.expire, from: "'expired automatically'", to: "'expired'" },
  ];
  for (const t of TAMPER) {
    it(`refuses before any DDL when ${t.name}'s body is not the one it restates (an unrecorded change is not overwritten)`, async () => {
      await rolledBack(async () => {
        await revertTo0124();
        const def = (await o.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [t.sig])).rows[0]!.d;
        expect(def.split(t.from).length - 1, `the tamper point exists once in ${t.name}`).toBe(1);
        await o.query(def.replace(t.from, t.to));
        const tampered = await bodyMd5(t.sig);
        expect(tampered).not.toBe(MD5_0124[(Object.keys(SIG) as (keyof typeof SIG)[]).find((k) => SIG[k] === t.sig)!]);
        await o.query("savepoint before_0125");
        await expect(o.query(file())).rejects.toThrow(
          new RegExp(`^0125 aborted: ${t.name} is not the body 0125 expects on this database \\(md5 ${tampered}\\) — nothing was changed`),
        );
        await o.query("rollback to savepoint before_0125");
      });
    });
  }

  it("refuses before any DDL when a function's attributes drifted (an extra EXECUTE grant) — CREATE OR REPLACE and the grants would reset them silently", async () => {
    await rolledBack(async () => {
      await revertTo0124();
      await o.query("grant execute on function public.expire_reservations() to authenticated");
      await o.query("savepoint before_0125");
      await expect(o.query(file())).rejects.toThrow(
        /^0125 aborted: expire_reservations's attributes \(SECURITY DEFINER, search_path, volatility or EXECUTE grants\) are not the ones 0125 expects on this database — nothing was changed/,
      );
      await o.query("rollback to savepoint before_0125");
    });
  });

  it("run a second time, it stops in its preflight (the bodies are no longer the old ones)", async () => {
    await rolledBack(async () => {
      await expect(o.query(file())).rejects.toThrow(/^0125 aborted: \w+ is not the body 0125 expects on this database/);
    });
  });

  // What the spy sees while the file is blocked is the proof that the LOCK
  // runs BEFORE the counts, in the stated order: access exclusive granted on
  // the three parents, waiting on tasks, and NO other lock on tasks — the
  // three counts all read tasks, so had any of them run first, the file would
  // hold AccessShareLock there (granted: it does not conflict with the
  // writer's RowExclusiveLock). The writer marks a task done — what the tasks
  // page does all day: it changes no key column, so it holds tasks alone (an
  // INSERT would also hold RowShareLock on every parent its keys check, and
  // stop the file at its FIRST table instead).
  it("an in-flight write to tasks holds the file at its LOCK, taken parents-first and before the counts, until lock_timeout (55P03)", async () => {
    const writer = new Client({ connectionString: DB_URL });
    const spy = new Client({ connectionString: DB_URL });
    await writer.connect();
    await spy.connect();
    const task = await insertTask({ org: ORG_B, kind: null });
    try {
      await writer.query("begin");
      await writer.query("update tasks set is_done = true, done_at = now() where id = $1", [task]);
      const pid = (await o.query<{ p: number }>("select pg_backend_pid() as p")).rows[0]!.p;
      const started = Date.now();
      const run = rolledBack(async () => {
        await expect(o.query(file())).rejects.toMatchObject({ code: "55P03" });
      });
      let seen: { relname: string; mode: string; granted: boolean }[] = [];
      for (let i = 0; i < 40; i += 1) {
        seen = (
          await spy.query<{ relname: string; mode: string; granted: boolean }>(
            `select c.relname::text as relname, l.mode, l.granted from pg_locks l join pg_class c on c.oid = l.relation
              where l.pid = $1 and c.relname in ('reservation_installments', 'reservations', 'leads', 'tasks')
              order by c.relname collate "C", l.mode collate "C"`,
            [pid],
          )
        ).rows;
        if (seen.some((r) => !r.granted)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await run;
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(seen).toEqual([
        { relname: "leads", mode: "AccessExclusiveLock", granted: true },
        { relname: "reservation_installments", mode: "AccessExclusiveLock", granted: true },
        { relname: "reservations", mode: "AccessExclusiveLock", granted: true },
        { relname: "tasks", mode: "AccessExclusiveLock", granted: false },
      ]);
    } finally {
      await writer.query("rollback");
      await writer.end();
      await spy.end();
    }
  });
});
