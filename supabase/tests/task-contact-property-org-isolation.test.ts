import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TASK_EXPORT_SELECT } from "@/lib/services/task-export";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { K0126, MD5_0125, REVERT_0126_SQL, SIG_0126 as SIG, strip0126 } from "./revert-0126";

/**
 * 0126: a reservation belongs to the organisation of its contact, a task to
 * the organisation of the contact and the property it names, and the sweeps
 * that read tasks and holds by contact — create_followup_nudges' retention
 * arms (0078, 0123's text), warn_expiring_reservations and
 * remind_due_installments (0125's text) — look for, complete and copy only
 * that organisation's rows. The contact / property twin of 0119–0125.
 *
 * THE GAP, as it stood at 0125 (measured through PostgREST): reservations.
 * contact_id (0044), tasks.contact_id and tasks.property_id (0001) referenced
 * their parent by id alone, and reservations_insert / _update, tasks_insert /
 * _update check only the CALLER's organisation. So a member of B who learned
 * an A id could write a hold or a task of B naming A's contact or property
 * (201 — and a missing id answered 23503: an existence oracle). Then:
 *   * create_followup_nudges arm 2c's duplicate guard counted a B row on A's
 *     contact, dated A's retention day, as A's reminder — A's "review for
 *     destruction" reminder was never raised (a completed B row too: the
 *     guard ignores is_done);
 *   * arm 4c completed B's rows on A's contact dated any other day, and the
 *     rest once A's marker was cleared, into B's chain — an oracle on A's
 *     private retention date and on A's purge;
 *   * the two reservation sweeps copied a B hold's A contact into B's tasks.
 * The tests marked "RED at 0125" failed against 0125's catalogue before the
 * migration; the rest pin what must not change.
 *
 * TWO KINDS OF CALLER, as in 0119–0125: supabase-js through PostgREST (aal2
 * sessions, and the service role), and one `pg` session as postgres — pg_cron's
 * role — for fixtures, verification, cleanup, the sweeps and the migration
 * replays. EVERY SWEEP AND REPLAY RUNS IN ONE TRANSACTION ROLLED BACK after its
 * reads (the sweeps run as the cron runs them — every organisation, p_org
 * null — and scoped where the scope is the point); the cross-organisation rows
 * the new keys refuse are planted past them with `session_replication_role =
 * replica` inside it — the way a row written before a NOT VALID constraint,
 * or loaded by a replica-mode restore, escapes a key. That a planted TASK is
 * uncommitted matters only if a body WRONGLY updates it: PostgreSQL then
 * re-checks the key on the update (the row is its own transaction's) and the
 * sweep fails — a missing predicate still fails the test, loudly. This file
 * is never pointed at hosted.
 *
 * TWO THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORGS = [ORG_A, ORG_B];
const RUN = Date.now().toString(36);
const ORG_NAME = "task-contact-prop";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, "..", "migrations", "0126_task_contact_property_org_isolation.sql");

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
type Parent = { id: string; reference: string };

async function newProperty(org: string): Promise<Parent> {
  n += 1;
  const { rows } = await o.query<Parent>(
    `insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id, reference`,
    [org, `TCP${RUN}${n}`.toUpperCase()],
  );
  return rows[0]!;
}

/** A contact as postgres; `retentionUntil` makes it an erased contact under AML retention until that Cyprus day. */
async function newContact(org: string, opts: { retentionUntil?: string } = {}) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into contacts (org_id, first_name, erased_at, retention_until, is_archived)
     values ($1, $2, case when $3::date is null then null else now() end, $3::date, $3::date is not null) returning id`,
    [org, `ZZTEST Person${n} ${RUN}`, opts.retentionUntil ?? null],
  );
  return rows[0]!.id;
}

type HoldOpts = { contact?: string | null; property?: string; status?: string; expiresInHours?: number };

/** A hold as postgres, on a fresh property of `org` unless one is given. `plant` = past the keys, inside the caller's transaction. */
async function newHold(org: string, opts: HoldOpts = {}, plant = false) {
  const property = opts.property ?? (await newProperty(org)).id;
  const sql = `insert into reservations (org_id, property_id, contact_id, status, held_from, expires_at)
               values ($1, $2, $3, $4::reservation_status, now() - interval '2 days', now() + make_interval(hours => $5::int)) returning id`;
  const params = [org, property, opts.contact ?? null, opts.status ?? "held", opts.expiresInHours ?? 24 * 10];
  if (!plant) return (await o.query<{ id: string }>(sql, params)).rows[0]!.id;
  await o.query("set local session_replication_role = replica");
  try {
    return (await o.query<{ id: string }>(sql, params)).rows[0]!.id;
  } finally {
    await o.query("set local session_replication_role = origin");
  }
}

async function newLine(org: string, reservation: string, opts: { dueInDays?: number } = {}) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into reservation_installments (org_id, reservation_id, sort_order, label, amount, due_date)
     values ($1, $2, $3, $4, 1000, current_date + $5::int) returning id`,
    [org, reservation, n, `Line ${RUN} ${n}`, opts.dueInDays ?? 2],
  );
  return rows[0]!.id;
}

type TaskSpec = {
  org: string;
  kind: string | null;
  contact?: string | null;
  property?: string | null;
  /** the Cyprus day it is due (end of that day, as the sweeps key it); null = now() */
  dueDate?: string | null;
  assignee?: string | null;
  done?: boolean;
};

/** A task written as postgres. `plant` = past the keys, inside the caller's transaction. */
async function insertTask(t: TaskSpec, plant = false) {
  n += 1;
  const sql = `insert into tasks (org_id, title, due_at, assignee_id, contact_id, property_id, kind, is_done, done_at)
               values ($1, $2,
                       case when $3::date is null then now()
                            else ($3::date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia' end,
                       $4, $5, $6, $7, $8, case when $8 then now() - interval '1 day' end)
               returning id`;
  const params = [
    t.org,
    `ZZTEST ${plant ? "planted" : "seeded"} ${RUN} ${n}`,
    t.dueDate ?? null,
    t.assignee ?? null,
    t.contact ?? null,
    t.property ?? null,
    t.kind,
    t.done ?? false,
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

type TaskState = { is_done: boolean; done_at: string | null };
async function taskState(task: string) {
  return (await row<TaskState>("select is_done, done_at::text from tasks where id = $1", [task]))!;
}

async function isDone(task: string) {
  return (await taskState(task)).is_done;
}

/** Every task naming the contact (either organisation), oldest first. */
async function tasksOnContact(contact: string, kind: string) {
  const { rows } = await o.query<{ id: string; org_id: string; is_done: boolean; day: string; assignee_id: string | null }>(
    `select id, org_id, is_done, to_char((due_at at time zone 'Asia/Nicosia')::date, 'YYYY-MM-DD') as day, assignee_id
       from tasks where contact_id = $1 and kind = $2 order by created_at, id`,
    [contact, kind],
  );
  return rows;
}

/** The reminders a sweep raised on a hold. */
async function remindersOn(hold: string, kind: "reservation_expiring" | "installment_due") {
  const { rows } = await o.query<{ id: string; org_id: string; contact_id: string | null; property_id: string | null }>(
    "select id, org_id, contact_id, property_id from tasks where reservation_id = $1 and kind = $2 order by created_at, id",
    [hold, kind],
  );
  return rows;
}

/** Events in `org`'s chain about any of `ids` (the self-heals' `superseded`, the mints' events). */
async function eventsAbout(org: string, ids: string[]) {
  const { rows } = await o.query<{ event_type: string; entity_id: string; payload: Record<string, unknown> }>(
    "select event_type, entity_id, payload from events where org_id = $1 and (entity_id = any($2::uuid[]) or payload->>'task_id' = any($3::text[])) order by id",
    [org, ids, ids],
  );
  return rows;
}

async function chainOk(org: string) {
  const { rows } = await o.query<{ ok: boolean }>("select public.verify_events_chain($1) as ok", [org]);
  return rows[0]!.ok;
}

/** The Cyprus calendar day `k` days from today. */
async function cyprusDay(k: number) {
  return (await row<{ d: string }>("select to_char((now() at time zone 'Asia/Nicosia')::date + $1::int, 'YYYY-MM-DD') as d", [k]))!.d;
}

async function plusDays(day: string, k: number) {
  return (await row<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') as d", [day, k]))!.d;
}

const nudges = (org: string | null = null) => o.query("select public.create_followup_nudges($1::uuid)", [org]);
const warn = (org: string | null = null) => o.query("select public.warn_expiring_reservations($1::uuid)", [org]);
const remind = (org: string | null = null) => o.query("select public.remind_due_installments($1::uuid)", [org]);

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

/** The foreign keys from tasks onto contacts and properties, and from reservations onto contacts. */
async function keysOf() {
  const { rows } = await o.query<{ rel: string; conname: string; def: string; convalidated: boolean }>(
    `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint
      where contype = 'f'
        and ((conrelid = 'public.tasks'::regclass and confrelid in ('public.contacts'::regclass, 'public.properties'::regclass))
          or (conrelid = 'public.reservations'::regclass and confrelid = 'public.contacts'::regclass))
      order by conname collate "C"`,
  );
  return rows;
}

const KEYS_0126 = [
  { rel: "reservations", conname: "reservations_org_contact_fkey", def: "FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE SET NULL (contact_id)", convalidated: true },
  { rel: "tasks", conname: "tasks_org_contact_fkey", def: "FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)", convalidated: true },
  { rel: "tasks", conname: "tasks_org_property_fkey", def: "FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id)", convalidated: true },
];
const KEYS_0125 = [
  { rel: "reservations", conname: "reservations_contact_id_fkey", def: "FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL", convalidated: true },
  { rel: "tasks", conname: "tasks_contact_id_fkey", def: "FOREIGN KEY (contact_id) REFERENCES contacts(id)", convalidated: true },
  { rel: "tasks", conname: "tasks_property_id_fkey", def: "FOREIGN KEY (property_id) REFERENCES properties(id)", convalidated: true },
];

/** 0125's catalogue for this file's objects, inside the caller's transaction. */
const revertTo0125 = () => o.query(REVERT_0126_SQL);

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  // a killed earlier run of THIS file leaves its rows behind (afterAll never
  // ran) — and a run against 0125 commits cross-organisation ones, which would
  // stop the next local apply of 0126 in its preflight: remove this file's own
  // throwaway organisations' tasks and holds only, never every cross-org row
  // in the database (that is what the restore pack's INTEGRITY rows report)
  const { rows: stale } = await o.query<{ id: string }>("select id from organizations where name like $1", [`${ORG_NAME} %`]);
  if (stale.length) {
    const ids = stale.map((r) => r.id);
    await o.query("delete from tasks where org_id = any($1::uuid[])", [ids]);
    await o.query("delete from reservation_installments where org_id = any($1::uuid[])", [ids]);
    await o.query("delete from reservations where org_id = any($1::uuid[])", [ids]);
  }
  await ensureTestOrg(svc, ORG_A, `${ORG_NAME} A ${RUN}`, `${ORG_NAME}-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `${ORG_NAME} B ${RUN}`, `${ORG_NAME}-b-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors ({} messages)
  adminA = await createTestUser(svc, `tcp-admin-a-${RUN}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `tcp-agent-a-${RUN}@test.local`, "agent", ORG_A);
  adminB = await createTestUser(svc, `tcp-admin-b-${RUN}@test.local`, "admin", ORG_B);
  agentB = await createTestUser(svc, `tcp-agent-b-${RUN}@test.local`, "agent", ORG_B);
  userIds.push(adminA.id, agentA.id, adminB.id, agentB.id);
});

afterAll(async () => {
  // every task and hold of both organisations first: at 0125 a row of B could name A's parents
  await o.query("delete from tasks where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from reservation_installments where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from reservations where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from contacts where org_id = any($1::uuid[])", [ORGS]);
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
describe("the premise: organisation B cannot read A's contact or property", () => {
  it("B's admin and agent see neither; A's admin does", async () => {
    const contact = await newContact(ORG_A);
    const property = await newProperty(ORG_A);
    for (const c of [adminB.client, agentB.client]) {
      expect((await c.from("contacts").select("id").eq("id", contact)).data).toEqual([]);
      expect((await c.from("properties").select("id").eq("id", property.id)).data).toEqual([]);
    }
    expect((await adminA.client.from("contacts").select("id").eq("id", contact)).data).toEqual([{ id: contact }]);
    expect((await adminA.client.from("properties").select("id").eq("id", property.id)).data).toEqual([{ id: property.id }]);
  });
});

const LINKS = [
  { column: "contact_id", kind: "retention_expired", key: "tasks_org_contact_fkey" },
  { column: "property_id", kind: "listing_status_check", key: "tasks_org_property_fkey" },
] as const;
type Link = (typeof LINKS)[number];

/** 23503 from THIS key — not from some other key that happens to answer first. */
function refusedBy(error: { code?: string; message?: string } | null, key: string, what: string) {
  expect(error?.code, what).toBe("23503");
  expect(error?.message, what).toContain(`"${key}"`);
}

/** The TaskSpec field for a link. */
function on(link: Link, id: string): Pick<TaskSpec, "contact" | "property"> {
  return link.column === "contact_id" ? { contact: id } : { property: id };
}

/** One A parent of each kind. */
async function aParents() {
  return { contact_id: await newContact(ORG_A), property_id: (await newProperty(ORG_A)).id } as Record<Link["column"], string>;
}

describe("B cannot create, re-point or upsert a task onto A's contact or property (23503, nothing written) — RED at 0125", () => {
  const shape = (who: TestUser, link: Link, id: string, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    title: `ZZTEST by B ${RUN}`,
    assignee_id: who.id,
    created_by: who.id,
    [link.column]: id,
    ...extra,
  });

  it("INSERT — as B's agent and as B's admin, with a sweep's kind or none", async () => {
    const a = await aParents();
    for (const link of LINKS) {
      for (const [who, extra] of [
        [agentB, { kind: link.kind }],
        [adminB, {}],
      ] as const) {
        const r = await who.client.from("tasks").insert(shape(who, link, a[link.column], extra)).select("id");
        refusedBy(r.error, link.key, `${who.email} ${link.column}`);
        expect(r.data).toBeNull();
      }
      expect(await count(`select count(*)::int as c from tasks where ${link.column} = $1`, [a[link.column]]), link.column).toBe(0);
    }
  });

  it("UPDATE — a task of B, bare or on B's own contact and property, cannot be pointed at A's", async () => {
    const a = await aParents();
    const bContact = await newContact(ORG_B);
    const bProperty = (await newProperty(ORG_B)).id;
    for (const link of LINKS) {
      const bare = await insertTask({ org: ORG_B, kind: null, assignee: agentB.id });
      const linked = await insertTask({ org: ORG_B, kind: null, assignee: agentB.id, contact: bContact, property: bProperty });
      for (const [id, who] of [
        [bare, agentB],
        [linked, adminB],
      ] as const) {
        const r = await who.client.from("tasks").update({ [link.column]: a[link.column] }).eq("id", id).select("id");
        refusedBy(r.error, link.key, `${who.email} ${link.column}`);
      }
      expect(await count(`select count(*)::int as c from tasks where ${link.column} = $1`, [a[link.column]]), link.column).toBe(0);
      expect(await row<{ c: string | null; p: string | null }>("select contact_id as c, property_id as p from tasks where id = $1", [linked])).toEqual({
        c: bContact,
        p: bProperty,
      });
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
      refusedBy(merge.error, link.key, link.column);
      const fresh = randomUUID();
      const ins = await adminB.client
        .from("tasks")
        .upsert({ id: fresh, ...shape(adminB, link, a[link.column]) }, { onConflict: "id" })
        .select("id");
      refusedBy(ins.error, link.key, link.column);
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
      refusedBy(real.error, link.key, `${link.column}: an existing A id`);
      refusedBy(none.error, link.key, `${link.column}: a missing id`);
      expect(real.error?.message).toBe(none.error?.message);
      expect((real.error?.details ?? "").replace(a[link.column], "<id>")).toBe((none.error?.details ?? "").replace(missing, "<id>"));
      expect(JSON.stringify(real.error)).not.toContain(ORG_A);
    }
  });

  it("a task's organisation cannot move off its contact's or property's — by a user session (RLS) or by the service role (the key)", async () => {
    const a = await aParents();
    for (const link of LINKS) {
      // no assignee: only the link key under test may answer the service role's move
      const task = await insertTask({ org: ORG_A, kind: null, ...on(link, a[link.column]) });
      const user = await adminA.client.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
      expect(user.error?.code, link.column).toBe("42501");
      const maintenance = await svc.from("tasks").update({ org_id: ORG_B }).eq("id", task).select("id");
      refusedBy(maintenance.error, link.key, link.column);
      expect((await row<{ org_id: string }>("select org_id from tasks where id = $1", [task]))!.org_id).toBe(ORG_A);
    }
  });

  it("the service role and the table owner are refused too (the keys bind every writer)", async () => {
    const a = await aParents();
    for (const link of LINKS) {
      const s = await svc.from("tasks").insert({ org_id: ORG_B, title: `ZZTEST svc ${RUN}`, [link.column]: a[link.column] }).select("id");
      refusedBy(s.error, link.key, link.column);
      await expect(
        insertTask({ org: ORG_B, kind: link.kind, ...on(link, a[link.column]) }),
      ).rejects.toMatchObject({ code: "23503", constraint: link.key });
    }
  });
});

describe("B cannot create, re-point or upsert a reservation naming A's contact (23503, nothing written) — RED at 0125", () => {
  const RES_KEY = "reservations_org_contact_fkey";
  /** createReservation's payload (lib/actions/reservations.ts), on a fresh property of B's. */
  const holdShape = async (who: TestUser, contact: string | null) => ({
    org_id: ORG_B,
    property_id: (await newProperty(ORG_B)).id,
    contact_id: contact,
    status: "held",
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    created_by: who.id,
  });
  const holdsOn = (contact: string) => count("select count(*)::int as c from reservations where contact_id = $1", [contact]);

  it("INSERT — as B's agent and as B's admin", async () => {
    const aContact = await newContact(ORG_A);
    for (const who of [agentB, adminB]) {
      const r = await who.client.from("reservations").insert(await holdShape(who, aContact)).select("id");
      refusedBy(r.error, RES_KEY, who.email);
      expect(r.data).toBeNull();
    }
    expect(await holdsOn(aContact)).toBe(0);
  });

  it("UPDATE — a hold of B, with no contact or with B's own, cannot be pointed at A's contact", async () => {
    const aContact = await newContact(ORG_A);
    const bContact = await newContact(ORG_B);
    for (const [who, own] of [
      [agentB, null],
      [adminB, bContact],
    ] as const) {
      const hold = await newHold(ORG_B, { contact: own });
      const r = await who.client.from("reservations").update({ contact_id: aContact }).eq("id", hold).select("id");
      refusedBy(r.error, RES_KEY, who.email);
      expect((await row<{ c: string | null }>("select contact_id as c from reservations where id = $1", [hold]))!.c).toBe(own);
    }
    expect(await holdsOn(aContact)).toBe(0);
  });

  it("UPSERT — onto an existing hold of B (merge) and as a new id: refused, nothing written", async () => {
    const aContact = await newContact(ORG_A);
    const existing = await newHold(ORG_B);
    const property = (await row<{ p: string }>("select property_id as p from reservations where id = $1", [existing]))!.p;
    const merge = await agentB.client
      .from("reservations")
      .upsert({ ...(await holdShape(agentB, aContact)), id: existing, property_id: property }, { onConflict: "id" })
      .select("id");
    refusedBy(merge.error, RES_KEY, "merge");
    const fresh = randomUUID();
    const ins = await adminB.client
      .from("reservations")
      .upsert({ ...(await holdShape(adminB, aContact)), id: fresh }, { onConflict: "id" })
      .select("id");
    refusedBy(ins.error, RES_KEY, "new id");
    expect(await row("select id from reservations where id = $1", [fresh])).toBeNull();
    expect((await row<{ c: string | null }>("select contact_id as c from reservations where id = $1", [existing]))!.c).toBeNull();
    expect(await holdsOn(aContact)).toBe(0);
  });

  it("the refusal no longer tells B whether an A contact exists, and carries nothing of A's", async () => {
    const aContact = await newContact(ORG_A);
    const missing = randomUUID();
    const real = await agentB.client.from("reservations").insert(await holdShape(agentB, aContact)).select("id");
    const none = await agentB.client.from("reservations").insert(await holdShape(agentB, missing)).select("id");
    refusedBy(real.error, RES_KEY, "an existing A contact");
    refusedBy(none.error, RES_KEY, "a missing contact");
    expect(real.error?.message).toBe(none.error?.message);
    expect((real.error?.details ?? "").replace(aContact, "<id>")).toBe((none.error?.details ?? "").replace(missing, "<id>"));
    expect(JSON.stringify(real.error)).not.toContain(ORG_A);
  });

  it("the service role and the table owner are refused too (the key binds every writer)", async () => {
    const aContact = await newContact(ORG_A);
    const s = await svc.from("reservations").insert(await holdShape(adminB, aContact)).select("id");
    refusedBy(s.error, RES_KEY, "service role");
    await expect(newHold(ORG_B, { contact: aContact })).rejects.toMatchObject({ code: "23503", constraint: RES_KEY });
    expect(await holdsOn(aContact)).toBe(0);
  });

  it("a hold of A that names A's contact cannot move to B together with a property of B — the contact key alone answers (service role)", async () => {
    const aContact = await newContact(ORG_A);
    const hold = await newHold(ORG_A, { contact: aContact });
    const bProperty = (await newProperty(ORG_B)).id;
    const moved = await svc.from("reservations").update({ org_id: ORG_B, property_id: bProperty }).eq("id", hold).select("id");
    refusedBy(moved.error, RES_KEY, "hold moved with a B property");
    expect(await row<{ org_id: string; contact_id: string }>("select org_id, contact_id from reservations where id = $1", [hold])).toEqual({
      org_id: ORG_A,
      contact_id: aContact,
    });
  });
});

describe("same-organisation and nullable links, the app's writers, embeds and deletion stay as they were", () => {
  it("tasks: A's agent and admin link a task to A's contact and property; re-point within A; clear; a task with none is fine", async () => {
    const a1 = await aParents();
    const a2 = await aParents();
    const mine = await agentA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `ZZTEST own ${RUN}`, assignee_id: agentA.id, created_by: agentA.id, ...a1 })
      .select("id")
      .single();
    expect(mine.error).toBeNull();
    const moved = await adminA.client.from("tasks").update(a2).eq("id", mine.data!.id).select("id");
    expect(moved.error).toBeNull();
    expect(moved.data).toEqual([{ id: mine.data!.id }]);
    const cleared = await agentA.client.from("tasks").update({ contact_id: null, property_id: null }).eq("id", mine.data!.id).select("id");
    expect(cleared.error).toBeNull();
    expect(cleared.data).toEqual([{ id: mine.data!.id }]);
    const none = await adminA.client.from("tasks").insert({ org_id: ORG_A, title: `ZZTEST none ${RUN}`, assignee_id: adminA.id }).select("id").single();
    expect(none.error).toBeNull();
  });

  it("reservations: a hold with A's contact, re-pointed within A, cleared, and a hold with none — all accepted", async () => {
    const c1 = await newContact(ORG_A);
    const c2 = await newContact(ORG_A);
    const p1 = (await newProperty(ORG_A)).id;
    const p2 = (await newProperty(ORG_A)).id;
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const hold = await agentA.client
      .from("reservations")
      .insert({ org_id: ORG_A, property_id: p1, contact_id: c1, status: "held", expires_at: until, created_by: agentA.id })
      .select("id")
      .single();
    expect(hold.error).toBeNull();
    const moved = await adminA.client.from("reservations").update({ contact_id: c2 }).eq("id", hold.data!.id).select("contact_id");
    expect(moved.error).toBeNull();
    expect(moved.data).toEqual([{ contact_id: c2 }]);
    const cleared = await agentA.client.from("reservations").update({ contact_id: null }).eq("id", hold.data!.id).select("contact_id");
    expect(cleared.error).toBeNull();
    expect(cleared.data).toEqual([{ contact_id: null }]);
    const none = await agentA.client
      .from("reservations")
      .insert({ org_id: ORG_A, property_id: p2, contact_id: null, status: "held", expires_at: until, created_by: agentA.id })
      .select("id")
      .single();
    expect(none.error).toBeNull();
  });

  it("the app's writers are accepted exactly as they send them: quickAddTask, a match alert, createReservation, and the merge's repoint on the admin client", async () => {
    const contact = await newContact(ORG_A);
    const property = await newProperty(ORG_A);
    // lib/actions/tasks.ts quickAddTask — the caller's session, the link its own page holds
    for (const link of [{ contact_id: contact }, { property_id: property.id }]) {
      const quick = await agentA.client
        .from("tasks")
        .insert({ org_id: ORG_A, title: `ZZTEST quick ${RUN}`, due_at: null, assignee_id: agentA.id, created_by: agentA.id, ...link })
        .select("id")
        .single();
      expect(quick.error, JSON.stringify(link)).toBeNull();
    }
    // lib/services/match-alerts.ts raiseOneTask — the caller's session
    const alert = await adminA.client
      .from("tasks")
      .insert({
        org_id: ORG_A,
        title: `ZZTEST match ${RUN}`,
        due_at: new Date(Date.now() + 86_400_000).toISOString(),
        assignee_id: agentA.id,
        property_id: property.id,
        kind: "new_listing_match",
        created_by: adminA.id,
      })
      .select("id")
      .single();
    expect(alert.error).toBeNull();
    // lib/actions/reservations.ts createReservation — the caller's session
    const hold = await agentA.client
      .from("reservations")
      .insert({
        org_id: ORG_A,
        property_id: property.id,
        contact_id: contact,
        deal_id: null,
        offer_id: null,
        status: "held",
        amount: null,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        notes: null,
        created_by: agentA.id,
      })
      .select("id")
      .single();
    expect(hold.error).toBeNull();
    // lib/actions/merge-contacts.ts — the admin client, repointing by contact_id alone
    const primary = await newContact(ORG_A);
    const onTask = await svc.from("tasks").update({ contact_id: primary }).eq("contact_id", contact).select("id");
    expect(onTask.error).toBeNull();
    expect(onTask.data).toHaveLength(1);
    const onHold = await svc.from("reservations").update({ contact_id: primary }).eq("contact_id", contact).select("id");
    expect(onHold.error).toBeNull();
    expect(onHold.data).toEqual([{ id: hold.data!.id }]);
  });

  it("PostgREST resolves ONE relationship each way (no PGRST201): the task export's and the property page's embeds, and the reverse ones", async () => {
    const contact = await newContact(ORG_A);
    const property = await newProperty(ORG_A);
    const task = await insertTask({ org: ORG_A, kind: null, assignee: adminA.id, contact, property: property.id });
    const hold = await newHold(ORG_A, { contact, property: property.id });
    // lib/services/task-export.ts
    const exported = await adminA.client.from("tasks").select(TASK_EXPORT_SELECT).eq("id", task).single();
    expect(exported.error).toBeNull();
    expect((exported.data as unknown as { properties: { reference: string } }).properties.reference).toBe(property.reference);
    const fromTask = await adminA.client.from("tasks").select("id, contacts(id), properties(id)").eq("id", task).single();
    expect(fromTask.error).toBeNull();
    const t = fromTask.data as unknown as { contacts: { id: string }; properties: { id: string } };
    expect([t.contacts.id, t.properties.id]).toEqual([contact, property.id]);
    // app/(app)/properties/[id]/page.tsx — the hold's contact
    const fromHold = await adminA.client
      .from("reservations")
      .select("id, status, amount, held_from, expires_at, released_at, release_reason, notes, contact_id, contacts(display_name)")
      .eq("id", hold)
      .single();
    expect(fromHold.error).toBeNull();
    expect((fromHold.data as unknown as { contacts: { display_name: string } }).contacts.display_name).toContain("ZZTEST Person");
    const back = await adminA.client.from("contacts").select("id, tasks(id), reservations(id)").eq("id", contact).single();
    expect(back.error).toBeNull();
    const b = back.data as unknown as { tasks: { id: string }[]; reservations: { id: string }[] };
    expect([b.tasks.map((x) => x.id), b.reservations.map((x) => x.id)]).toEqual([[task], [hold]]);
    const fromProperty = await adminA.client.from("properties").select("id, tasks(id)").eq("id", property.id).single();
    expect(fromProperty.error).toBeNull();
    expect((fromProperty.data as unknown as { tasks: { id: string }[] }).tasks.map((x) => x.id)).toEqual([task]);
  });

  it("deletion: a contact or property with a task still cannot be deleted (NO ACTION) — a hold naming the contact too does not change that", async () => {
    await rolledBack(async () => {
      const contact = await newContact(ORG_A);
      await newHold(ORG_A, { contact });
      await insertTask({ org: ORG_A, kind: null, contact });
      await o.query("savepoint del");
      await expect(o.query("delete from contacts where id = $1", [contact])).rejects.toMatchObject({
        code: "23503",
        constraint: expect.stringMatching(/^tasks_(org_contact|contact_id)_fkey$/),
      });
      await o.query("rollback to savepoint del");
      const property = (await newProperty(ORG_A)).id;
      await insertTask({ org: ORG_A, kind: null, property });
      await expect(o.query("delete from properties where id = $1", [property])).rejects.toMatchObject({
        code: "23503",
        constraint: expect.stringMatching(/^tasks_(org_property|property_id)_fkey$/),
      });
    });
  });

  it("deletion: deleting a contact a hold names clears ONLY the hold's contact_id — its organisation and everything else stay (service role, as maintenance would)", async () => {
    const contact = await newContact(ORG_A);
    const property = await newProperty(ORG_A);
    const hold = await newHold(ORG_A, { contact, property: property.id });
    type Hold = { org_id: string; property_id: string; contact_id: string | null; status: string; expires_at: string; held_from: string };
    const read = () => row<Hold>("select org_id, property_id, contact_id, status::text, expires_at::text, held_from::text from reservations where id = $1", [hold]);
    const before = (await read())!;
    const del = await svc.from("contacts").delete().eq("id", contact).select("id");
    expect(del.error).toBeNull();
    expect(del.data).toEqual([{ id: contact }]);
    expect(await read()).toEqual({ ...before, contact_id: null });
    expect(before.org_id).toBe(ORG_A);
  });

  it("a hold's organisation cannot move off its property's (the service role is refused — by 0124's property key, which answers first)", async () => {
    const contact = await newContact(ORG_A);
    const hold = await newHold(ORG_A, { contact });
    const moved = await svc.from("reservations").update({ org_id: ORG_B }).eq("id", hold).select("id");
    expect(moved.error?.code).toBe("23503");
    expect(moved.error?.message).toMatch(/"reservations_org_(property|contact)_fkey"/);
    expect((await row<{ org_id: string }>("select org_id from reservations where id = $1", [hold]))!.org_id).toBe(ORG_A);
  });
});

describe("a linked contact or property cannot move to another organisation (the keys' ON UPDATE NO ACTION) — RED at 0125", () => {
  it("as the table owner: a contact with a task, a contact with only a hold and a property with only a task each refuse an org move, by the new key", async () => {
    await rolledBack(async () => {
      const withTask = await newContact(ORG_A);
      await insertTask({ org: ORG_A, kind: null, contact: withTask });
      const withHold = await newContact(ORG_A);
      await newHold(ORG_A, { contact: withHold });
      const property = (await newProperty(ORG_A)).id;
      await insertTask({ org: ORG_A, kind: null, property });
      for (const [table, id, key] of [
        ["contacts", withTask, "tasks_org_contact_fkey"],
        ["contacts", withHold, "reservations_org_contact_fkey"],
        ["properties", property, "tasks_org_property_fkey"],
      ] as const) {
        await o.query("savepoint move");
        await expect(o.query(`update ${table} set org_id = $1 where id = $2`, [ORG_B, id]), key).rejects.toMatchObject({ code: "23503", constraint: key });
        await o.query("rollback to savepoint move");
      }
    });
  });
});

describe("the retention sweep looks for, and completes, only the contact's own organisation's tasks (B's rows planted past the keys, rolled back) — RED at 0125", () => {
  it("arm 2c's guard: B's row on A's contact, dated A's retention day — open or already completed — no longer stands in for A's reminder", async () => {
    for (const done of [false, true]) {
      await rolledBack(async () => {
        const day = await cyprusDay(-1);
        const contact = await newContact(ORG_A, { retentionUntil: day });
        const plant = await insertTask({ org: ORG_B, kind: "retention_expired", contact, dueDate: day, done }, true);
        const planted = await taskState(plant);
        await nudges();
        await nudges();
        const mine = (await tasksOnContact(contact, "retention_expired")).filter((t) => t.org_id === ORG_A);
        expect(mine.map((t) => [t.day, t.is_done, t.assignee_id]), `A's own reminder, once (plant done: ${done})`).toEqual([[day, false, adminA.id]]);
        expect(await taskState(plant)).toEqual(planted);
        expect(await eventsAbout(ORG_B, [plant])).toEqual([]);
        expect((await eventsAbout(ORG_A, [mine[0]!.id])).map((e) => [e.event_type, e.payload.kind])).toEqual([["followup_task_created", "retention_expired"]]);
        expect(await chainOk(ORG_A)).toBe(true);
      });
    }
  });

  it("arm 2c's guard, scoped to A (p_org = A): the same — B's row does not suppress A's reminder", async () => {
    await rolledBack(async () => {
      const day = await cyprusDay(-1);
      const contact = await newContact(ORG_A, { retentionUntil: day });
      await insertTask({ org: ORG_B, kind: "retention_expired", contact, dueDate: day }, true);
      await nudges(ORG_A);
      expect((await tasksOnContact(contact, "retention_expired")).filter((t) => t.org_id === ORG_A).map((t) => [t.day, t.is_done])).toEqual([[day, false]]);
    });
  });

  it("arm 4c's self-heal (the audit's reproduction): B's three rows dated around A's retention day all stay open — before and after A's marker is cleared — while A's own reminders heal as before", async () => {
    await rolledBack(async () => {
      const day = await cyprusDay(-1);
      const contact = await newContact(ORG_A, { retentionUntil: day });
      const current = await insertTask({ org: ORG_A, kind: "retention_expired", contact, dueDate: day, assignee: adminA.id });
      const stale = await insertTask({ org: ORG_A, kind: "retention_expired", contact, dueDate: await plusDays(day, 4), assignee: adminA.id });
      const plants = [
        await insertTask({ org: ORG_B, kind: "retention_expired", contact, dueDate: day }, true),
        await insertTask({ org: ORG_B, kind: "retention_expired", contact, dueDate: await plusDays(day, 1) }, true),
        await insertTask({ org: ORG_B, kind: "retention_expired", contact, dueDate: await plusDays(day, -1) }, true),
      ];
      await nudges();
      for (const p of plants) expect(await isDone(p), "B's row is not completed by A's retention date").toBe(false);
      expect(await eventsAbout(ORG_B, plants)).toEqual([]);
      expect(await isDone(stale), "A's own stale reminder (the positive control)").toBe(true);
      expect(await isDone(current), "A's own current reminder stays open").toBe(false);
      expect((await eventsAbout(ORG_A, [stale])).map((e) => [e.event_type, e.payload.reason])).toEqual([["superseded", "retention_purged_or_changed"]]);

      // purgeExpiredRetention nulls the marker (lib/actions/contact-erasure.ts)
      await o.query("update contacts set retention_until = null where id = $1", [contact]);
      await nudges();
      for (const p of plants) expect(await isDone(p), "B's row is not completed by A's purge").toBe(false);
      expect(await eventsAbout(ORG_B, plants)).toEqual([]);
      expect(await isDone(current), "A's own reminder completes on the purge (the positive control)").toBe(true);
      expect((await eventsAbout(ORG_A, [current])).map((e) => [e.event_type, e.payload.reason])).toEqual([["superseded", "retention_purged_or_changed"]]);
      expect(await chainOk(ORG_A)).toBe(true);
      expect(await chainOk(ORG_B)).toBe(true);
    });
  });

  it("arm 4c's self-heal, scoped to B (p_org = B): B's row on A's contact stays open — the caller's scope is not the tie", async () => {
    await rolledBack(async () => {
      const day = await cyprusDay(-1);
      const contact = await newContact(ORG_A, { retentionUntil: day });
      const plant = await insertTask({ org: ORG_B, kind: "retention_expired", contact, dueDate: await plusDays(day, 1) }, true);
      await nudges(ORG_B);
      expect(await isDone(plant)).toBe(false);
      expect(await eventsAbout(ORG_B, [plant])).toEqual([]);
    });
  });
});

describe("valid retention reminders still mint, complete and write their events — both organisations in one run, and again on a retry", () => {
  // 0078's cycle key: the guard deliberately ignores is_done, so an admin who
  // ticks the reminder off by hand is not re-reminded every night — and it
  // matches only its own kind, so another reminder on the same contact and
  // day never stands in for it. 0126 adds only the organisation to it.
  it("arm 2c's guard: A's own reminder completed by hand is not raised again; a task of another kind on the same contact and day does not count", async () => {
    await rolledBack(async () => {
      const day = await cyprusDay(-1);
      const ticked = await newContact(ORG_A, { retentionUntil: day });
      const handDone = await insertTask({ org: ORG_A, kind: "retention_expired", contact: ticked, dueDate: day, assignee: adminA.id, done: true });
      const other = await newContact(ORG_A, { retentionUntil: day });
      await insertTask({ org: ORG_A, kind: "reservation_expiring", contact: other, dueDate: day, assignee: adminA.id });
      await nudges();
      await nudges();
      expect((await tasksOnContact(ticked, "retention_expired")).map((t) => [t.id, t.is_done]), "no new reminder beside the ticked one").toEqual([[handDone, true]]);
      expect((await tasksOnContact(other, "retention_expired")).map((t) => [t.day, t.is_done]), "the other kind did not stand in").toEqual([[day, false]]);
    });
  });

  it("each organisation's erased contact gets its own admin's reminder; the purge completes it; a retry changes nothing", async () => {
    await rolledBack(async () => {
      const day = await cyprusDay(-2);
      const a = await newContact(ORG_A, { retentionUntil: day });
      const b = await newContact(ORG_B, { retentionUntil: day });
      await nudges();
      await nudges();
      const ta = await tasksOnContact(a, "retention_expired");
      const tb = await tasksOnContact(b, "retention_expired");
      expect(ta.map((t) => [t.org_id, t.day, t.is_done, t.assignee_id])).toEqual([[ORG_A, day, false, adminA.id]]);
      expect(tb.map((t) => [t.org_id, t.day, t.is_done, t.assignee_id])).toEqual([[ORG_B, day, false, adminB.id]]);
      await o.query("update contacts set retention_until = null where id = any($1::uuid[])", [[a, b]]);
      await nudges();
      await nudges();
      for (const [org, t] of [
        [ORG_A, ta[0]!],
        [ORG_B, tb[0]!],
      ] as const) {
        expect(await isDone(t.id)).toBe(true);
        expect((await eventsAbout(org, [t.id])).map((e) => [e.event_type, e.payload.kind, e.payload.reason ?? null])).toEqual([
          ["followup_task_created", "retention_expired", null],
          ["superseded", "retention_expired", "retention_purged_or_changed"],
        ]);
        expect(await chainOk(org)).toBe(true);
      }
    });
  });
});

describe("the reservation sweeps keep every valid reminder — every organisation or one, with or without a contact — and a retry raises nothing twice", () => {
  /** A's hold with A's contact, A's hold with none, B's hold with B's contact; each expiring in a day with a line due in two. */
  async function holds() {
    const aContact = await newContact(ORG_A);
    const bContact = await newContact(ORG_B);
    const specs = [
      { org: ORG_A, contact: aContact },
      { org: ORG_A, contact: null },
      { org: ORG_B, contact: bContact },
    ];
    const out: { org: string; contact: string | null; hold: string; line: string }[] = [];
    for (const s of specs) {
      const hold = await newHold(s.org, { contact: s.contact, expiresInHours: 24 });
      out.push({ ...s, hold, line: await newLine(s.org, hold, { dueInDays: 2 }) });
    }
    return out;
  }

  for (const [name, run, kind, event] of [
    ["warn_expiring_reservations", warn, "reservation_expiring", "reservation_expiring_soon"],
    ["remind_due_installments", remind, "installment_due", "installment_due_soon"],
  ] as const) {
    it(`${name}: every organisation (as the cron calls it), twice — one reminder per hold, in its organisation, carrying its own contact or none, one event each`, async () => {
      await rolledBack(async () => {
        const hs = await holds();
        await run();
        await run();
        for (const h of hs) {
          const r = await remindersOn(h.hold, kind);
          expect(r.map((x) => [x.org_id, x.contact_id]), `${h.org === ORG_A ? "A" : "B"} ${h.contact ? "with" : "without"} a contact`).toEqual([[h.org, h.contact]]);
          expect((await eventsAbout(h.org, [r[0]!.id])).map((e) => e.event_type)).toEqual([event]);
        }
        expect(await chainOk(ORG_A)).toBe(true);
        expect(await chainOk(ORG_B)).toBe(true);
      });
    });

    it(`${name}: scoped to one organisation, it raises only that organisation's reminders, each with its own contact`, async () => {
      await rolledBack(async () => {
        const hs = await holds();
        await run(ORG_A);
        for (const h of hs) {
          expect((await remindersOn(h.hold, kind)).map((x) => [x.org_id, x.contact_id])).toEqual(h.org === ORG_A ? [[h.org, h.contact]] : []);
        }
        await run(ORG_B);
        await run(ORG_B);
        for (const h of hs) expect((await remindersOn(h.hold, kind)).map((x) => [x.org_id, x.contact_id])).toEqual([[h.org, h.contact]]);
      });
    });
  }
});

describe("a hold that names another organisation's contact (planted past the key, rolled back) no longer carries it into a reminder, and no longer stops anyone's — RED at 0125", () => {
  for (const [name, run, kind] of [
    ["warn_expiring_reservations", warn, "reservation_expiring"],
    ["remind_due_installments", remind, "installment_due"],
  ] as const) {
    it(`${name}: the planted B hold is reminded WITHOUT A's contact, and every valid hold of both organisations is reminded as before`, async () => {
      await rolledBack(async () => {
        const aContact = await newContact(ORG_A);
        const bContact = await newContact(ORG_B);
        const planted = await newHold(ORG_B, { contact: aContact, expiresInHours: 24 }, true);
        const validA = await newHold(ORG_A, { contact: aContact, expiresInHours: 24 });
        const validB = await newHold(ORG_B, { contact: bContact, expiresInHours: 24 });
        for (const [org, h] of [
          [ORG_B, planted],
          [ORG_A, validA],
          [ORG_B, validB],
        ] as const) {
          await newLine(org, h, { dueInDays: 2 });
        }
        await run();
        expect((await remindersOn(planted, kind)).map((x) => [x.org_id, x.contact_id]), "B's hold, reminded without A's contact").toEqual([[ORG_B, null]]);
        expect((await remindersOn(validA, kind)).map((x) => [x.org_id, x.contact_id])).toEqual([[ORG_A, aContact]]);
        expect((await remindersOn(validB, kind)).map((x) => [x.org_id, x.contact_id])).toEqual([[ORG_B, bContact]]);
        expect(await count("select count(*)::int as c from tasks where org_id = $1 and contact_id = $2", [ORG_B, aContact]), "no task of B names A's contact").toBe(0);
      });
    });
  }
});

describe("the catalogue: three tenant-bound, validated relationships; the three sweeps scoped in their own text — RED at 0125", () => {
  it("each link is ONE composite key (validated, its delete rule kept), the old keys gone; the referenced keys and the indexes exist; the earlier tenant keys untouched", async () => {
    expect(await keysOf()).toEqual(KEYS_0126);
    const { rows: ref } = await o.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where contype = 'u' and conname in ('contacts_org_id_id_key', 'properties_org_id_id_key') order by conname collate "C"`,
    );
    expect(ref).toEqual([
      { conname: "contacts_org_id_id_key", def: "UNIQUE (org_id, id)" },
      { conname: "properties_org_id_id_key", def: "UNIQUE (org_id, id)" },
    ]);
    const { rows: idx } = await o.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public'
          and indexname in ('reservations_org_contact_idx', 'tasks_org_contact_idx', 'tasks_org_property_idx',
                            'reservations_contact_idx', 'tasks_contact_id_idx', 'tasks_property_id_idx')
        order by indexname collate "C"`,
    );
    expect(idx.map((i) => i.indexdef)).toEqual([
      "CREATE INDEX reservations_contact_idx ON public.reservations USING btree (contact_id)",
      "CREATE INDEX reservations_org_contact_idx ON public.reservations USING btree (org_id, contact_id) WHERE (contact_id IS NOT NULL)",
      "CREATE INDEX tasks_contact_id_idx ON public.tasks USING btree (contact_id)",
      "CREATE INDEX tasks_org_contact_idx ON public.tasks USING btree (org_id, contact_id) WHERE (contact_id IS NOT NULL)",
      "CREATE INDEX tasks_org_property_idx ON public.tasks USING btree (org_id, property_id) WHERE (property_id IS NOT NULL)",
      "CREATE INDEX tasks_property_id_idx ON public.tasks USING btree (property_id)",
    ]);
    const { rows: earlier } = await o.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint where convalidated and conname in
         ('tasks_org_deal_fkey', 'tasks_org_viewing_fkey', 'tasks_org_mandate_fkey', 'tasks_org_reservation_fkey',
          'tasks_org_installment_fkey', 'tasks_org_lead_fkey', 'reservations_org_property_fkey', 'viewings_org_contact_fkey')
       order by conname collate "C"`,
    );
    expect(earlier).toEqual([
      { conname: "reservations_org_property_fkey", def: "FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE RESTRICT" },
      { conname: "tasks_org_deal_fkey", def: "FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id)" },
      { conname: "tasks_org_installment_fkey", def: "FOREIGN KEY (org_id, installment_id) REFERENCES reservation_installments(org_id, id) ON DELETE CASCADE" },
      { conname: "tasks_org_lead_fkey", def: "FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id)" },
      { conname: "tasks_org_mandate_fkey", def: "FOREIGN KEY (org_id, mandate_id) REFERENCES mandates(org_id, id)" },
      { conname: "tasks_org_reservation_fkey", def: "FOREIGN KEY (org_id, reservation_id) REFERENCES reservations(org_id, id) ON DELETE CASCADE" },
      { conname: "tasks_org_viewing_fkey", def: "FOREIGN KEY (org_id, viewing_id) REFERENCES viewings(org_id, id)" },
      { conname: "viewings_org_contact_fkey", def: "FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)" },
    ]);
    // no unique index on tasks may answer (23505) before a key does, nor one on reservations naming contact_id without org_id
    expect(await count("select count(*)::int as c from pg_index where indrelid = 'public.tasks'::regclass and indisunique and not indisprimary")).toBe(0);
    expect(
      await count(
        `select count(*)::int as c from pg_index i where i.indrelid = 'public.reservations'::regclass and i.indisunique
            and exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'contact_id')`,
      ),
    ).toBe(0);
  });

  it("the three sweeps: the retention guard and self-heal tied to the contact's organisation, the reservation sweeps copying only their own organisation's contact; nothing else moved; definer, search_path, volatility and ACLs kept", async () => {
    const code = async (sig: string) => (await bodyOf(sig)).replace(/--[^\n]*/g, "");
    const cfn = await code(SIG.cfn);
    expect(cfn).toMatch(/select 1 from tasks t\s+where t\.contact_id = d\.id\s+and t\.org_id = d\.org_id\s+and t\.kind = 'retention_expired'/);
    expect(cfn).toMatch(/from contacts c\s+where t\.contact_id = c\.id\s+and t\.org_id = c\.org_id\s+and t\.kind = 'retention_expired'/);
    for (const k of ["warn", "remind"] as const) {
      const s = await code(SIG[k]);
      expect(s, k).toMatch(/left join contacts ct on ct\.id = r\.contact_id\s+and ct\.org_id = r\.org_id\s+where /);
      expect(s, k).toMatch(/r\.property_id, ct\.id as contact_id, r\.created_by,/);
      expect(s, k).not.toMatch(/r\.contact_id\s*,/);
    }
    // each added line exactly where it belongs, and nowhere else
    const raw = { cfn: await bodyOf(SIG.cfn), warn: await bodyOf(SIG.warn), remind: await bodyOf(SIG.remind) };
    expect([occurrences(raw.cfn, K0126.retentionGuard), occurrences(raw.cfn, K0126.retentionHeal), occurrences(raw.cfn, K0126.contactJoin)]).toEqual([1, 1, 0]);
    for (const k of ["warn", "remind"] as const) {
      expect([occurrences(raw[k], K0126.contactJoin), occurrences(raw[k], K0126.contactSelectNew), occurrences(raw[k], K0126.retentionHeal)], k).toEqual([1, 1, 0]);
    }
    for (const [k, sig] of Object.entries(SIG) as [keyof typeof SIG, string][]) {
      expect(await md5(strip0126(await bodyOf(sig), k)), `${k}: 0123's / 0125's body plus exactly ITS 0126 lines`).toBe(MD5_0125[k]);
      // every organisation in one run: row by row, never the session's
      expect(await bodyOf(sig), k).not.toMatch(/current_org_id\(\)/);
    }
    const { rows } = await o.query<{ p: string; secdef: boolean; vol: string; config: string[]; lang: string; anon: boolean; auth: boolean; svc: boolean; comment: string }>(
      `select p.oid::regprocedure::text as p, p.prosecdef as secdef, p.provolatile::text as vol, p.proconfig as config, l.lanname::text as lang,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              obj_description(p.oid, 'pg_proc') as comment
         from pg_proc p join pg_language l on l.oid = p.prolang
        where p.oid = any($1::regprocedure[]) order by p.oid::regprocedure::text collate "C"`,
      [Object.values(SIG)],
    );
    expect(rows.map((r) => ({ p: r.p, secdef: r.secdef, vol: r.vol, config: r.config, lang: r.lang, anon: r.anon, auth: r.auth, svc: r.svc }))).toEqual([
      { p: "create_followup_nudges(uuid)", secdef: true, vol: "v", config: ["search_path=public"], lang: "sql", anon: false, auth: false, svc: true },
      { p: "remind_due_installments(uuid)", secdef: true, vol: "v", config: ["search_path=public"], lang: "sql", anon: false, auth: false, svc: true },
      { p: "warn_expiring_reservations(uuid)", secdef: true, vol: "v", config: ["search_path=public"], lang: "sql", anon: false, auth: false, svc: true },
    ]);
    for (const r of rows) expect(r.comment, r.p).toContain(" Since 0126");
  });
});

describe("the migration file: upgrade from 0125, refusal over existing mismatches or a changed key or body, re-run, concurrent writers", () => {
  const file = () => readFileSync(MIGRATION, "utf8");
  const commentsOf = async () =>
    (
      await o.query<{ c: string }>(
        "select coalesce(obj_description(oid, 'pg_proc'), '') as c from pg_proc where oid = any($1::regprocedure[]) order by oid::regprocedure::text collate \"C\"",
        [Object.values(SIG)],
      )
    ).rows.map((r) => r.c);

  it("applies over 0125's catalogue and this database's accumulated data: the keys validate, the probes run, each body is the old one plus 0126's lines", async () => {
    const notices: string[] = [];
    const listen = (msg: { message?: string }) => notices.push(msg.message ?? "");
    o.on("notice", listen);
    try {
      await rolledBack(async () => {
        const at0126 = await commentsOf();
        await revertTo0125();
        expect(await keysOf()).toEqual(KEYS_0125);
        // the revert reached 0125 whole — so the file's own key and index
        // statements are what put them back below (it uses `if not exists`)
        expect(
          await count("select count(*)::int as c from pg_indexes where indexname in ('reservations_org_contact_idx', 'tasks_org_contact_idx', 'tasks_org_property_idx')"),
        ).toBe(0);
        for (const [k, sig] of Object.entries(SIG) as [keyof typeof SIG, string][]) expect(await bodyMd5(sig), k).toBe(MD5_0125[k]);
        expect((await commentsOf()).every((c) => !c.includes("0126"))).toBe(true);
        await o.query(file());
        expect(await keysOf()).toEqual(KEYS_0126);
        for (const [k, sig] of Object.entries(SIG) as [keyof typeof SIG, string][]) expect(await md5(strip0126(await bodyOf(sig), k)), k).toBe(MD5_0125[k]);
        expect(await commentsOf(), "the file restores the comments it wrote").toEqual(at0126);
      });
    } finally {
      o.off("notice", listen);
    }
    expect(notices.some((x) => x.startsWith("0126: preflight passed"))).toBe(true);
    expect(notices).toContain('0126: probes: {"task contact","task property","reservation contact","contact delete clears only contact_id"}');
  });

  // The message is the proof: the PREFLIGHT refused (with all three counts),
  // so it ran before the key additions, which would otherwise have failed
  // 23503 on these rows.
  it("refuses over existing mismatches in its preflight, with all three counts, and changes nothing", async () => {
    await rolledBack(async () => {
      await revertTo0125();
      const a = await aParents();
      const hold = await newHold(ORG_B, { contact: a.contact_id });
      const planted = [
        await insertTask({ org: ORG_B, kind: null, contact: a.contact_id }),
        await insertTask({ org: ORG_B, kind: null, property: a.property_id }),
      ];
      await o.query("savepoint before_0126");
      await expect(o.query(file())).rejects.toThrow(
        /^0126 aborted: 1 reservation\(s\) name a contact of another organisation, 1 task\(s\) name a contact of another organisation, 1 task\(s\) name a property of another organisation — nothing was changed/,
      );
      await o.query("rollback to savepoint before_0126");
      expect(await keysOf()).toEqual(KEYS_0125);
      expect(await count("select count(*)::int as c from tasks where id = any($1::uuid[]) and org_id = $2", [planted, ORG_B])).toBe(2);
      expect((await row<{ c: string }>("select contact_id as c from reservations where id = $1", [hold]))!.c).toBe(a.contact_id);
    });
  });

  it("refuses over a single mismatch on ANY one of the three links (each count gates the file on its own)", async () => {
    const cases = [
      ["reservation contact", "1 reservation\\(s\\) name a contact of another organisation, 0 task\\(s\\) name a contact of another organisation, 0 task\\(s\\) name a property"],
      ["task contact", "0 reservation\\(s\\) name a contact of another organisation, 1 task\\(s\\) name a contact of another organisation, 0 task\\(s\\) name a property"],
      ["task property", "0 reservation\\(s\\) name a contact of another organisation, 0 task\\(s\\) name a contact of another organisation, 1 task\\(s\\) name a property"],
    ] as const;
    for (const [which, expected] of cases) {
      await rolledBack(async () => {
        await revertTo0125();
        const a = await aParents();
        if (which === "reservation contact") await newHold(ORG_B, { contact: a.contact_id });
        else if (which === "task contact") await insertTask({ org: ORG_B, kind: null, contact: a.contact_id });
        else await insertTask({ org: ORG_B, kind: null, property: a.property_id });
        await o.query("savepoint before_0126");
        await expect(o.query(file()), which).rejects.toThrow(new RegExp(`^0126 aborted: ${expected}`));
        await o.query("rollback to savepoint before_0126");
      });
    }
  });

  // A key that is not the one it replaces — its delete rule is what the file
  // preserves — and a second key for the pair (two relationships) are refused.
  const KEY_DRIFT: { name: string; sql: string; rel: string }[] = [
    {
      name: "tasks_contact_id_fkey",
      rel: "public.tasks",
      sql: "alter table public.tasks drop constraint tasks_contact_id_fkey, add constraint tasks_contact_id_fkey foreign key (contact_id) references public.contacts(id) on delete cascade",
    },
    {
      name: "reservations_contact_id_fkey",
      rel: "public.reservations",
      sql: "alter table public.reservations drop constraint reservations_contact_id_fkey, add constraint reservations_contact_id_fkey foreign key (contact_id) references public.contacts(id)",
    },
    {
      name: "tasks_property_id_fkey",
      rel: "public.tasks",
      sql: "alter table public.tasks add constraint zz_tasks_property_again foreign key (property_id) references public.properties(id)",
    },
  ];
  for (const d of KEY_DRIFT) {
    it(`refuses before any DDL when the key it replaces is not 0001's / 0044's (${d.name}: ${d.sql.includes("zz_") ? "a second key for the pair" : "a different rule"})`, async () => {
      await rolledBack(async () => {
        await revertTo0125();
        await o.query(d.sql);
        await o.query("savepoint before_0126");
        await expect(o.query(file())).rejects.toThrow(new RegExp(`^0126 aborted: the foreign key from ${d.rel.replace("public.", "")} to \\w+ is not \\d{4}'s ${d.name} `));
        await o.query("rollback to savepoint before_0126");
      });
    });
  }

  // One hand edit per function, as a hotfix typed into an SQL editor would
  // be: each must be refused by name — not just the first the loop checks.
  const TAMPER: { name: string; sig: string; from: string; to: string }[] = [
    { name: "create_followup_nudges", sig: SIG.cfn, from: "'AML retention expired — review for destruction: '", to: "'AML retention expired: '" },
    { name: "warn_expiring_reservations", sig: SIG.warn, from: "'Reservation on '", to: "'Hold on '" },
    { name: "remind_due_installments", sig: SIG.remind, from: "'Instalment \"'", to: "'Line \"'" },
  ];
  for (const t of TAMPER) {
    it(`refuses before any DDL when ${t.name}'s body is not the one it restates (an unrecorded change is not overwritten)`, async () => {
      await rolledBack(async () => {
        await revertTo0125();
        const def = (await o.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [t.sig])).rows[0]!.d;
        expect(def.split(t.from).length - 1, `the tamper point exists once in ${t.name}`).toBe(1);
        await o.query(def.replace(t.from, t.to));
        const tampered = await bodyMd5(t.sig);
        expect(Object.values(MD5_0125)).not.toContain(tampered);
        await o.query("savepoint before_0126");
        await expect(o.query(file())).rejects.toThrow(
          new RegExp(`^0126 aborted: ${t.name} is not the body 0126 expects on this database \\(md5 ${tampered}\\) — nothing was changed`),
        );
        await o.query("rollback to savepoint before_0126");
      });
    });
  }

  // Every attribute the preflight guards, drifted one at a time — each is one
  // CREATE OR REPLACE or GRANT below would silently reset.
  const DRIFT: { name: string; sql: string }[] = [
    { name: "create_followup_nudges", sql: "alter function public.create_followup_nudges(uuid) security invoker" },
    { name: "warn_expiring_reservations", sql: "alter function public.warn_expiring_reservations(uuid) set search_path = public, pg_temp" },
    { name: "remind_due_installments", sql: "alter function public.remind_due_installments(uuid) stable" },
    { name: "create_followup_nudges", sql: "grant execute on function public.create_followup_nudges(uuid) to authenticated" },
    { name: "warn_expiring_reservations", sql: "revoke execute on function public.warn_expiring_reservations(uuid) from service_role" },
    { name: "remind_due_installments", sql: "grant execute on function public.remind_due_installments(uuid) to anon" },
    { name: "create_followup_nudges", sql: "alter function public.create_followup_nudges(uuid) strict" },
    { name: "warn_expiring_reservations", sql: "alter function public.warn_expiring_reservations(uuid) parallel safe" },
    // cron calls each on its default: every organisation
    { name: "create_followup_nudges", sql: "p_org DEFAULT NULL -> DEFAULT <an organisation>" },
  ];
  for (const d of DRIFT) {
    it(`refuses before any DDL when a function's attributes drifted (${d.sql.replace(/^.*function public\./, "")}) — CREATE OR REPLACE and the grants would reset them silently`, async () => {
      await rolledBack(async () => {
        await revertTo0125();
        if (d.sql.startsWith("p_org")) {
          // the same body, a different default: CREATE OR REPLACE from its own definition
          const def = (await o.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [SIG.cfn])).rows[0]!.d;
          expect(def.split("p_org uuid DEFAULT NULL::uuid").length - 1).toBe(1);
          await o.query(def.replace("p_org uuid DEFAULT NULL::uuid", `p_org uuid DEFAULT '${ORG_A}'::uuid`));
          expect(await bodyMd5(SIG.cfn), "the body itself is unchanged").toBe(MD5_0125.cfn);
        } else {
          await o.query(d.sql);
        }
        await o.query("savepoint before_0126");
        await expect(o.query(file())).rejects.toThrow(
          new RegExp(
            `^0126 aborted: ${d.name}'s attributes \\(SECURITY DEFINER, search_path, language, return type, volatility, arguments, strictness, parallel safety, leakproof or EXECUTE grants\\) are not the ones 0126 expects on this database — nothing was changed`,
          ),
        );
        await o.query("rollback to savepoint before_0126");
      });
    });
  }

  // The refusal tests prove the PREFLIGHT refused (its message); that it
  // precedes every DDL statement is the file's text order — pinned here.
  it("its preflight (the LOCK, the counts, the key, body and attribute guards) precedes every DDL statement in the file", () => {
    const code = file()
      .split("\n")
      .map((l) => (l.trimStart().startsWith("--") ? "" : l))
      .join("\n");
    const ddl = code.search(/^\s*(alter|create|drop|comment on|grant|revoke)\b/im);
    expect(ddl).toBeGreaterThan(0);
    for (const marker of ["lock table public.reservations", "into n_rc", "into n_tc", "into n_tp", "pg_get_constraintdef(oid) = k.def", "md5(replace(p.prosrc", "0126: preflight passed"]) {
      const at = code.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      expect(at, marker).toBeLessThan(ddl);
    }
    // the reservation's contact key is added before the task's (see ORDER in the header)
    expect(code.indexOf("add constraint reservations_org_contact_fkey")).toBeGreaterThan(ddl);
    expect(code.indexOf("add constraint reservations_org_contact_fkey")).toBeLessThan(code.indexOf("add constraint tasks_org_contact_fkey"));
  });

  it("run a second time, it stops in its preflight (the replaced keys are no longer there)", async () => {
    await rolledBack(async () => {
      await expect(o.query(file())).rejects.toThrow(/^0126 aborted: the foreign key from reservations to contacts is not 0044's reservations_contact_id_fkey/);
    });
  });

  // What the spy sees while the file is blocked is the proof that the LOCK
  // runs BEFORE the counts (and before the key and body guards — which is why
  // this runs at 0126 without a revert: the file never reaches them), in the
  // stated order: access exclusive granted on the three parents, waiting on
  // tasks, and NO other lock on tasks — two of the counts read tasks, so had
  // either run first, the file would hold AccessShareLock there (granted: it
  // does not conflict with the writer's RowExclusiveLock). The writer marks a
  // task done — what the tasks page does all day: it changes no key column,
  // so it holds tasks alone (an INSERT naming a contact or property would
  // also hold RowShareLock on that parent, and stop the file there instead).
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
      for (let i = 0; i < 60; i += 1) {
        seen = (
          await spy.query<{ relname: string; mode: string; granted: boolean }>(
            `select c.relname::text as relname, l.mode, l.granted from pg_locks l join pg_class c on c.oid = l.relation
              where l.pid = $1 and c.relname in ('reservations', 'properties', 'contacts', 'tasks')
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
        { relname: "contacts", mode: "AccessExclusiveLock", granted: true },
        { relname: "properties", mode: "AccessExclusiveLock", granted: true },
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
