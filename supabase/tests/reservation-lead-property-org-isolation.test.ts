import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { REVERT_0125_SQL, strip0125 } from "./revert-0125";
import { REVERT_0126_SQL, stripContactJoin0126 } from "./revert-0126";

/**
 * 0124: a reservation holds a property of its own organisation, an instalment
 * line belongs to a reservation of its own organisation, and a lead names a
 * property of its own; the reservation, instalment and lead-SLA sweeps and the
 * escalation preview read only their own organisation's parents. The
 * parent-link sequel of 0122 / 0123 (mandate-key-parent-org-isolation.test.ts,
 * viewing-parent-org-isolation.test.ts).
 *
 * THE GAP, as it stood at 0123 (measured through PostgREST): reservations.
 * property_id (0044), reservation_installments.reservation_id (0050) and
 * leads.property_id (0001) referenced their parent by id alone, and every
 * insert / update policy on the three tables checks only the CALLER's
 * organisation. So a member of B could put a hold on A's property — and,
 * held live, it answered 23505 through reservations_one_live_per_property
 * (unique on property_id alone) when A's property already had one, and it
 * blocked A's own hold; B could hang instalment lines on A's reservation —
 * blocking A's schedule through unique (reservation_id, sort_order); B could
 * name A's property on a lead. warn_expiring_reservations, remind_due_
 * installments and raise_lead_sla_tasks then minted B tasks (and events whose
 * entity is A's property) carrying A's reference, and preview_lead_escalation
 * showed B's admin A's reference. The tests marked "RED at 0123" failed
 * against 0123's catalogue before the migration; the rest pin what must not
 * change.
 *
 * TWO KINDS OF CALLER, as in 0119–0123: supabase-js through PostgREST (aal2
 * sessions), and one `pg` session as postgres — pg_cron's role — for
 * fixtures, verification, cleanup, the sweeps and the migration replays.
 * EVERY SWEEP AND REPLAY RUNS IN ONE TRANSACTION ROLLED BACK after its reads;
 * the malformed rows the sweep tests need are planted past the keys with
 * `session_replication_role = replica` inside it. The one exception is the
 * escalation preview, which only a signed-in admin can call: its plant is
 * committed, five minutes old (the lead-SLA cron waits sixty) and removed in
 * a finally block. This file is never pointed at hosted.
 *
 * TWO THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORGS = [ORG_A, ORG_B];
const RUN = Date.now().toString(36);

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, "..", "migrations", "0124_reservation_lead_property_org_isolation.sql");

/** The four bodies as 0052 / 0098 / 0112 wrote them (CR-stripped md5 of prosrc). */
const MD5 = {
  warn: "7d7c5420cf56897a509a886c37e2cda1",
  remind: "fd8fa594e8493a71981d606818c820e8",
  sla: "58e1a6990a7c2271787d29b8f131279a",
  preview: "4728c4a6c9a8df72b6d0b83102d946ea",
};
/** The lines 0124 adds (newline + indentation + predicate) and the one it swaps. */
const K = {
  pr: "\n       and p.org_id = r.org_id",
  ri: "\n       and r.org_id = i.org_id",
  lead: "\n       and p.org_id = l.org_id",
  prev: "\n       and pr.org_id = c.org_id",
  slaOld: "l.assigned_agent_id, l.property_id, p.reference",
  slaNew: "l.assigned_agent_id, p.id as property_id, p.reference",
};
const SIG = {
  warn: "public.warn_expiring_reservations(uuid)",
  remind: "public.remind_due_installments(uuid)",
  sla: "public.raise_lead_sla_tasks(uuid, integer)",
  preview: "public.preview_lead_escalation(jsonb, integer, timestamp with time zone)",
};

let o: Client;
let svc: SupabaseClient;

let adminA: TestUser;
let agentA: TestUser;
let adminB: TestUser;
let agentB: TestUser;
let lmB: TestUser;
const userIds: string[] = [];
let n = 0;

type Parent = { id: string; reference: string };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function newProperty(org: string): Promise<Parent> {
  n += 1;
  const { rows } = await o.query<Parent>(
    `insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id, reference`,
    [org, `RLP${RUN}${n}`.toUpperCase()],
  );
  return rows[0]!;
}

async function newContact(org: string) {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into contacts (org_id, first_name) values ($1, $2) returning id`,
    [org, `ZZTEST Buyer${n} ${RUN}`],
  );
  return rows[0]!.id;
}

/** Inside the caller's transaction: this one statement past the keys, then back. */
async function planted<T>(sql: string, params: unknown[]): Promise<T> {
  await o.query("set local session_replication_role = replica");
  try {
    return (await o.query(sql, params)).rows[0] as T;
  } finally {
    await o.query("set local session_replication_role = origin");
  }
}

type HoldOpts = { status?: string; expiresInHours?: number; createdBy?: string | null; contact?: string | null; plant?: boolean };
async function newHold(org: string, property: string, opts: HoldOpts = {}) {
  const sql = `insert into reservations (org_id, property_id, contact_id, status, held_from, expires_at, created_by)
               values ($1, $2, $3, $4::reservation_status, now() - interval '1 day', now() + make_interval(hours => $5::int), $6)
               returning id`;
  const params = [org, property, opts.contact ?? null, opts.status ?? "held", opts.expiresInHours ?? 24 * 10, opts.createdBy ?? null];
  if (opts.plant) return (await planted<{ id: string }>(sql, params)).id;
  return (await o.query<{ id: string }>(sql, params)).rows[0]!.id;
}

async function newLine(org: string, reservation: string, sort: number, opts: { dueInDays?: number | null; plant?: boolean } = {}) {
  const sql = `insert into reservation_installments (org_id, reservation_id, sort_order, label, amount, due_date)
               values ($1, $2, $3, $4, 1000, case when $5::int is null then null else current_date + $5::int end) returning id`;
  const params = [org, reservation, sort, `Line ${sort}`, opts.dueInDays === undefined ? 3 : opts.dueInDays];
  if (opts.plant) return (await planted<{ id: string }>(sql, params)).id;
  return (await o.query<{ id: string }>(sql, params)).rows[0]!.id;
}

async function newLead(
  org: string,
  property: string | null,
  opts: { minutesAgo?: number; receivedAt?: string; source?: string; plant?: boolean } = {},
) {
  const sql = `insert into leads (org_id, property_id, source, status, received_at)
               values ($1, $2, $3::lead_source, 'new', coalesce($5::timestamptz, now() - make_interval(mins => $4::int))) returning id`;
  const params = [org, property, opts.source ?? "website", opts.minutesAgo ?? 5, opts.receivedAt ?? null];
  if (opts.plant) return (await planted<{ id: string }>(sql, params)).id;
  return (await o.query<{ id: string }>(sql, params)).rows[0]!.id;
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

async function tasksWhere(column: "reservation_id" | "installment_id" | "lead_id", id: string) {
  const { rows } = await o.query<{ id: string; org_id: string; kind: string; title: string; property_id: string | null; is_done: boolean }>(
    `select id, org_id, kind, title, property_id, is_done from tasks where ${column} = $1 order by created_at, id`,
    [id],
  );
  return rows;
}

async function chainOk(org: string) {
  const { rows } = await o.query<{ ok: boolean }>("select public.verify_events_chain($1) as ok", [org]);
  return rows[0]!.ok;
}

/** Nothing of B's — task, or event (payload OR entity) — names or carries A's property `p`. */
async function bHoldsNothingOf(p: Parent) {
  expect(
    await count(`select count(*)::int as c from tasks where org_id = $1 and (property_id = $2 or position($3 in title) > 0)`, [ORG_B, p.id, p.reference]),
    "no task of B names A's property or carries its reference",
  ).toBe(0);
  expect(
    await count(
      `select count(*)::int as c from events
        where org_id = $1 and (entity_id = $2 or payload::text like '%' || $2::text || '%' or payload::text like '%' || $3 || '%')`,
      [ORG_B, p.id, p.reference],
    ),
    "no event of B is about A's property or carries its id or reference",
  ).toBe(0);
}

async function keysOf(table: string) {
  const { rows } = await o.query<{ conname: string; def: string; convalidated: boolean }>(
    `select conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint
      where conrelid = $1::regclass and contype = 'f'
        and confrelid in ('public.properties'::regclass, 'public.reservations'::regclass)
      order by conname`,
    [table],
  );
  return rows;
}

async function bodyMd5(sig: string) {
  const { rows } = await o.query<{ m: string }>("select md5(replace(prosrc, E'\\r', '')) as m from pg_proc where oid = $1::regprocedure", [sig]);
  return rows[0]!.m;
}

async function bodyOf(sig: string) {
  const { rows } = await o.query<{ s: string }>("select replace(prosrc, E'\\r', '') as s from pg_proc where oid = $1::regprocedure", [sig]);
  return rows[0]!.s;
}

/**
 * The body with 0124's lines taken out (and the SLA select swapped back): must
 * be the old one. 0126's contact join (revert-0126.ts) and 0125's task-side
 * lines (revert-0125.ts), which sit in some of these bodies since then, come
 * out first, newest first — each a no-op on a body without them.
 */
function strip(body: string) {
  return strip0125(stripContactJoin0126(body))
    .split(K.pr).join("").split(K.ri).join("").split(K.lead).join("").split(K.prev).join("").split(K.slaNew).join(K.slaOld);
}

const md5 = async (s: string) => (await o.query<{ m: string }>("select md5($1) as m", [s])).rows[0]!.m;

/**
 * 0123's catalogue for this file's objects, inside the caller's transaction.
 * 0126 and then 0125 come off first: 0125's task keys depend on
 * reservations_org_id_id_key, and both files' lines sit in the bodies
 * restored below (each a no-op on a database without it).
 */
async function revertTo0123() {
  await o.query(REVERT_0126_SQL);
  await o.query(REVERT_0125_SQL);
  await o.query(`
    alter table public.reservation_installments drop constraint reservation_installments_org_reservation_fkey;
    alter table public.reservation_installments drop constraint reservation_installments_org_reservation_sort_order_key;
    alter table public.reservation_installments add constraint reservation_installments_reservation_id_sort_order_key unique (reservation_id, sort_order);
    alter table public.reservation_installments add constraint reservation_installments_reservation_id_fkey
      foreign key (reservation_id) references public.reservations(id) on delete cascade;
    alter table public.reservations drop constraint reservations_org_property_fkey;
    drop index public.reservations_org_property_idx;
    drop index public.reservations_one_live_per_property;
    create unique index reservations_one_live_per_property on public.reservations (property_id) where status in ('held', 'confirmed');
    alter table public.reservations add constraint reservations_property_id_fkey
      foreign key (property_id) references public.properties(id) on delete restrict;
    alter table public.reservations drop constraint reservations_org_id_id_key;
    alter table public.leads drop constraint leads_org_property_fkey;
    drop index public.leads_org_property_idx;
    alter table public.leads add constraint leads_property_id_fkey foreign key (property_id) references public.properties(id);
    do $$
    declare b text;
    begin
      select prosrc into b from pg_proc where oid = 'public.warn_expiring_reservations(uuid)'::regprocedure;
      execute format('create or replace function public.warn_expiring_reservations(p_org uuid default null) returns void '
                     'language sql security definer set search_path = public as %L',
                     replace(b, E'\\n       and p.org_id = r.org_id', ''));
      select prosrc into b from pg_proc where oid = 'public.remind_due_installments(uuid)'::regprocedure;
      execute format('create or replace function public.remind_due_installments(p_org uuid default null) returns void '
                     'language sql security definer set search_path = public as %L',
                     replace(replace(b, E'\\n       and p.org_id = r.org_id', ''), E'\\n       and r.org_id = i.org_id', ''));
      select prosrc into b from pg_proc where oid = 'public.raise_lead_sla_tasks(uuid, integer)'::regprocedure;
      execute format('create or replace function public.raise_lead_sla_tasks(p_org uuid default null, p_minutes int default 60) returns int '
                     'language plpgsql security definer set search_path = public as %L',
                     replace(replace(b, E'\\n       and p.org_id = l.org_id', ''),
                             'l.assigned_agent_id, p.id as property_id, p.reference', 'l.assigned_agent_id, l.property_id, p.reference'));
      select prosrc into b from pg_proc where oid = 'public.preview_lead_escalation(jsonb, integer, timestamp with time zone)'::regprocedure;
      execute format('create or replace function public.preview_lead_escalation(p_policy jsonb, p_limit int default 50, p_now timestamptz default now()) '
                     'returns jsonb language plpgsql stable security definer set search_path = public as %L',
                     replace(b, E'\\n       and pr.org_id = c.org_id', ''));
      -- CREATE OR REPLACE keeps comments: back to 0123's (none on the two
      -- 0052 sweeps; 0098's and 0112's text without 0124's sentence)
      execute 'comment on function public.warn_expiring_reservations(uuid) is null';
      execute 'comment on function public.remind_due_installments(uuid) is null';
      execute format('comment on function public.raise_lead_sla_tasks(uuid, int) is %L',
                     split_part(obj_description('public.raise_lead_sla_tasks(uuid, integer)'::regprocedure, 'pg_proc'), ' Since 0124', 1));
      execute format('comment on function public.preview_lead_escalation(jsonb, int, timestamptz) is %L',
                     split_part(obj_description('public.preview_lead_escalation(jsonb, integer, timestamp with time zone)'::regprocedure, 'pg_proc'), ' Since 0124', 1));
    end $$;
  `);
}

/** The four functions' comments: null for the 0052 sweeps at 0123, and no 0124 sentence anywhere. */
async function commentsAre0123() {
  const { rows } = await o.query<{ c: string | null }>(
    "select obj_description(p.oid, 'pg_proc') as c from pg_proc p where p.oid = any($1::regprocedure[]) order by p.proname collate \"C\"",
    [[SIG.preview, SIG.sla, SIG.remind, SIG.warn]],
  );
  // order: preview, raise_lead_sla, remind, warn
  expect(rows[2]!.c, "remind at 0123 has no comment").toBeNull();
  expect(rows[3]!.c, "warn at 0123 has no comment").toBeNull();
  for (const r of rows.slice(0, 2)) {
    expect(r.c).not.toBeNull();
    expect(r.c).not.toContain("0124");
  }
}

const KEYS_0124 = {
  reservations: [{ conname: "reservations_org_property_fkey", def: "FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE RESTRICT", convalidated: true }],
  installments: [
    {
      conname: "reservation_installments_org_reservation_fkey",
      def: "FOREIGN KEY (org_id, reservation_id) REFERENCES reservations(org_id, id) ON DELETE CASCADE",
      convalidated: true,
    },
  ],
  leads: [{ conname: "leads_org_property_fkey", def: "FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id)", convalidated: true }],
};
const KEYS_0123 = {
  reservations: [{ conname: "reservations_property_id_fkey", def: "FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE RESTRICT", convalidated: true }],
  installments: [
    { conname: "reservation_installments_reservation_id_fkey", def: "FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE", convalidated: true },
  ],
  leads: [{ conname: "leads_property_id_fkey", def: "FOREIGN KEY (property_id) REFERENCES properties(id)", convalidated: true }],
};
async function allKeys() {
  return {
    reservations: await keysOf("public.reservations"),
    installments: await keysOf("public.reservation_installments"),
    leads: await keysOf("public.leads"),
  };
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  // a killed earlier run of THIS file can leave the preview test's committed
  // plant behind (dated 2099, so no cron ever tasks it): remove this file's
  // own throwaway organisations' leftovers only — never every cross-org row
  // in the database (that is what the restore pack's INTEGRITY rows report)
  const { rows: stale } = await o.query<{ id: string }>("select id from organizations where name like 'res-lead %'");
  const staleOrgs = stale.map((r) => r.id);
  if (staleOrgs.length) {
    await o.query("delete from tasks where org_id = any($1::uuid[])", [staleOrgs]);
    await o.query("delete from leads where org_id = any($1::uuid[])", [staleOrgs]);
  }

  await ensureTestOrg(svc, ORG_A, `res-lead A ${RUN}`, `res-lead-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `res-lead B ${RUN}`, `res-lead-b-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors ({} messages)
  adminA = await createTestUser(svc, `rlp-admin-a-${RUN}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `rlp-agent-a-${RUN}@test.local`, "agent", ORG_A);
  adminB = await createTestUser(svc, `rlp-admin-b-${RUN}@test.local`, "admin", ORG_B);
  agentB = await createTestUser(svc, `rlp-agent-b-${RUN}@test.local`, "agent", ORG_B);
  lmB = await createTestUser(svc, `rlp-lm-b-${RUN}@test.local`, "listing_manager", ORG_B);
  userIds.push(adminA.id, agentA.id, adminB.id, agentB.id, lmB.id);
});

afterAll(async () => {
  await o.query("delete from tasks where org_id = any($1::uuid[])", [ORGS]);
  // one statement each: rows of either organisation may name the other's parents
  await o.query("delete from reservation_installments where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from reservations where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from notification_jobs where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from leads where org_id = any($1::uuid[])", [ORGS]);
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
describe("the premise: organisation B cannot read A's property, reservation or lead", () => {
  it("B's admin sees none of them; A's admin does", async () => {
    const p = await newProperty(ORG_A);
    const r = await newHold(ORG_A, p.id);
    const l = await newLead(ORG_A, p.id, { source: "phone" });
    for (const c of [adminB.client, agentB.client]) {
      expect((await c.from("properties").select("id").eq("id", p.id)).data).toEqual([]);
      expect((await c.from("reservations").select("id").eq("id", r)).data).toEqual([]);
      expect((await c.from("leads").select("id").eq("id", l)).data).toEqual([]);
    }
    expect((await adminA.client.from("reservations").select("id").eq("id", r)).data).toEqual([{ id: r }]);
  });
});

describe("B cannot hold A's property (23503, nothing written) — RED at 0123", () => {
  /** createReservation's insert (lib/actions/reservations.ts), as B's session sends it. */
  const holdShape = (who: TestUser, property: string, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    property_id: property,
    contact_id: null,
    deal_id: null,
    offer_id: null,
    status: "held",
    amount: null,
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    notes: null,
    created_by: who.id,
    ...extra,
  });

  it("INSERT — as B's admin, agent and listing manager (reservations_insert checks only the org)", async () => {
    const p = await newProperty(ORG_A);
    for (const who of [adminB, agentB, lmB]) {
      const r = await who.client.from("reservations").insert(holdShape(who, p.id)).select("id");
      expect(r.error?.code, who.email).toBe("23503");
    }
    expect(await count("select count(*)::int as c from reservations where property_id = $1", [p.id])).toBe(0);
  });

  it("UPDATE and UPSERT — B's hold on B's property cannot be re-pointed at A's", async () => {
    const pa = await newProperty(ORG_A);
    const pb = await newProperty(ORG_B);
    const mine = await newHold(ORG_B, pb.id);
    const upd = await adminB.client.from("reservations").update({ property_id: pa.id }).eq("id", mine).select("id");
    expect(upd.error?.code).toBe("23503");
    const ups = await agentB.client.from("reservations").upsert({ id: mine, ...holdShape(agentB, pa.id) }, { onConflict: "id" }).select("id");
    expect(ups.error?.code).toBe("23503");
    const fresh = randomUUID();
    const ins = await agentB.client.from("reservations").upsert({ id: fresh, ...holdShape(agentB, pa.id) }, { onConflict: "id" }).select("id");
    expect(ins.error?.code).toBe("23503");
    expect(await row("select id from reservations where id = $1", [fresh])).toBeNull();
    expect((await row<{ property_id: string }>("select property_id from reservations where id = $1", [mine]))!.property_id).toBe(pb.id);
  });

  it("A can still hold its own property: B's live hold can no longer occupy it (23505 at 0123)", async () => {
    const p = await newProperty(ORG_A);
    await adminB.client.from("reservations").insert(holdShape(adminB, p.id)).select("id");
    const mine = await adminA.client
      .from("reservations")
      .insert({ ...holdShape(adminA, p.id), org_id: ORG_A })
      .select("id");
    expect(mine.error, "no foreign hold occupies A's one live slot").toBeNull();
  });

  it("B's LIVE hold on an A property that already has one reads the same 23503 as on one that has none — no oracle on A's hold (23505 at 0123)", async () => {
    const busy = await newProperty(ORG_A);
    await newHold(ORG_A, busy.id);
    const idle = await newProperty(ORG_A);
    const a = await agentB.client.from("reservations").insert(holdShape(agentB, busy.id)).select("id");
    const b = await agentB.client.from("reservations").insert(holdShape(agentB, idle.id)).select("id");
    expect(a.error?.code, "A's property under a live hold").toBe("23503");
    expect(b.error?.code, "A's property with none").toBe("23503");
    expect(a.error?.message).toBe(b.error?.message);
    // and A's own second live hold on the busy property still meets the rule
    // (createReservation turns this 23505 into "already has a live reservation")
    const second = await adminA.client.from("reservations").insert({ ...holdShape(adminA, busy.id), org_id: ORG_A }).select("id");
    expect(second.error?.code).toBe("23505");
  });

  it("the key's refusal no longer tells B whether an A property id exists, and carries nothing of A's", async () => {
    const p = await newProperty(ORG_A);
    const missing = randomUUID();
    const a = await agentB.client.from("reservations").insert(holdShape(agentB, p.id)).select("id");
    const b = await agentB.client.from("reservations").insert(holdShape(agentB, missing)).select("id");
    expect(a.error?.code).toBe("23503");
    expect(b.error?.code).toBe("23503");
    expect(a.error?.message).toBe(b.error?.message);
    expect((a.error?.details ?? "").replace(p.id, "<id>")).toBe((b.error?.details ?? "").replace(missing, "<id>"));
    for (const secret of [ORG_A, p.reference]) expect(JSON.stringify(a.error)).not.toContain(secret);
  });

  it("the service role and the table owner are refused; a hold's organisation cannot move off its property's, nor the property's off its holds", async () => {
    const pa = await newProperty(ORG_A);
    const s = await svc.from("reservations").insert({ org_id: ORG_B, property_id: pa.id, expires_at: new Date(Date.now() + 86_400_000).toISOString() }).select("id");
    expect(s.error?.code).toBe("23503");
    await expect(newHold(ORG_B, pa.id)).rejects.toMatchObject({ code: "23503", constraint: "reservations_org_property_fkey" });
    const mine = await newHold(ORG_A, pa.id, { status: "released" });
    expect((await svc.from("reservations").update({ org_id: ORG_B }).eq("id", mine).select("id")).error?.code).toBe("23503");
    expect((await svc.from("properties").update({ org_id: ORG_B }).eq("id", pa.id).select("id")).error?.code).toBe("23503");
    expect((await row<{ org_id: string }>("select org_id from properties where id = $1", [pa.id]))!.org_id).toBe(ORG_A);
  });
});

describe("B cannot hang instalment lines on A's reservation (23503) — RED at 0123", () => {
  /** applyPaymentPlan's line insert (lib/actions/reservation-schedule.ts), as B's session sends it. */
  const lineShape = (who: TestUser, reservation: string, sort: number) => ({
    org_id: ORG_B,
    reservation_id: reservation,
    sort_order: sort,
    label: `ZZTEST line ${sort}`,
    pct: null,
    amount: 1000,
    milestone: null,
    created_by: who.id,
  });

  it("INSERT, UPDATE and UPSERT are refused, nothing written", async () => {
    const ra = await newHold(ORG_A, (await newProperty(ORG_A)).id);
    const ins = await adminB.client.from("reservation_installments").insert(lineShape(adminB, ra, 90)).select("id");
    expect(ins.error?.code).toBe("23503");
    const rb = await newHold(ORG_B, (await newProperty(ORG_B)).id);
    const mine = await newLine(ORG_B, rb, 1);
    const upd = await adminB.client.from("reservation_installments").update({ reservation_id: ra }).eq("id", mine).select("id");
    expect(upd.error?.code).toBe("23503");
    const ups = await adminB.client.from("reservation_installments").upsert({ id: mine, ...lineShape(adminB, ra, 91) }, { onConflict: "id" }).select("id");
    expect(ups.error?.code).toBe("23503");
    expect(await count("select count(*)::int as c from reservation_installments where reservation_id = $1", [ra])).toBe(0);
  });

  it("a line at a sort_order A's schedule already uses reads the same 23503 as a free one — no oracle on A's schedule (23505 at 0123)", async () => {
    const ra = await newHold(ORG_A, (await newProperty(ORG_A)).id);
    await newLine(ORG_A, ra, 1);
    const taken = await adminB.client.from("reservation_installments").insert(lineShape(adminB, ra, 1)).select("id");
    const free = await adminB.client.from("reservation_installments").insert(lineShape(adminB, ra, 2)).select("id");
    expect(taken.error?.code, "sort_order A uses").toBe("23503");
    expect(free.error?.code, "a free sort_order").toBe("23503");
    expect(taken.error?.message).toBe(free.error?.message);
  });

  it("B's lines can no longer block A applying a payment plan (A's insert met 23505 at 0123)", async () => {
    const ra = await newHold(ORG_A, (await newProperty(ORG_A)).id);
    for (const s of [1, 2, 3]) await adminB.client.from("reservation_installments").insert(lineShape(adminB, ra, s));
    const mine = await adminA.client
      .from("reservation_installments")
      .insert([1, 2, 3].map((s) => ({ ...lineShape(adminA, ra, s), org_id: ORG_A })))
      .select("id");
    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(3);
  });

  it("the service role and the owner are refused; a line's organisation cannot move off its reservation's", async () => {
    const ra = await newHold(ORG_A, (await newProperty(ORG_A)).id);
    const s = await svc.from("reservation_installments").insert({ org_id: ORG_B, reservation_id: ra, sort_order: 5, label: "x", amount: 1 }).select("id");
    expect(s.error?.code).toBe("23503");
    await expect(newLine(ORG_B, ra, 6)).rejects.toMatchObject({ code: "23503", constraint: "reservation_installments_org_reservation_fkey" });
    const line = await newLine(ORG_A, ra, 7);
    expect((await svc.from("reservation_installments").update({ org_id: ORG_B }).eq("id", line).select("id")).error?.code).toBe("23503");
  });
});

describe("B cannot name A's property on a lead (23503) — RED at 0123", () => {
  /** createLead's insert (lib/actions/leads.ts), as B's session sends it. */
  const leadShape = (property: string | null, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    source: "phone",
    channel: null,
    message: null,
    contact_id: null,
    property_id: property,
    ...extra,
  });

  it("INSERT as B's agent, admin and listing manager, UPDATE and UPSERT are refused; a lead with no property is fine", async () => {
    const pa = await newProperty(ORG_A);
    for (const who of [agentB, adminB, lmB]) {
      const r = await who.client.from("leads").insert(leadShape(pa.id)).select("id");
      expect(r.error?.code, who.email).toBe("23503");
    }
    const none = await agentB.client.from("leads").insert(leadShape(null)).select("id").single();
    expect(none.error).toBeNull();
    const upd = await adminB.client.from("leads").update({ property_id: pa.id }).eq("id", none.data!.id).select("id");
    expect(upd.error?.code).toBe("23503");
    const ups = await adminB.client.from("leads").upsert({ id: none.data!.id, ...leadShape(pa.id) }, { onConflict: "id" }).select("id");
    expect(ups.error?.code).toBe("23503");
    expect(await count("select count(*)::int as c from leads where property_id = $1", [pa.id])).toBe(0);
  });

  it("the key's refusal no longer tells B whether an A property id exists; the service role and the owner are refused; the org cannot move", async () => {
    const pa = await newProperty(ORG_A);
    const missing = randomUUID();
    const a = await agentB.client.from("leads").insert(leadShape(pa.id)).select("id");
    const b = await agentB.client.from("leads").insert(leadShape(missing)).select("id");
    expect(a.error?.code).toBe("23503");
    expect(b.error?.code).toBe("23503");
    expect(a.error?.message).toBe(b.error?.message);
    expect(JSON.stringify(a.error)).not.toContain(pa.reference);
    expect((await svc.from("leads").insert({ org_id: ORG_B, property_id: pa.id }).select("id")).error?.code).toBe("23503");
    await expect(newLead(ORG_B, pa.id)).rejects.toMatchObject({ code: "23503", constraint: "leads_org_property_fkey" });
    const mine = await newLead(ORG_A, pa.id, { source: "phone" });
    expect((await svc.from("leads").update({ org_id: ORG_B }).eq("id", mine).select("id")).error?.code).toBe("23503");
  });
});

describe("same-organisation links, embeds and deletion stay as they were", () => {
  it("A holds its property (createReservation's shape), applies a schedule, re-points within A, logs a lead on it", async () => {
    const p1 = await newProperty(ORG_A);
    const p2 = await newProperty(ORG_A);
    const hold = await agentA.client
      .from("reservations")
      .insert({ org_id: ORG_A, property_id: p1.id, status: "held", expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), created_by: agentA.id })
      .select("id")
      .single();
    expect(hold.error).toBeNull();
    const lines = await agentA.client
      .from("reservation_installments")
      .insert([1, 2].map((s) => ({ org_id: ORG_A, reservation_id: hold.data!.id, sort_order: s, label: `L${s}`, amount: 500, created_by: agentA.id })))
      .select("id");
    expect(lines.error).toBeNull();
    const moved = await adminA.client.from("reservations").update({ property_id: p2.id }).eq("id", hold.data!.id).select("id");
    expect(moved.error).toBeNull();
    expect(moved.data).toEqual([{ id: hold.data!.id }]);
    const lead = await agentA.client.from("leads").insert({ org_id: ORG_A, source: "phone", property_id: p2.id }).select("id").single();
    expect(lead.error).toBeNull();
  });

  it("PostgREST embeds keep ONE relationship each way (no PGRST201)", async () => {
    const p = await newProperty(ORG_A);
    const r = await newHold(ORG_A, p.id);
    const line = await newLine(ORG_A, r, 1);
    const l = await newLead(ORG_A, p.id, { source: "phone" });
    const fromHold = await adminA.client.from("reservations").select("id, properties(reference), reservation_installments(id, sort_order)").eq("id", r).single();
    expect(fromHold.error).toBeNull();
    expect((fromHold.data as unknown as { properties: { reference: string } }).properties.reference).toBe(p.reference);
    const fromLine = await adminA.client.from("reservation_installments").select("id, reservations(id, property_id)").eq("id", line).single();
    expect(fromLine.error).toBeNull();
    expect((fromLine.data as unknown as { reservations: { id: string } }).reservations.id).toBe(r);
    // app/(app)/leads/page.tsx and lib/services/lead-export.ts
    const fromLead = await adminA.client.from("leads").select("id, properties(id, reference)").eq("id", l).single();
    expect(fromLead.error).toBeNull();
    expect((fromLead.data as unknown as { properties: { reference: string } }).properties.reference).toBe(p.reference);
    const fromProperty = await adminA.client.from("properties").select("id, reservations(id), leads(id)").eq("id", p.id).single();
    expect(fromProperty.error).toBeNull();
  });

  it("deletion: a property with a hold or a lead cannot be deleted (RESTRICT / NO ACTION); a reservation takes its lines with it (CASCADE)", async () => {
    const p = await newProperty(ORG_A);
    const r = await newHold(ORG_A, p.id, { status: "released" });
    const line = await newLine(ORG_A, r, 1);
    await expect(o.query("delete from properties where id = $1", [p.id])).rejects.toMatchObject({
      code: "23503",
      constraint: expect.stringMatching(/^reservations_(org_property|property_id)_fkey$/),
    });
    await o.query("delete from reservations where id = $1", [r]);
    expect(await row("select id from reservation_installments where id = $1", [line])).toBeNull();
    const p2 = await newProperty(ORG_A);
    await newLead(ORG_A, p2.id, { source: "phone" });
    await expect(o.query("delete from properties where id = $1", [p2.id])).rejects.toMatchObject({
      code: "23503",
      constraint: expect.stringMatching(/^leads_(org_property|property_id)_fkey$/),
    });
  });
});

describe("the sweeps read only their own organisation's parents (rows planted past the keys, rolled back) — RED at 0123", () => {
  it("warn_expiring_reservations: B's hold planted on A's property earns B nothing naming it; B's own and A's own holds are served", async () => {
    await rolledBack(async () => {
      const pa = await newProperty(ORG_A);
      const pa2 = await newProperty(ORG_A);
      const pb = await newProperty(ORG_B);
      const plant = await newHold(ORG_B, pa.id, { expiresInHours: 24, plant: true });
      const own = await newHold(ORG_B, pb.id, { expiresInHours: 24 });
      const theirs = await newHold(ORG_A, pa2.id, { expiresInHours: 24 });
      await o.query("select public.warn_expiring_reservations()");
      await o.query("select public.warn_expiring_reservations()");
      expect(await tasksWhere("reservation_id", plant), "no reminder for a hold on another organisation's property").toEqual([]);
      await bHoldsNothingOf(pa);
      expect((await tasksWhere("reservation_id", own)).map((t) => [t.org_id, t.kind, t.property_id])).toEqual([[ORG_B, "reservation_expiring", pb.id]]);
      expect((await tasksWhere("reservation_id", theirs)).map((t) => [t.org_id, t.property_id])).toEqual([[ORG_A, pa2.id]]);
      expect((await tasksWhere("reservation_id", own))[0]!.title).toContain(`Reservation on ${pb.reference} lapses`);
      expect(await chainOk(ORG_A)).toBe(true);
      expect(await chainOk(ORG_B)).toBe(true);
    });
  });

  it("remind_due_installments, first hop: B's line planted on A's reservation earns B nothing naming A's property", async () => {
    await rolledBack(async () => {
      const pa = await newProperty(ORG_A);
      const ra = await newHold(ORG_A, pa.id);
      const plant = await newLine(ORG_B, ra, 50, { plant: true });
      const pb = await newProperty(ORG_B);
      const own = await newLine(ORG_B, await newHold(ORG_B, pb.id), 1);
      await o.query("select public.remind_due_installments($1::uuid)", [ORG_B]);
      expect(await tasksWhere("installment_id", plant)).toEqual([]);
      await bHoldsNothingOf(pa);
      expect((await tasksWhere("installment_id", own)).map((t) => [t.org_id, t.kind, t.property_id])).toEqual([[ORG_B, "installment_due", pb.id]]);
    });
  });

  it("remind_due_installments, second hop: B's own line on B's hold planted on A's property earns B nothing naming it", async () => {
    await rolledBack(async () => {
      const pa = await newProperty(ORG_A);
      const holdOnA = await newHold(ORG_B, pa.id, { plant: true });
      const line = await newLine(ORG_B, holdOnA, 1);
      // the control: the same line on B's own hold of B's own property, same
      // due date — it MUST be reminded, or the empty result above could just
      // mean the configured window (installment_due_days) excludes the date
      const pb = await newProperty(ORG_B);
      const control = await newLine(ORG_B, await newHold(ORG_B, pb.id), 1);
      await o.query("select public.remind_due_installments()");
      expect(await tasksWhere("installment_id", line)).toEqual([]);
      expect((await tasksWhere("installment_id", control)).map((t) => [t.org_id, t.property_id])).toEqual([[ORG_B, pb.id]]);
      await bHoldsNothingOf(pa);
    });
  });

  it("remind_due_installments, self-heal: A's reservation ending does not complete B's reminder on a line planted there (no oracle on A's hold)", async () => {
    await rolledBack(async () => {
      const pa = await newProperty(ORG_A);
      const ra = await newHold(ORG_A, pa.id, { status: "released" });
      const plant = await newLine(ORG_B, ra, 60, { plant: true });
      const { rows } = await o.query<{ due: string }>("select due_date::text as due from reservation_installments where id = $1", [plant]);
      const task = (
        await o.query<{ id: string }>(
          `insert into tasks (org_id, title, due_at, installment_id, kind)
           values ($1, 'ZZTEST planted reminder', ($2::date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia', $3, 'installment_due')
           returning id`,
          [ORG_B, rows[0]!.due, plant],
        )
      ).rows[0]!.id;
      await o.query("select public.remind_due_installments()");
      expect((await row<{ is_done: boolean }>("select is_done from tasks where id = $1", [task]))!.is_done, "B's task is not closed by A's hold").toBe(false);
      expect(await count("select count(*)::int as c from events where org_id = $1 and entity_id = $2", [ORG_B, task])).toBe(0);
    });
  });

  it("raise_lead_sla_tasks: B's lead planted on A's property is still chased — without A's reference or property", async () => {
    await rolledBack(async () => {
      const pa = await newProperty(ORG_A);
      const pb = await newProperty(ORG_B);
      const plant = await newLead(ORG_B, pa.id, { minutesAgo: 120, plant: true });
      const own = await newLead(ORG_B, pb.id, { minutesAgo: 120 });
      const bare = await newLead(ORG_B, null, { minutesAgo: 120 });
      await o.query("select public.raise_lead_sla_tasks($1::uuid, 60)", [ORG_B]);
      await o.query("select public.raise_lead_sla_tasks($1::uuid, 60)", [ORG_B]);
      expect((await tasksWhere("lead_id", plant)).map((t) => [t.title, t.property_id])).toEqual([["Website enquiry unanswered for over an hour", null]]);
      expect((await tasksWhere("lead_id", own)).map((t) => [t.title, t.property_id])).toEqual([[`Website enquiry unanswered for over an hour: ${pb.reference}`, pb.id]]);
      expect((await tasksWhere("lead_id", bare)).map((t) => [t.title, t.property_id])).toEqual([["Website enquiry unanswered for over an hour", null]]);
      await bHoldsNothingOf(pa);
    });
  });

  it("preview_lead_escalation (a B admin's session): a lead planted on A's property shows no property reference; B's own shows its own", async () => {
    const pa = await newProperty(ORG_A);
    const pb = await newProperty(ORG_B);
    // Dated 2099 (lead-escalation-preview.test.ts's idiom): still a candidate
    // (verdict not_yet_due, listed with its property_ref), and no cron can
    // ever reach it — the lead-SLA sweep wants received_at an hour AGO — so
    // even a killed run leaves nothing that a sweep would task.
    const FUTURE = "2099-09-28T06:20:00Z";
    const made: string[] = [];
    let plant = "";
    let own = "";
    try {
      await o.query("begin");
      try {
        plant = await newLead(ORG_B, pa.id, { plant: true, receivedAt: FUTURE });
        made.push(plant);
        own = await newLead(ORG_B, pb.id, { receivedAt: FUTURE });
        made.push(own);
        await o.query("commit");
      } catch (e) {
        await o.query("rollback");
        made.length = 0;
        throw e;
      }
      const { data, error } = await adminB.client.rpc("preview_lead_escalation", {
        p_policy: {
          enabled: false,
          after_minutes: 15,
          max_age_hours: 48,
          recipients: [adminB.id],
          // lead-escalation-preview.test.ts's shape; the verdict does not
          // matter here — every candidate is listed with its property_ref
          working_hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
          timezone: "Asia/Nicosia",
        },
      } as never);
      expect(error).toBeNull();
      const leads = (data as { leads: { lead_id: string; property_ref: string | null }[] }).leads;
      expect(leads.find((l) => l.lead_id === plant)?.property_ref, "listed, without A's reference").toBeNull();
      expect(leads.find((l) => l.lead_id === own)?.property_ref).toBe(pb.reference);
      expect(JSON.stringify(data)).not.toContain(pa.reference);
    } finally {
      if (made.length) await o.query("delete from leads where id = any($1::uuid[])", [made]);
    }
  });
});

describe("the sweeps still serve both organisations exactly as before (same-organisation behaviour 0123 already had — not RED)", () => {
  it("valid reminders for BOTH organisations, global runs twice: one task and one event each, the property's own event, due dates", async () => {
    await rolledBack(async () => {
      const made: { org: string; hold: string; line: string; p: Parent }[] = [];
      for (const org of ORGS) {
        const p = await newProperty(org);
        const hold = await newHold(org, p.id, { expiresInHours: 24, contact: await newContact(org) });
        const line = await newLine(org, hold, 1, { dueInDays: 2 });
        made.push({ org, hold, line, p });
      }
      for (let i = 0; i < 2; i += 1) {
        await o.query("select public.warn_expiring_reservations()");
        await o.query("select public.remind_due_installments()");
      }
      for (const m of made) {
        expect((await tasksWhere("reservation_id", m.hold)).filter((t) => t.kind === "reservation_expiring")).toHaveLength(1);
        expect(await tasksWhere("installment_id", m.line)).toHaveLength(1);
        expect(
          await count(
            `select count(*)::int as c from events where org_id = $1 and entity_type = 'property' and entity_id = $2
               and event_type in ('reservation_expiring_soon', 'installment_due_soon')`,
            [m.org, m.p.id],
          ),
          "one warning and one instalment event, on the hold's own property, in its own organisation",
        ).toBe(2);
        const { rows } = await o.query<{ ok: boolean }>(
          `select (select (t.due_at at time zone 'Asia/Nicosia')::date = i.due_date from tasks t join reservation_installments i on i.id = t.installment_id where i.id = $1)
               and (select (t.due_at at time zone 'Asia/Nicosia')::date = (r.expires_at at time zone 'Asia/Nicosia')::date
                      from tasks t join reservations r on r.id = t.reservation_id where r.id = $2 and t.kind = 'reservation_expiring') as ok`,
          [m.line, m.hold],
        );
        expect(rows[0]!.ok).toBe(true);
        expect(await chainOk(m.org)).toBe(true);
      }
    });
  });
});

describe("the catalogue: three tenant-bound, validated relationships and two re-keyed unique rules — RED at 0123", () => {
  it("each link is ONE composite key (validated, the delete rule kept), the old keys gone; the unique rules keyed by organisation; the earlier tenant keys untouched", async () => {
    expect(await allKeys()).toEqual(KEYS_0124);
    const { rows: idx } = await o.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'public'
          and indexname in ('reservations_one_live_per_property', 'reservations_org_property_idx', 'leads_org_property_idx',
                            'reservation_installments_org_reservation_sort_order_key', 'reservations_org_id_id_key')
        order by indexname collate "C"`,
    );
    expect(idx.map((i) => i.indexdef)).toEqual([
      "CREATE INDEX leads_org_property_idx ON public.leads USING btree (org_id, property_id) WHERE (property_id IS NOT NULL)",
      "CREATE UNIQUE INDEX reservation_installments_org_reservation_sort_order_key ON public.reservation_installments USING btree (org_id, reservation_id, sort_order)",
      "CREATE UNIQUE INDEX reservations_one_live_per_property ON public.reservations USING btree (org_id, property_id) WHERE (status = ANY (ARRAY['held'::reservation_status, 'confirmed'::reservation_status]))",
      "CREATE UNIQUE INDEX reservations_org_id_id_key ON public.reservations USING btree (org_id, id)",
      "CREATE INDEX reservations_org_property_idx ON public.reservations USING btree (org_id, property_id)",
    ]);
    expect(await count("select count(*)::int as c from pg_constraint where conname = 'reservation_installments_reservation_id_sort_order_key'")).toBe(0);
    expect(
      await count(
        `select count(*)::int as c from pg_constraint where convalidated and conname in
           ('tasks_org_deal_fkey', 'tasks_org_viewing_fkey', 'tasks_org_mandate_fkey', 'mandates_org_property_fkey',
            'property_keys_org_property_fkey', 'mandates_org_renewed_from_fkey', 'properties_org_id_id_key', 'viewings_org_id_id_key',
            'viewings_org_property_fkey', 'viewings_org_contact_fkey', 'contacts_org_id_id_key')`,
      ),
    ).toBe(11);
  });

  it("the four readers scope their parent joins in their own text; nothing else moved; definer, search_path, volatility and ACLs kept", async () => {
    const code = async (sig: string) => (await bodyOf(sig)).replace(/--[^\n]*/g, "");
    expect(await code(SIG.warn)).toMatch(/join properties p on p\.id = r\.property_id\s+and p\.org_id = r\.org_id/);
    const remind = await code(SIG.remind);
    expect(remind).toMatch(/join reservations r on r\.id = i\.reservation_id\s+and r\.org_id = i\.org_id\s+join properties\s+p on p\.id = r\.property_id\s+and p\.org_id = r\.org_id/);
    expect(remind).toMatch(/from reservation_installments i\s+join reservations r on r\.id = i\.reservation_id\s+and r\.org_id = i\.org_id\s+where t\.installment_id = i\.id/);
    const sla = await code(SIG.sla);
    expect(sla).toMatch(/p\.id as property_id, p\.reference\s+from leads l\s+left join properties p on p\.id = l\.property_id\s+and p\.org_id = l\.org_id/);
    expect(await code(SIG.preview)).toMatch(/left join properties pr on pr\.id = c\.property_id\s+and pr\.org_id = c\.org_id/);
    for (const [k, sig] of Object.entries(SIG) as [keyof typeof SIG, string][]) {
      expect(await md5(strip(await bodyOf(sig))), `${k}: the old body plus exactly 0124's lines`).toBe(MD5[k]);
    }
    // the sweeps serve every organisation in one run: row by row, never the
    // session's organisation (the preview IS a session function — 0112 reads
    // current_org_id() for the caller, and its new predicate is c.org_id above)
    for (const sig of [SIG.warn, SIG.remind, SIG.sla]) expect(await bodyOf(sig)).not.toMatch(/current_org_id\(\)/);
    const { rows } = await o.query<{ p: string; secdef: boolean; vol: string; config: string[]; anon: boolean; auth: boolean; svc: boolean }>(
      `select p.oid::regprocedure::text as p, p.prosecdef as secdef, p.provolatile::text as vol, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p where p.oid = any($1::regprocedure[]) order by p.oid::regprocedure::text collate "C"`,
      [Object.values(SIG)],
    );
    expect(rows).toEqual([
      { p: "preview_lead_escalation(jsonb,integer,timestamp with time zone)", secdef: true, vol: "s", config: ["search_path=public"], anon: false, auth: true, svc: true },
      { p: "raise_lead_sla_tasks(uuid,integer)", secdef: true, vol: "v", config: ["search_path=public"], anon: false, auth: false, svc: true },
      { p: "remind_due_installments(uuid)", secdef: true, vol: "v", config: ["search_path=public"], anon: false, auth: false, svc: true },
      { p: "warn_expiring_reservations(uuid)", secdef: true, vol: "v", config: ["search_path=public"], anon: false, auth: false, svc: true },
    ]);
  });
});

describe("the migration file: upgrade from 0123, refusal over existing mismatches or a changed body, re-run, concurrent writers", () => {
  const file = () => readFileSync(MIGRATION, "utf8");

  it("applies over 0123's catalogue and this database's accumulated data: the keys validate, the probes run, each body is the old one plus 0124's lines", async () => {
    const notices: string[] = [];
    const listen = (msg: { message?: string }) => notices.push(msg.message ?? "");
    o.on("notice", listen);
    try {
      await rolledBack(async () => {
        await revertTo0123();
        expect(await allKeys()).toEqual(KEYS_0123);
        for (const [k, sig] of Object.entries(SIG) as [keyof typeof SIG, string][]) expect(await bodyMd5(sig), k).toBe(MD5[k]);
        await commentsAre0123();
        await o.query(file());
        expect(await allKeys()).toEqual(KEYS_0124);
        for (const [k, sig] of Object.entries(SIG) as [keyof typeof SIG, string][]) expect(await md5(strip(await bodyOf(sig))), k).toBe(MD5[k]);
      });
    } finally {
      o.off("notice", listen);
    }
    expect(notices.some((x) => x.startsWith("0124: preflight passed"))).toBe(true);
    expect(notices.some((x) => x.startsWith("0124: probes refused by their keys: {hold,live_hold,line,taken_line,lead}"))).toBe(true);
  });

  // The message is the proof: the PREFLIGHT refused (with all three counts),
  // so it ran before the key additions, which would otherwise have failed
  // 23503 on these rows. That it precedes ALL DDL is the file's text order,
  // not something this test observes; the checks after the savepoint
  // rollback only restate the state (a rollback restores it whatever ran).
  it("refuses over existing mismatches in its preflight, with all three counts", async () => {
    await rolledBack(async () => {
      await revertTo0123();
      const pa = await newProperty(ORG_A);
      const ra = await newHold(ORG_A, pa.id, { status: "released" });
      const hold = await newHold(ORG_B, pa.id, { status: "released" });
      const line = await newLine(ORG_B, ra, 70);
      const lead = await newLead(ORG_B, pa.id, { source: "phone" });
      await o.query("savepoint before_0124");
      await expect(o.query(file())).rejects.toThrow(
        /^0124 aborted: 1 reservation\(s\) hold a property of another organisation, 1 instalment line\(s\) belong to a reservation of another organisation, 1 lead\(s\) name a property of another organisation — nothing was changed/,
      );
      await o.query("rollback to savepoint before_0124");
      expect(await allKeys()).toEqual(KEYS_0123);
      expect(await count("select count(*)::int as c from reservations where id = $1 and org_id = $2", [hold, ORG_B])).toBe(1);
      expect(await count("select count(*)::int as c from reservation_installments where id = $1 and org_id = $2", [line, ORG_B])).toBe(1);
      expect(await count("select count(*)::int as c from leads where id = $1 and org_id = $2", [lead, ORG_B])).toBe(1);
    });
  });

  // One hand edit per function, as a hotfix typed into an SQL editor would
  // be: each must be refused by name — not just the first the loop checks.
  const TAMPER: { name: string; sig: string; from: string; to: string }[] = [
    { name: "warn_expiring_reservations", sig: SIG.warn, from: "'Reservation on '", to: "'Hold on '" },
    { name: "remind_due_installments", sig: SIG.remind, from: "'Instalment \"'", to: "'Line \"'" },
    { name: "raise_lead_sla_tasks", sig: SIG.sla, from: "'Website enquiry unanswered for over an hour'", to: "'Web enquiry unanswered'" },
    { name: "preview_lead_escalation", sig: SIG.preview, from: "'truncated'", to: "'cut'" },
  ];
  for (const t of TAMPER) {
    it(`refuses before any DDL when ${t.name}'s body is not the one it restates (an unrecorded change is not overwritten)`, async () => {
      await rolledBack(async () => {
        await revertTo0123();
        const def = (await o.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [t.sig])).rows[0]!.d;
        expect(def.split(t.from).length - 1, `the tamper point exists once in ${t.name}`).toBe(1);
        await o.query(def.replace(t.from, t.to));
        const tampered = await bodyMd5(t.sig);
        expect(tampered).not.toBe(MD5[(Object.keys(SIG) as (keyof typeof SIG)[]).find((k) => SIG[k] === t.sig)!]);
        await o.query("savepoint before_0124");
        await expect(o.query(file())).rejects.toThrow(
          new RegExp(`^0124 aborted: ${t.name} is not the body 0124 expects on this database \\(md5 ${tampered}\\) — nothing was changed`),
        );
        await o.query("rollback to savepoint before_0124");
      });
    });
  }

  it("refuses before any DDL when a function's attributes drifted (an extra EXECUTE grant) — CREATE OR REPLACE and the grants would reset them silently", async () => {
    await rolledBack(async () => {
      await revertTo0123();
      await o.query("grant execute on function public.remind_due_installments(uuid) to authenticated");
      await o.query("savepoint before_0124");
      await expect(o.query(file())).rejects.toThrow(
        /^0124 aborted: remind_due_installments's attributes \(SECURITY DEFINER, search_path, volatility or EXECUTE grants\) are not the ones 0124 expects on this database — nothing was changed/,
      );
      await o.query("rollback to savepoint before_0124");
    });
  });

  it("run a second time, it stops in its preflight (the bodies are no longer the old ones)", async () => {
    await rolledBack(async () => {
      await expect(o.query(file())).rejects.toThrow(/^0124 aborted: \w+ is not the body 0124 expects on this database/);
    });
  });

  // What the spy sees while the file is blocked is the proof that the LOCK
  // runs BEFORE the counts, in the stated order: access exclusive granted on
  // the two child tables, waiting on leads, and NO lock of any mode on
  // properties — the three counts all read properties, so had any of them
  // run first, the file would hold AccessShareLock there.
  it("an in-flight write to leads holds the file at its LOCK, taken children-first and before the counts, until lock_timeout (55P03)", async () => {
    const writer = new Client({ connectionString: DB_URL });
    const spy = new Client({ connectionString: DB_URL });
    await writer.connect();
    await spy.connect();
    try {
      await writer.query("begin");
      await writer.query(`insert into leads (org_id, source) values ($1, 'phone')`, [ORG_B]);
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
              where l.pid = $1 and c.relname in ('reservation_installments', 'reservations', 'leads', 'properties')
              order by c.relname collate "C"`,
            [pid],
          )
        ).rows;
        if (seen.some((r) => !r.granted)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await run;
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(seen).toEqual([
        { relname: "leads", mode: "AccessExclusiveLock", granted: false },
        { relname: "reservation_installments", mode: "AccessExclusiveLock", granted: true },
        { relname: "reservations", mode: "AccessExclusiveLock", granted: true },
      ]);
    } finally {
      await writer.query("rollback");
      await writer.end();
      await spy.end();
    }
  });
});
