import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * 0122: a mandate belongs to the organisation of the property it names and
 * of the mandate it renews, and a property key to the organisation of its
 * property; the two mandate sweeps read only the mandate's own property and
 * keys. The parent-link sequel of 0121 (task-mandate-org-isolation.test.ts).
 *
 * THE GAP, as it stood at 0121 (measured through PostgREST): `mandates.
 * property_id` and `property_keys.property_id` referenced `properties(id)`
 * alone, `mandates.renewed_from_id` `mandates(id)` alone, and every insert /
 * update policy on the two tables checks only the CALLER's organisation. So
 * B's admin could put a B mandate on A's property — and, made active, it
 * held `mandates_one_active_per_property` (unique on property_id alone) so A
 * could not activate its own (23505); B's key-recall and renewal reminders
 * then carried A's property reference, A's held-key count and A's agent. B
 * could file a B key on A's property, and `raise_key_recall_tasks` (which
 * counts keys by property_id alone) raised a "Return keys" task in A from it
 * and kept A's from ever self-healing. A B mandate could name an A mandate as
 * its predecessor. And a real vs missing id answered 201 vs 23503 on each
 * link. The tests marked "RED at 0121" failed against 0121's catalogue before
 * the migration; the rest pin what must not change.
 *
 * TWO KINDS OF CALLER, as in 0119–0121: supabase-js through PostgREST for
 * every write the app sends and for the service role's calls, and one `pg`
 * session as postgres — pg_cron's role — for fixtures, verification, cleanup,
 * the scheduled sweep (inside a transaction ROLLED BACK after its reads: it
 * is global), and PLANTING the cross-organisation rows the keys now refuse
 * (`session_replication_role = replica`, allowed to postgres through
 * supautils' privileged_role_allowed_configs, as on hosted, where the restore
 * uses it). Plants are COMMITTED before the call under test. This file is
 * never pointed at hosted: it commits cross-organisation rows.
 *
 * TWO THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORGS = [ORG_A, ORG_B];
const RUN = Date.now().toString(36);

let o: Client;
let svc: SupabaseClient;

let adminA: TestUser;
let agentA: TestUser; // A's properties' agent
let lmA: TestUser; // A's listing manager (keys)
let adminB: TestUser;
let lmB: TestUser;
const userIds: string[] = [];
let n = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type Status = "draft" | "active" | "expired" | "terminated";

async function newProperty(org: string, agent: string | null = null) {
  n += 1;
  const { rows } = await o.query<{ id: string; reference: string }>(
    `insert into properties (org_id, reference, property_type, assigned_agent_id)
     values ($1, $2, 'apartment', $3) returning id, reference`,
    [org, `MKP${RUN}${n}`.toUpperCase(), agent],
  );
  return rows[0]!;
}

async function newMandate(
  org: string,
  property: string,
  opts: { status?: Status; expiryInDays?: number; renewedFrom?: string | null } = {},
) {
  const { rows } = await o.query<{ id: string }>(
    `insert into mandates (org_id, property_id, status, type, start_date, expiry_date, renewal_reminder_days, renewed_from_id)
     values ($1, $2, $3::mandate_status, 'open', current_date - 200, current_date + $4::int, 30, $5) returning id`,
    [org, property, opts.status ?? "terminated", opts.expiryInDays ?? -10, opts.renewedFrom ?? null],
  );
  return rows[0]!.id;
}

async function addKey(org: string, property: string, status: "in_office" | "checked_out" | "with_owner" | "lost") {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into property_keys (org_id, property_id, key_code, status) values ($1, $2, $3, $4::key_status) returning id`,
    [org, property, `MKP-K${n}`, status],
  );
  return rows[0]!.id;
}

/** Write one row past the keys this file is about (see the header); committed. */
async function plant<T>(sql: string, params: unknown[]): Promise<T> {
  await o.query("begin");
  try {
    await o.query("set local session_replication_role = replica");
    const { rows } = await o.query(sql, params);
    await o.query("commit");
    return rows[0] as T;
  } catch (e) {
    await o.query("rollback");
    throw e;
  }
}

/** B's mandate on A's property — the row 0122's mandates key refuses. */
const plantMandate = (org: string, foreignProperty: string, status: Status, expiryInDays = -10) =>
  plant<{ id: string }>(
    `insert into mandates (org_id, property_id, status, type, start_date, expiry_date, renewal_reminder_days)
     values ($1, $2, $3::mandate_status, 'open', current_date - 200, current_date + $4::int, 30) returning id`,
    [org, foreignProperty, status, expiryInDays],
  ).then((r) => r.id);

/** B's key on A's property — the row 0122's keys key refuses. */
const plantKey = (org: string, foreignProperty: string, status: "in_office" | "checked_out") => {
  n += 1;
  return plant<{ id: string }>(
    `insert into property_keys (org_id, property_id, key_code, status) values ($1, $2, $3, $4::key_status) returning id`,
    [org, foreignProperty, `MKP-PLANT${n}`, status],
  ).then((r) => r.id);
};

async function count(sql: string, params: unknown[]) {
  const { rows } = await o.query<{ c: number }>(sql, params);
  return rows[0]!.c;
}

async function mandateRow(id: string) {
  const { rows } = await o.query<{ org_id: string; property_id: string; status: string; renewed_from_id: string | null }>(
    "select org_id, property_id, status::text, renewed_from_id from mandates where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

async function keyRow(id: string) {
  const { rows } = await o.query<{ org_id: string; property_id: string }>(
    "select org_id, property_id from property_keys where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

async function tasksOn(mandate: string, kind: string) {
  const { rows } = await o.query<{ id: string; org_id: string; title: string; is_done: boolean; property_id: string | null }>(
    "select id, org_id, title, is_done, property_id from tasks where mandate_id = $1 and kind = $2 order by created_at, id",
    [mandate, kind],
  );
  return rows;
}

async function eventsMark() {
  const { rows } = await o.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events");
  return rows[0]!.m;
}

async function eventsSince(mark: string, orgs: string | string[] = ORGS) {
  const { rows } = await o.query<{ org_id: string; entity_type: string; entity_id: string; event_type: string; actor_id: string | null; payload: Record<string, unknown> }>(
    `select org_id, entity_type, entity_id, event_type, actor_id, payload
       from events where id > $1::bigint and org_id = any($2::uuid[]) order by id`,
    [mark, Array.isArray(orgs) ? orgs : [orgs]],
  );
  return rows;
}

async function chainOk(org: string) {
  const { rows } = await o.query<{ ok: boolean }>("select public.verify_events_chain($1) as ok", [org]);
  return rows[0]!.ok;
}

/** The nightly run as pg_cron makes it, `times` times, read, then ROLLED BACK. */
async function inNightlySweep(times: number, check: () => Promise<void>) {
  await o.query("begin");
  try {
    for (let i = 0; i < times; i += 1) await o.query("select public.expire_mandates()");
    await check();
  } finally {
    await o.query("rollback");
  }
}

/** setMandateStatus's raiser call: the service role, the acting admin as p_actor. */
const raiseAsAction = (mandate: string, actor: string) =>
  svc.rpc("raise_key_recall_tasks", { p_mandate: mandate, p_actor: actor });

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  // a killed earlier run leaves its committed cross-organisation plants behind
  await o.query(
    `delete from tasks t using mandates m, properties p
      where m.id = t.mandate_id and p.id = m.property_id and m.org_id <> p.org_id`,
  );
  await o.query(`delete from mandates m using properties p where p.id = m.property_id and m.org_id <> p.org_id`);
  await o.query(`delete from property_keys k using properties p where p.id = k.property_id and k.org_id <> p.org_id`);

  await ensureTestOrg(svc, ORG_A, `parent-links A ${RUN}`, `parent-links-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `parent-links B ${RUN}`, `parent-links-b-${RUN}`);
  // sequential: parallel TOTP enrolment trips GoTrue gateway errors ({} messages)
  adminA = await createTestUser(svc, `mkp-admin-a-${RUN}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `mkp-agent-a-${RUN}@test.local`, "agent", ORG_A);
  lmA = await createTestUser(svc, `mkp-lm-a-${RUN}@test.local`, "listing_manager", ORG_A);
  adminB = await createTestUser(svc, `mkp-admin-b-${RUN}@test.local`, "admin", ORG_B);
  lmB = await createTestUser(svc, `mkp-lm-b-${RUN}@test.local`, "listing_manager", ORG_B);
  userIds.push(adminA.id, agentA.id, lmA.id, adminB.id, lmB.id);
});

afterAll(async () => {
  await o.query("delete from tasks where org_id = any($1::uuid[])", [ORGS]);
  // one statement each: rows of either organisation may name the other's
  await o.query("delete from key_movements where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from property_keys where org_id = any($1::uuid[])", [ORGS]);
  await o.query("delete from mandates where org_id = any($1::uuid[])", [ORGS]);
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
describe("the premise: organisation B cannot read A's property, mandate or keys", () => {
  it("B's admin and listing manager see none of them; A's admin does", async () => {
    const p = await newProperty(ORG_A, agentA.id);
    const m = await newMandate(ORG_A, p.id);
    const k = await addKey(ORG_A, p.id, "in_office");
    for (const c of [adminB.client, lmB.client]) {
      expect((await c.from("properties").select("id").eq("id", p.id)).data).toEqual([]);
      expect((await c.from("mandates_safe").select("id").eq("id", m)).data).toEqual([]);
      expect((await c.from("property_keys").select("id").eq("id", k)).data).toEqual([]);
    }
    expect((await adminA.client.from("properties").select("id").eq("id", p.id)).data).toEqual([{ id: p.id }]);
  });
});

describe("B cannot put a mandate on A's property (23503, nothing written) — RED at 0121", () => {
  const shape = (property: string, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    property_id: property,
    type: "open",
    status: "draft",
    start_date: "2026-01-01",
    expiry_date: "2027-01-01",
    ...extra,
  });

  it("INSERT — a draft and an active mandate of B naming A's property", async () => {
    const p = await newProperty(ORG_A);
    for (const status of ["draft", "active"]) {
      const r = await adminB.client.from("mandates").insert(shape(p.id, { status })).select("id");
      expect(r.error?.code, status).toBe("23503");
    }
    expect(await count("select count(*)::int as c from mandates where property_id = $1", [p.id])).toBe(0);
  });

  it("UPDATE — B's mandate on B's own property cannot be re-pointed at A's", async () => {
    const pa = await newProperty(ORG_A);
    const pb = await newProperty(ORG_B);
    const mb = await newMandate(ORG_B, pb.id, { status: "draft" });
    const r = await adminB.client.from("mandates").update({ property_id: pa.id }).eq("id", mb).select("id");
    expect(r.error?.code).toBe("23503");
    expect((await mandateRow(mb))!.property_id).toBe(pb.id);
  });

  it("UPSERT — onto B's existing mandate (merge) and as a new id: refused, nothing written", async () => {
    const pa = await newProperty(ORG_A);
    const pb = await newProperty(ORG_B);
    const mb = await newMandate(ORG_B, pb.id, { status: "draft" });
    const merge = await adminB.client.from("mandates").upsert({ id: mb, ...shape(pa.id) }, { onConflict: "id" }).select("id");
    expect(merge.error?.code).toBe("23503");
    expect((await mandateRow(mb))!.property_id).toBe(pb.id);
    const fresh = randomUUID();
    const insert = await adminB.client.from("mandates").upsert({ id: fresh, ...shape(pa.id) }, { onConflict: "id" }).select("id");
    expect(insert.error?.code).toBe("23503");
    expect(await mandateRow(fresh)).toBeNull();
  });

  it("A can still activate its own mandate: B's active mandate can no longer hold A's property (23505 at 0121)", async () => {
    const p = await newProperty(ORG_A);
    await adminB.client.from("mandates").insert(shape(p.id, { status: "active" })).select("id");
    const mine = await newMandate(ORG_A, p.id, { status: "draft", expiryInDays: 300 });
    const r = await adminA.client.from("mandates").update({ status: "active" }).eq("id", mine).select("id");
    expect(r.error, "no foreign mandate occupies A's one active slot").toBeNull();
    expect(r.data).toEqual([{ id: mine }]);
  });

  it("B's ACTIVE mandate on an A property that already has an active mandate reads the same 23503 as on one that has none — no oracle on A's mandate state (23505 while the one-active index was keyed by property alone)", async () => {
    const busy = await newProperty(ORG_A);
    await newMandate(ORG_A, busy.id, { status: "active", expiryInDays: 300 });
    const idle = await newProperty(ORG_A);
    const a = await adminB.client.from("mandates").insert(shape(busy.id, { status: "active" })).select("id");
    const b = await adminB.client.from("mandates").insert(shape(idle.id, { status: "active" })).select("id");
    expect(a.error?.code, "A's property under an active mandate").toBe("23503");
    expect(b.error?.code, "A's property with none").toBe("23503");
    expect(a.error?.message).toBe(b.error?.message);
    // and A's own second active mandate on the busy property still hits the rule
    const second = await newMandate(ORG_A, busy.id, { status: "draft", expiryInDays: 300 });
    const r = await adminA.client.from("mandates").update({ status: "active" }).eq("id", second).select("id");
    expect(r.error?.code, "setMandateStatus maps this 23505 to 'already has an active mandate'").toBe("23505");
  });

  it("a mandate's organisation cannot be moved away from its property's — by a user session (RLS) or by the service role (the key)", async () => {
    const p = await newProperty(ORG_A);
    const m = await newMandate(ORG_A, p.id, { status: "draft" });
    const user = await adminA.client.from("mandates").update({ org_id: ORG_B }).eq("id", m).select("id");
    expect(user.error?.code).toBe("42501");
    const maintenance = await svc.from("mandates").update({ org_id: ORG_B }).eq("id", m).select("id");
    expect(maintenance.error?.code).toBe("23503");
    expect((await mandateRow(m))!.org_id).toBe(ORG_A);
  });

  it("the key's refusal no longer tells B whether an A property id exists", async () => {
    const p = await newProperty(ORG_A);
    const a = await adminB.client.from("mandates").insert(shape(p.id)).select("id");
    const b = await adminB.client.from("mandates").insert(shape(randomUUID())).select("id");
    expect(a.error?.code).toBe("23503");
    expect(b.error?.code).toBe("23503");
    expect(a.error?.message).toBe(b.error?.message);
  });
});

describe("B cannot file a key on A's property (23503, nothing written) — RED at 0121", () => {
  const shape = (property: string, extra: Record<string, unknown> = {}) => ({
    org_id: ORG_B,
    property_id: property,
    key_code: `MKP-B-${RUN}`,
    status: "in_office",
    ...extra,
  });

  it("INSERT — as B's admin and as B's listing manager", async () => {
    const p = await newProperty(ORG_A);
    for (const [who, c] of [
      ["B's admin", adminB.client],
      ["B's listing manager", lmB.client],
    ] as const) {
      const r = await c.from("property_keys").insert(shape(p.id)).select("id");
      expect(r.error?.code, who).toBe("23503");
    }
    expect(await count("select count(*)::int as c from property_keys where property_id = $1", [p.id])).toBe(0);
  });

  it("UPDATE and UPSERT — B's key on B's property cannot be re-pointed at A's", async () => {
    const pa = await newProperty(ORG_A);
    const pb = await newProperty(ORG_B);
    const kb = await addKey(ORG_B, pb.id, "in_office");
    const upd = await lmB.client.from("property_keys").update({ property_id: pa.id }).eq("id", kb).select("id");
    expect(upd.error?.code).toBe("23503");
    const ups = await adminB.client.from("property_keys").upsert({ id: kb, ...shape(pa.id) }, { onConflict: "id" }).select("id");
    expect(ups.error?.code).toBe("23503");
    expect((await keyRow(kb))!.property_id).toBe(pb.id);
  });

  it("a key's organisation cannot be moved away from its property's (the service role, the key); the key's refusal no longer tells B whether an A property id exists", async () => {
    const p = await newProperty(ORG_A);
    const k = await addKey(ORG_A, p.id, "in_office");
    const moved = await svc.from("property_keys").update({ org_id: ORG_B }).eq("id", k).select("id");
    expect(moved.error?.code).toBe("23503");
    expect((await keyRow(k))!.org_id).toBe(ORG_A);
    const a = await adminB.client.from("property_keys").insert(shape(p.id)).select("id");
    const b = await adminB.client.from("property_keys").insert(shape(randomUUID())).select("id");
    expect(a.error?.code).toBe("23503");
    expect(b.error?.code).toBe("23503");
    expect(a.error?.message).toBe(b.error?.message);
  });
});

describe("B cannot name A's mandate as a B mandate's predecessor (23503) — RED at 0121", () => {
  it("INSERT and UPDATE are refused; the key's refusal no longer tells B whether an A mandate id exists", async () => {
    const pa = await newProperty(ORG_A);
    const ma = await newMandate(ORG_A, pa.id, { status: "expired" });
    const pb = await newProperty(ORG_B);
    const ins = await adminB.client
      .from("mandates")
      .insert({ org_id: ORG_B, property_id: pb.id, type: "open", status: "draft", renewed_from_id: ma })
      .select("id");
    expect(ins.error?.code).toBe("23503");
    const mb = await newMandate(ORG_B, pb.id, { status: "draft" });
    const upd = await adminB.client.from("mandates").update({ renewed_from_id: ma }).eq("id", mb).select("id");
    expect(upd.error?.code).toBe("23503");
    expect((await mandateRow(mb))!.renewed_from_id).toBeNull();
    const missing = await adminB.client.from("mandates").update({ renewed_from_id: randomUUID() }).eq("id", mb).select("id");
    expect(missing.error?.code).toBe("23503");
    expect(upd.error?.message).toBe(missing.error?.message);
  });
});

describe("same-organisation links, embeds and deletion stay as they were", () => {
  it("A's admin creates and re-points mandates on A's properties, renews one (renewMandate's insert shape); A's listing manager files and re-points keys", async () => {
    const p1 = await newProperty(ORG_A);
    const p2 = await newProperty(ORG_A);
    const created = await adminA.client
      .from("mandates")
      .insert({ org_id: ORG_A, property_id: p1.id, type: "open", status: "draft", created_by: adminA.id })
      .select("id")
      .single();
    expect(created.error).toBeNull();
    const moved = await adminA.client.from("mandates").update({ property_id: p2.id }).eq("id", created.data!.id).select("id");
    expect(moved.error).toBeNull();
    const prev = await newMandate(ORG_A, p1.id, { status: "expired" });
    const renewal = await adminA.client
      .from("mandates")
      .insert({ org_id: ORG_A, property_id: p1.id, renewed_from_id: prev, type: "open", status: "draft", created_by: adminA.id })
      .select("id, renewed_from_id")
      .single();
    expect(renewal.error).toBeNull();
    expect(renewal.data!.renewed_from_id).toBe(prev);

    const key = await lmA.client.from("property_keys").insert({ org_id: ORG_A, property_id: p1.id, key_code: `MKP-A-${RUN}` }).select("id").single();
    expect(key.error).toBeNull();
    const keyMoved = await lmA.client.from("property_keys").update({ property_id: p2.id }).eq("id", key.data!.id).select("id");
    expect(keyMoved.error).toBeNull();
    expect((await keyRow(key.data!.id))!.property_id).toBe(p2.id);
  });

  it("PostgREST embeds keep ONE relationship each way — the property list's mandates_safe!inner, the keys page's properties(reference), and the base tables", async () => {
    const p = await newProperty(ORG_A);
    const m = await newMandate(ORG_A, p.id, { status: "active", expiryInDays: 300 });
    const k = await addKey(ORG_A, p.id, "in_office");
    // lib/queries/properties-list.ts mandateEmbed, as the list and the CSV export send it
    const list = await adminA.client.from("properties").select("id, mandates_safe!inner(type, status)").eq("id", p.id).eq("mandates_safe.status", "active");
    expect(list.error).toBeNull();
    expect(list.data).toEqual([{ id: p.id, mandates_safe: [{ type: "open", status: "active" }] }]);
    const fromMandates = await adminA.client.from("mandates").select("id, properties(reference)").eq("id", m).single();
    expect(fromMandates.error).toBeNull();
    expect((fromMandates.data as unknown as { properties: { reference: string } }).properties.reference).toBe(p.reference);
    const fromProps = await adminA.client.from("properties").select("id, mandates(id), property_keys(id)").eq("id", p.id).single();
    expect(fromProps.error).toBeNull();
    // app/(app)/keys/page.tsx and lib/services/key-export.ts
    const keys = await adminA.client.from("property_keys").select("id, key_code, properties(reference)").eq("id", k).single();
    expect(keys.error).toBeNull();
    expect((keys.data as unknown as { properties: { reference: string } }).properties.reference).toBe(p.reference);
    // the keys page's movement feed: key_movements -> property_keys -> properties
    const { rows: mv } = await o.query<{ id: string }>(
      `insert into key_movements (org_id, key_id, action, holder_name) values ($1, $2, 'checkout', 'ZZTEST holder') returning id`,
      [ORG_A, k],
    );
    const feed = await adminA.client
      .from("key_movements")
      .select("id, property_keys(key_code, properties(reference))")
      .eq("id", mv[0]!.id)
      .single();
    expect(feed.error).toBeNull();
    expect((feed.data as unknown as { property_keys: { properties: { reference: string } } }).property_keys.properties.reference).toBe(p.reference);
  });

  it("deletion: a property still takes its mandates (predecessor and successor) and keys with it (ON DELETE CASCADE); a predecessor alone cannot be deleted under its successor (NO ACTION)", async () => {
    const p = await newProperty(ORG_A);
    const prev = await newMandate(ORG_A, p.id, { status: "expired" });
    const next = await newMandate(ORG_A, p.id, { status: "draft", renewedFrom: prev });
    const k = await addKey(ORG_A, p.id, "with_owner");
    await expect(o.query("delete from mandates where id = $1", [prev])).rejects.toMatchObject({
      code: "23503",
      constraint: expect.stringMatching(/^mandates_(org_renewed_from|renewed_from_id)_fkey$/),
    });
    await o.query("delete from properties where id = $1", [p.id]);
    expect(await mandateRow(prev)).toBeNull();
    expect(await mandateRow(next)).toBeNull();
    expect(await keyRow(k)).toBeNull();
  });
});

describe("the sweeps read only the mandate's own property and keys (rows planted past the keys) — RED at 0121", () => {
  it("B's mandate on A's property raises nothing at edit time: no B task carrying A's reference, key count or agent", async () => {
    const p = await newProperty(ORG_A, agentA.id);
    await addKey(ORG_A, p.id, "checked_out");
    const mb = await plantMandate(ORG_B, p.id, "terminated");
    // B's own key on that property too: the held count (k.org_id = m.org_id)
    // would then find one, so ONLY the property join's predicate stands
    // between B and a reminder carrying A's reference (mutant M1 showed the
    // count alone had been hiding it)
    await plantKey(ORG_B, p.id, "checked_out");
    const mark = await eventsMark();
    const r = await raiseAsAction(mb, adminB.id);
    expect(r.error).toBeNull();
    expect(r.data).toBe(0);
    expect(await tasksOn(mb, "key_recall")).toEqual([]);
    expect(await eventsSince(mark)).toEqual([]);
  });

  it("B's key on A's property neither raises A a reminder nor stops A's from self-healing", async () => {
    // (1) A's ended mandate, A holds no key, B's key sits on the property: nothing to recall
    const p1 = await newProperty(ORG_A, agentA.id);
    const m1 = await newMandate(ORG_A, p1.id);
    await plantKey(ORG_B, p1.id, "in_office");
    const r1 = await raiseAsAction(m1, adminA.id);
    expect(r1.error).toBeNull();
    expect(r1.data, "B's key is not A's to recall").toBe(0);

    // (2) A's reminder raised for A's own key; A returns it; B's key is still there
    const p2 = await newProperty(ORG_A, agentA.id);
    const m2 = await newMandate(ORG_A, p2.id);
    const mine = await addKey(ORG_A, p2.id, "checked_out");
    expect((await raiseAsAction(m2, adminA.id)).data).toBe(1);
    const [task] = await tasksOn(m2, "key_recall");
    await plantKey(ORG_B, p2.id, "in_office");
    await o.query("update property_keys set status = 'with_owner' where id = $1", [mine]);
    const mark = await eventsMark();
    expect((await raiseAsAction(m2, adminA.id)).error).toBeNull();
    const [after] = await tasksOn(m2, "key_recall");
    expect(after!.is_done, "A's last key is back: the chase stops whatever B filed").toBe(true);
    expect((await eventsSince(mark, ORG_A)).map((e) => [e.entity_id, e.event_type, e.actor_id])).toEqual([
      [task!.id, "superseded", adminA.id],
    ]);
    expect(await eventsSince(mark, ORG_B)).toEqual([]);
    expect(await chainOk(ORG_A)).toBe(true);
  });

  it("the nightly run: B's active mandate on A's property gets no renewal reminder and B's ended one no recall; B's own mandates are still served", async () => {
    const pa = await newProperty(ORG_A, agentA.id);
    await addKey(ORG_A, pa.id, "checked_out");
    const renewal = await plantMandate(ORG_B, pa.id, "active", 10);
    const pa2 = await newProperty(ORG_A, agentA.id);
    await addKey(ORG_A, pa2.id, "checked_out");
    const recall = await plantMandate(ORG_B, pa2.id, "terminated");
    // B's own, on B's own property: the job must serve B too
    const pb = await newProperty(ORG_B);
    await addKey(ORG_B, pb.id, "in_office");
    const own = await newMandate(ORG_B, pb.id);
    await inNightlySweep(2, async () => {
      expect(await tasksOn(renewal, "mandate_renewal"), "no reminder naming A's property in B").toEqual([]);
      expect(await tasksOn(recall, "key_recall"), "no recall counting A's keys in B").toEqual([]);
      expect(await tasksOn(own, "key_recall"), "B's own recall, once").toHaveLength(1);
      // nothing in B's chain names A's property
      const { rows } = await o.query<{ c: number }>(
        `select count(*)::int as c from events e
          where e.org_id = $1 and (e.payload->>'property_id' = any($2::text[])
             or e.entity_id = any($3::uuid[]) and e.event_type in ('key_recall_task_created', 'renewal_task_created'))`,
        [ORG_B, [pa.id, pa2.id], [renewal, recall]],
      );
      expect(rows[0]!.c).toBe(0);
    });
  });
});

describe("the catalogue: three tenant-bound, validated relationships; the sweeps' property and key reads scoped in their own text — RED at 0121", () => {
  it("mandates and property_keys name their property, and mandates their predecessor, by (org_id, …) — validated, the old single-column keys gone, delete rules kept, the referencing indexes present, 0119–0121 untouched", async () => {
    const { rows } = await o.query<{ conname: string; rel: string; def: string; convalidated: boolean }>(
      `select conname, conrelid::regclass::text as rel, pg_get_constraintdef(oid) as def, convalidated
         from pg_constraint
        where contype = 'f'
          and ((conrelid = 'public.mandates'::regclass and confrelid in ('public.properties'::regclass, 'public.mandates'::regclass))
            or (conrelid = 'public.property_keys'::regclass and confrelid = 'public.properties'::regclass))
        order by 1`,
    );
    expect(rows).toEqual([
      { conname: "mandates_org_property_fkey", rel: "mandates", def: "FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE CASCADE", convalidated: true },
      { conname: "mandates_org_renewed_from_fkey", rel: "mandates", def: "FOREIGN KEY (org_id, renewed_from_id) REFERENCES mandates(org_id, id)", convalidated: true },
      { conname: "property_keys_org_property_fkey", rel: "property_keys", def: "FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE CASCADE", convalidated: true },
    ]);
    const { rows: idx } = await o.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'public'
          and indexname in ('mandates_org_property_idx', 'mandates_org_renewed_from_idx', 'property_keys_org_property_idx') order by 1`,
    );
    expect(idx.map((i) => i.indexname)).toEqual(["mandates_org_property_idx", "mandates_org_renewed_from_idx", "property_keys_org_property_idx"]);
    const { rows: active } = await o.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'mandates_one_active_per_property'",
    );
    expect(active).toEqual([
      {
        indexdef:
          "CREATE UNIQUE INDEX mandates_one_active_per_property ON public.mandates USING btree (org_id, property_id) WHERE (status = 'active'::mandate_status)",
      },
    ]);
    const { rows: earlier } = await o.query<{ c: number }>(
      `select count(*)::int as c from pg_constraint where convalidated and conname in
         ('tasks_org_deal_fkey', 'tasks_org_viewing_fkey', 'tasks_org_mandate_fkey', 'mandates_org_id_id_key', 'properties_org_id_id_key')`,
    );
    expect(earlier[0]!.c).toBe(5);
  });

  it("raise_key_recall_tasks and expire_mandates read only the mandate's organisation's property and keys", async () => {
    const src = async (sig: string) =>
      (await o.query<{ s: string }>("select prosrc as s from pg_proc where oid = $1::regprocedure", [sig])).rows[0]!.s.replace(/--[^\n]*/g, "");
    const recall = await src("public.raise_key_recall_tasks(uuid, uuid)");
    expect(recall).toMatch(/join properties p on p\.id = m\.property_id\s+and p\.org_id = m\.org_id/);
    expect(recall).toMatch(/where k\.property_id = m\.property_id\s+and k\.org_id = m\.org_id\s+and k\.status in \('in_office', 'checked_out'\)\) as held/);
    expect(recall).toMatch(/select 1 from property_keys k\s+where k\.property_id = m\.property_id\s+and k\.org_id = m\.org_id\s+and k\.status in/);
    const expire = await src("public.expire_mandates()");
    expect(expire).toMatch(/join properties p on p\.id = m\.property_id\s+and p\.org_id = m\.org_id\s+where m\.status = 'active'/);
    for (const s of [recall, expire]) expect(s).not.toMatch(/current_org_id/);
  });
});
