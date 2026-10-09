import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { REVERT_0142_SQL, readMigration0142 } from "./revert-0142";

/**
 * apply_unit_type (0142) called directly, as PostgREST would call it — the
 * rules, locks and races the real-action file (unit-type-apply-actions.test.ts)
 * cannot reach from a server action:
 *
 *   1. who may, and that a refusal reveals nothing about which ids exist;
 *   2. the locks: a wait is BOUNDED (55P03, nothing written); a foreign-key
 *      check onto a held container or unit does not wait (NO KEY UPDATE); a
 *      demotion committed while the call waited is refused under the lock;
 *      one operation id racing on two projects is applied once;
 *   3. a listing manager's own trail is counted (events_select shows a
 *      non-admin only the lines they wrote);
 *   4. the migration replays in a rolled-back transaction, its postflight
 *      refuses each broken variant, and the rollback recipe works;
 *   5. the shape and the restore pack's rows.
 *
 * Sessions are pg connections acting as a user (role authenticated, the JWT
 * claims set) inside a transaction — the 0141 file's `asUser`. A THROWAWAY
 * ORGANISATION and a second one, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SIG = "public.apply_unit_type(uuid, uuid, uuid, text)";

let svc: SupabaseClient;
let o: Client; // observer / postgres
let a: Client; // racer
let b: Client; // racer
let c: Client; // racer
let admin: TestUser;
let manager: TestUser;
let agent: TestUser;
let retired: TestUser;
let otherAdmin: TestUser;
const userIds: string[] = [];
let n = 0;

type Project = { id: string; units: string[]; type: string; unrated: string };

/** A project with three block-A units and one block-B unit, a rated type and an unrated one. */
async function newProject(org = ORG): Promise<Project> {
  n += 1;
  const ref = `ZZUA${TAG}${n}`;
  const { rows } = await o.query<{ id: string }>(
    `insert into properties (org_id, reference, kind, property_type, status) values ($1, $2, 'project', 'apartment', 'available') returning id`,
    [org, ref],
  );
  const id = rows[0]!.id;
  const units: string[] = [];
  for (const [code, block, price] of [["A1", "A", 200000], ["A2", "A", 210000], ["A3", "A", null], ["B1", "B", 300000]] as const) {
    const { rows: u } = await o.query<{ id: string }>(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status, block, unit_number, asking_price)
       values ($1, $2, 'unit', $3, 'apartment', 'available', $4, $5, $6) returning id`,
      [org, `${ref}-${code}`, id, block, code, price],
    );
    units.push(u[0]!.id);
  }
  const { rows: t } = await o.query<{ id: string }>(
    `insert into unit_types (org_id, project_id, code, bedrooms, bathrooms, covered_area_sqm, veranda_sqm, price_per_sqm)
     values ($1, $2, 'T1', 2, 1, 85, 10, 3000) returning id`,
    [org, id],
  );
  const { rows: t2 } = await o.query<{ id: string }>(
    `insert into unit_types (org_id, project_id, code, bedrooms, covered_area_sqm) values ($1, $2, 'T0', 3, 90) returning id`,
    [org, id],
  );
  return { id, units, type: t[0]!.id, unrated: t2[0]!.id };
}

async function asUser(c: Client, uid: string, aal: "aal1" | "aal2" = "aal2") {
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal })]);
}
const CALL = "select public.apply_unit_type($1::uuid, $2::uuid, $3::uuid, $4::text) as r";

/** Call as `user` in a transaction that is ROLLED BACK; resolves to the answer or the error. */
async function tryAs(user: TestUser, args: [string | null, string | null, string | null, string | null], aal: "aal1" | "aal2" = "aal2") {
  await asUser(a, user.id, aal);
  try {
    const { rows } = await a.query<{ r: Record<string, unknown> }>(CALL, args);
    return { answer: rows[0]!.r, error: null as (Error & { code?: string }) | null };
  } catch (e) {
    return { answer: null, error: e as Error & { code?: string } };
  } finally {
    await a.query("rollback");
  }
}

type Settled = { value: { rows: { r: Record<string, unknown> }[] } | null; error: (Error & { code?: string }) | null };
function settled(q: Promise<{ rows: { r: Record<string, unknown> }[] }>): Promise<Settled> {
  return q.then(
    (value) => ({ value, error: null }),
    (error: Error) => ({ value: null, error }),
  );
}
async function pidOf(c: Client) {
  return (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
}
async function waitsOnLock(pid: number) {
  const { rows } = await o.query<{ w: string | null }>("select wait_event_type as w from pg_stat_activity where pid = $1", [pid]);
  return rows[0]?.w === "Lock";
}
async function until(label: string, cond: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`barrier timed out: ${label}`);
}

/** Everything a stamp could have written for a project: unit fields, trail rows, unit-type lines, records. */
async function footprint(p: Project) {
  const { rows } = await o.query(
    `select (select json_agg(json_build_array(bedrooms, bathrooms, covered_area_sqm, veranda_sqm, asking_price) order by id)
               from properties where parent_id = $1) as units,
            (select count(*)::int from price_history where property_id = any($2::uuid[])) as history,
            (select count(*)::int from events where entity_id = any($2::uuid[]) and event_type in ('price_changed', 'updated')) as lines,
            (select count(*)::int from unit_type_applications where project_id = $1) as records`,
    [p.id, p.units],
  );
  return rows[0];
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  a = new Client({ connectionString: DB_URL });
  b = new Client({ connectionString: DB_URL });
  c = new Client({ connectionString: DB_URL });
  await Promise.all([o.connect(), a.connect(), b.connect(), c.connect()]);
  await ensureTestOrg(svc, ORG, `Unit type apply ${RUN}`, `unit-type-apply-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `Unit type apply other ${RUN}`, `unit-type-apply-other-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `ua-admin-${RUN}@test.local`, "admin", ORG);
  manager = await createTestUser(svc, `ua-lm-${RUN}@test.local`, "listing_manager", ORG);
  agent = await createTestUser(svc, `ua-agent-${RUN}@test.local`, "agent", ORG);
  retired = await createTestUser(svc, `ua-retired-${RUN}@test.local`, "admin", ORG);
  otherAdmin = await createTestUser(svc, `ua-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(admin.id, manager.id, agent.id, retired.id, otherAdmin.id);
  await o.query("update profiles set is_active = false where id = $1", [retired.id]);
});

afterEach(async () => {
  for (const x of [a, b, c]) await x.query("rollback").catch(() => undefined);
  await o.query("update profiles set role = 'listing_manager' where id = $1", [manager.id]);
});

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from unit_type_applications where org_id = $1", [org]);
    await o.query("delete from unit_types where org_id = $1", [org]);
    await o.query("delete from tasks where org_id = $1", [org]);
    await o.query("delete from price_history where org_id = $1", [org]);
    await o.query("delete from properties where org_id = $1 and kind = 'unit'", [org]);
    await o.query("delete from properties where org_id = $1", [org]);
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
  await Promise.all([o.end(), a.end(), b.end(), c.end()]);
});

// ---------------------------------------------------------------------------
describe("1. who may — and a refusal reveals nothing", () => {
  it("anon and service_role may not execute it at all (42501)", async () => {
    const args = { p_project_id: randomUUID(), p_unit_type_id: randomUUID(), p_operation_id: randomUUID(), p_block: null };
    expect((await anonClient().rpc("apply_unit_type", args)).error?.code).toBe("42501");
    expect((await svc.rpc("apply_unit_type", args)).error?.code).toBe("42501");
  });

  it("aal1, deactivated, agent: each refused in words, before any row is read", async () => {
    const p = await newProject();
    const before = await footprint(p);
    const args: [string, string, string, string | null] = [p.id, p.type, randomUUID(), null];
    expect((await tryAs(admin, args, "aal1")).error?.message).toBe("Second factor required.");
    expect((await tryAs(retired, args)).error?.message).toBe("Account deactivated.");
    expect((await tryAs(agent, args)).error?.message).toBe("Only admins and listing managers manage units.");
    // the agent hears the same sentence for an id that does not exist: no oracle
    expect((await tryAs(agent, [randomUUID(), randomUUID(), randomUUID(), null])).error?.message).toBe(
      "Only admins and listing managers manage units.",
    );
    expect(await footprint(p)).toEqual(before);
  });

  it("another organisation's project reads exactly like one that does not exist; a unit id is not a container", async () => {
    const p = await newProject();
    const foreign = (await tryAs(otherAdmin, [p.id, p.type, randomUUID(), null])).error?.message;
    const missing = (await tryAs(otherAdmin, [randomUUID(), p.type, randomUUID(), null])).error?.message;
    const unit = (await tryAs(admin, [p.units[0]!, p.type, randomUUID(), null])).error?.message;
    expect([foreign, missing, unit]).toEqual(["Project not found", "Project not found", "Project not found"]);
  });

  it("a type of another project, a missing type, nulls and an over-long block are refused", async () => {
    const p = await newProject();
    const q = await newProject();
    expect((await tryAs(admin, [p.id, q.type, randomUUID(), null])).error?.message).toBe("Type not found on this project");
    expect((await tryAs(admin, [p.id, randomUUID(), randomUUID(), null])).error?.message).toBe("Type not found on this project");
    expect((await tryAs(admin, [null, p.type, randomUUID(), null])).error?.message).toBe("Project not found");
    expect((await tryAs(admin, [p.id, null, randomUUID(), null])).error?.message).toBe("Type not found on this project");
    expect((await tryAs(admin, [p.id, p.type, null, null])).error?.message).toMatch(/out of date/);
    expect((await tryAs(admin, [p.id, p.type, randomUUID(), "x".repeat(21)])).error?.message).toBe("No units in that scope");
    expect((await tryAs(admin, [p.id, p.type, randomUUID(), "Z"])).error?.message).toBe("No units in that scope");
  });
});

// ---------------------------------------------------------------------------
describe("2. locks", () => {
  it("a wait is bounded: a unit held past 3 s answers 55P03 and nothing is written", { timeout: 30_000 }, async () => {
    const p = await newProject();
    const before = await footprint(p);
    await b.query("begin");
    await b.query("update properties set bedrooms = 7 where id = $1", [p.units[1]]); // holds A2
    await asUser(a, admin.id);
    const t0 = Date.now();
    const r = await settled(a.query(CALL, [p.id, p.type, randomUUID(), "A"]));
    const waited = Date.now() - t0;
    await a.query("rollback");
    await b.query("rollback");
    expect(r.error?.code).toBe("55P03");
    expect(waited, "the function's own lock_timeout, not the 8 s statement timeout").toBeLessThan(6_000);
    expect(waited).toBeGreaterThanOrEqual(2_900);
    expect(await footprint(p)).toEqual(before);
  });

  it("NO KEY UPDATE: a foreign-key insert onto the held project and units does not wait", async () => {
    const p = await newProject();
    await asUser(a, admin.id);
    await a.query(CALL, [p.id, p.type, randomUUID(), null]); // holds the project and every unit, uncommitted
    await b.query("begin");
    await b.query("set local lock_timeout = '1s'");
    // a type created under the project (KEY SHARE on it) and a unit's own child row (KEY SHARE on the unit)
    await b.query(`insert into unit_types (org_id, project_id, code) values ($1, $2, 'FK1')`, [ORG, p.id]);
    await b.query(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status)
       values ($1, $2, 'unit', $3, 'apartment', 'available')`,
      [ORG, `ZZUA${TAG}FK${n}`, p.id],
    );
    await b.query("rollback");
    await a.query("rollback");
  });

  it("a demotion committed while the call waited on the project is refused under the lock — nothing written", async () => {
    const p = await newProject();
    const before = await footprint(p);
    await b.query("begin");
    await b.query("select 1 from properties where id = $1 for no key update", [p.id]);
    await asUser(a, manager.id);
    const pid = await pidOf(a);
    const pending = settled(a.query(CALL, [p.id, p.type, randomUUID(), null]));
    await until("the call waits on the project", () => waitsOnLock(pid));
    await o.query("update profiles set role = 'agent' where id = $1", [manager.id]);
    await b.query("commit");
    const r = await pending;
    await a.query("rollback");
    expect(r.error?.message).toBe("Only admins and listing managers manage units.");
    expect(await footprint(p)).toEqual(before);
  });

  it("a press checking a COMMITTED stamp is answered at once, even while another change holds the project past the lock timeout", async () => {
    const p = await newProject();
    const op = randomUUID();
    await asUser(a, admin.id);
    await a.query(CALL, [p.id, p.type, op, null]);
    await a.query("commit");
    const before = await footprint(p);
    await b.query("begin");
    await b.query("select 1 from properties where id = $1 for no key update", [p.id]); // a 0141 reprice, say
    await asUser(a, admin.id);
    const t0 = Date.now();
    const r = await settled(a.query(CALL, [p.id, p.type, op, null]));
    const waited = Date.now() - t0;
    await a.query("rollback");
    await b.query("rollback");
    expect(r.error, "never 55P03 'nothing was changed' for a committed submission").toBeNull();
    expect(r.value!.rows[0]!.r).toMatchObject({ result: "replayed", units: 4 });
    expect(waited, "answered before the project's lock").toBeLessThan(1_500);
    expect(await footprint(p)).toEqual(before);
  });

  it("a double submit on the SAME project, both queued behind the project's lock: one applies, the other replays", async () => {
    const p = await newProject();
    const op = randomUUID();
    await b.query("begin");
    await b.query("select 1 from properties where id = $1 for no key update", [p.id]);
    await asUser(a, admin.id);
    await asUser(c, admin.id);
    const [pidA, pidC] = [await pidOf(a), await pidOf(c)];
    const first = settled(a.query(CALL, [p.id, p.type, op, null]));
    const second = settled(c.query(CALL, [p.id, p.type, op, null]));
    // both have passed the before-the-lock lookup (nothing committed yet) and wait on the project
    await until("both wait on the project", async () => (await waitsOnLock(pidA)) && (await waitsOnLock(pidC)));
    await b.query("commit");
    // whichever got the project first finishes; the other waits for its COMMIT
    const winner = await Promise.race([first.then(() => a), second.then(() => c)]);
    await winner.query("commit");
    const [ra, rc] = await Promise.all([first, second]);
    await (winner === a ? c : a).query("commit");
    expect(ra.error).toBeNull();
    expect(rc.error, "a double submit is never refused as 'already used'").toBeNull();
    expect([ra.value!.rows[0]!.r.result, rc.value!.rows[0]!.r.result].sort()).toEqual(["applied", "replayed"]);
    const f = await footprint(p);
    expect(f.records).toBe(1);
    const { rows } = await o.query<{ n: number }>(
      "select count(*)::int as n from events where entity_id = any($1::uuid[]) and event_type = 'updated'",
      [p.units],
    );
    expect(rows[0]!.n, "one unit-type line per unit").toBe(4);
  });

  it("a unit the caller sees but an UPDATE policy hides refuses the whole stamp — never a partial scope reported applied", async () => {
    const p = await newProject();
    const before = await footprint(p);
    await o.query("begin");
    try {
      await o.query(
        `create policy zz_ut_frozen on public.properties as restrictive for update to authenticated using (id <> '${p.units[1]}'::uuid)`,
      );
      await o.query("set local role authenticated");
      await o.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin.id, role: "authenticated", aal: "aal2" })]);
      await expect(o.query(CALL, [p.id, p.type, randomUUID(), "A"])).rejects.toThrow(
        /Not every unit in that scope could be updated — nothing was changed/,
      );
    } finally {
      await o.query("rollback");
    }
    expect(await footprint(p)).toEqual(before);
  });

  it("one operation id racing on two projects: the first applies, the second is refused when the first commits", async () => {
    const p = await newProject();
    const q = await newProject();
    const op = randomUUID();
    await asUser(a, admin.id);
    await a.query(CALL, [p.id, p.type, op, null]); // applied, uncommitted
    await asUser(b, admin.id);
    const pid = await pidOf(b);
    const pending = settled(b.query(CALL, [q.id, q.type, op, null]));
    // it waits on the first transaction — the organisation's events-chain lock,
    // or the operation record's key, whichever it reaches first
    await until("the second waits on the first", () => waitsOnLock(pid));
    await a.query("commit");
    const r = await pending;
    await b.query("rollback");
    expect(r.error?.message).toMatch(/already used for a different change/);
    expect((await footprint(p)).records).toBe(1);
    expect((await footprint(q)).records).toBe(0);
    expect((await footprint(q)).lines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("3. the trail a listing manager can see", () => {
  it("a listing manager's rated stamp counts their own price lines and commits", async () => {
    const p = await newProject();
    await asUser(a, manager.id);
    const { rows } = await a.query<{ r: Record<string, unknown> }>(CALL, [p.id, p.type, randomUUID(), "A"]);
    await a.query("commit");
    // A1 200000 → 255000, A2 210000 → 255000, A3 null → 255000: three moves
    expect(rows[0]!.r).toMatchObject({ result: "applied", units: 3, price_changed: 3 });
    const { rows: u } = await o.query("select asking_price::text as p from properties where id = any($1::uuid[]) order by id", [p.units.slice(0, 3)]);
    expect(u.map((x) => x.p)).toEqual(["255000.00", "255000.00", "255000.00"]);
  });

  it("an unrated stamp moves no price and records price_changed 0", async () => {
    const p = await newProject();
    await asUser(a, admin.id);
    const { rows } = await a.query<{ r: Record<string, unknown> }>(CALL, [p.id, p.unrated, randomUUID(), null]);
    await a.query("commit");
    expect(rows[0]!.r).toMatchObject({ result: "applied", units: 4, price_changed: 0 });
    expect((await footprint(p)).history).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("4. the migration (rolled back)", () => {
  async function rolledBack(body: (notices: string[]) => Promise<void>) {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
    o.on("notice", onNotice);
    await o.query("begin");
    await o.query("set local lock_timeout = '5s'");
    try {
      await body(notices);
    } finally {
      await o.query("rollback");
      o.off("notice", onNotice);
    }
  }
  const lastRow = (res: unknown) => {
    const results = (Array.isArray(res) ? res : [res]) as { rows: Record<string, unknown>[] }[];
    return results[results.length - 1]!.rows[0]!;
  };

  it("replays over the state before it: preflight, postflight, the diagnostic as its last row", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0142_SQL);
      expect((await o.query("select to_regprocedure($1) as f", [SIG])).rows[0].f).toBeNull();
      const row = lastRow(await o.query(readMigration0142()));
      expect(Object.keys(row)).toEqual(["migration", "type_applied_lines", "unit_types"]);
      expect(row.migration).toBe("0142");
      expect(notices.some((m) => m.startsWith("0142: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0142: postflight passed"))).toBe(true);
    });
  });

  it("the preflight refuses a second application, changing nothing", async () => {
    await rolledBack(async () => {
      await expect(o.query(readMigration0142())).rejects.toThrow(/0142 aborted: a function named apply_unit_type already exists — nothing was changed/);
    });
  });

  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "the operation record read only under the lock (a check of a committed stamp would queue and time out)",
      (s) => {
        const from = s.indexOf("  -- 2b. has this submission already committed?");
        const to = s.indexOf("  -- 3. the container, locked:");
        return from > 0 && to > from ? s.slice(0, from) + s.slice(to) : s;
      },
      /0142 postflight: the operation record is no longer answered before the lock and again under it/,
    ],
    [
      "the operation record read only before the lock (a double submit's twin would be refused)",
      (s) => {
        const from = s.indexOf("  -- 4. AGAIN, under the lock:");
        const to = s.indexOf("  -- 5. the template:");
        return from > 0 && to > from ? s.slice(0, from) + s.slice(to) : s;
      },
      /0142 postflight: the operation record is no longer answered before the lock and again under it/,
    ],
    [
      "the locked units no longer compared with the units in scope",
      (s) => s.replace("  if v_ids <> v_seen then\n    raise exception", "  if false then\n    raise exception"),
      /0142 postflight: the locked units are no longer compared with the units in scope/,
    ],
    [
      "the price read back from before the lock (the defect)",
      (s) => s.replace("asking_price     = coalesce(v_price, u.asking_price)", "asking_price     = coalesce(v_price, null)"),
      /0142 postflight: the price is no longer the type's or the locked row's own/,
    ],
    [
      "the container locked FOR UPDATE (blocks foreign-key checks: the sweeps' deadlock)",
      (s) => s.replace("p.kind in ('project', 'phase')\n     for no key update;", "p.kind in ('project', 'phase')\n     for update;"),
      /0142 postflight: the container and its units \(in id order\) are no longer locked FOR NO KEY UPDATE/,
    ],
    [
      "the units not locked",
      (s) => s.replace("           order by u.id\n             for no key update) s;", "           order by u.id) s;"),
      /0142 postflight: the container and its units \(in id order\) are no longer locked FOR NO KEY UPDATE/,
    ],
    [
      "the caller's re-read under the lock parked in a block comment",
      (s) => s.replace("  -- 3b. the caller, read AGAIN", "  /*").replace("  -- 4. AGAIN, under the lock:", "  */\n  -- 4. AGAIN, under the lock:"),
      /0142 postflight: the caller is no longer read before the lock AND again under it/,
    ],
    [
      "an unchecked UPDATE",
      (s) => s.replace("  get diagnostics v_rows = row_count;\n  if v_rows <> v_scope then", "  v_rows := v_scope;\n  if v_rows <> v_scope then"),
      /0142 postflight: the stamp's or the audit lines' row count is no longer checked/,
    ],
    [
      "a price line of its own",
      (s) =>
        s.replace(
          "  -- 9. one unit-type line per stamped unit",
          "  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)\n  select v_org, v_uid, 'property', t.id, 'price_changed', '{}'::jsonb from unnest(v_ids) as t(id);\n  -- 9. one unit-type line per stamped unit",
        ),
      /0142 postflight: apply_unit_type writes a price line trg_price_history already writes/,
    ],
    [
      "the price lines no longer counted",
      (s) => s.replace("e.event_type = 'price_changed'\n     and e.occurred_at = now()", "e.event_type = 'price_changed'"),
      /0142 postflight: the per-unit price trail is no longer counted/,
    ],
    [
      "no bounded wait",
      // a replacer FUNCTION: in a replacement STRING, "$$" means one "$"
      (s) => s.replace("set lock_timeout = '3s'\nas $$", () => "as $$"),
      /0142 postflight: apply_unit_type lost its signature, jsonb return, SECURITY INVOKER, owner, search_path or lock_timeout/,
    ],
    [
      "SECURITY DEFINER",
      (s) => s.replace("returns jsonb\nlanguage plpgsql\nsecurity invoker", "returns jsonb\nlanguage plpgsql\nsecurity definer"),
      /0142 postflight: apply_unit_type lost its signature/,
    ],
    [
      "executable by anon",
      (s) => s.replace("from public, anon, service_role;\ngrant  execute", "from public, service_role;\ngrant  execute on function public.apply_unit_type(uuid, uuid, uuid, text) to anon;\ngrant  execute"),
      /0142 postflight: apply_unit_type grants are wrong/,
    ],
    [
      "an operation record sessions may rewrite",
      (s) => s.replace("grant select, insert on public.unit_type_applications to authenticated;", "grant select, insert, update on public.unit_type_applications to authenticated;"),
      /0142 postflight: unit_type_applications grants are wrong/,
    ],
    [
      "an operation record without require_aal2",
      (s) =>
        s.replace(
          "create policy require_aal2 on public.unit_type_applications\n  as restrictive for all to authenticated\n  using ((select public.mfa_satisfied()))\n  with check ((select public.mfa_satisfied()));",
          "",
        ),
      /0142 postflight: expected 3 policies on unit_type_applications, found 2/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`the postflight refuses the file with ${label}`, async () => {
      const bad = mutate(readMigration0142());
      expect(bad, "the mutation installed").not.toBe(readMigration0142());
      await rolledBack(async () => {
        await o.query(REVERT_0142_SQL);
        await expect(o.query(bad)).rejects.toThrow(refusal);
      });
    });
  }

  it("the file refuses before it changes anything", () => {
    const sql = readMigration0142().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0142 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0142 postflight")).toBeGreaterThan(firstChange);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0142();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0142 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("the rollback recipe removes exactly the function and the record, and a session's direct unit edit still works", async () => {
    const p = await newProject();
    await rolledBack(async () => {
      await o.query(REVERT_0142_SQL);
      expect((await o.query("select to_regprocedure($1) as f, to_regclass('public.unit_type_applications') as t", [SIG])).rows[0]).toEqual({ f: null, t: null });
      await o.query("set local role authenticated");
      await o.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin.id, role: "authenticated", aal: "aal2" })]);
      const upd = await o.query("update properties set bedrooms = 4 where id = $1", [p.units[0]]);
      expect(upd.rowCount).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
describe("5. the shape", () => {
  it("SECURITY INVOKER, owned by postgres, pg_temp last, a 3 s lock wait, authenticated only, commented", async () => {
    const { rows } = await o.query(
      `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
              has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('service_role', p.oid, 'execute') as svc,
              obj_description(p.oid, 'pg_proc') is not null as commented
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [SIG],
    );
    expect(rows[0]).toEqual({
      prosecdef: false,
      owner: "postgres",
      proconfig: ["search_path=public, pg_temp", "lock_timeout=3s"],
      pub: false,
      anon: false,
      auth: true,
      svc: false,
      commented: true,
    });
  });

  it("the operation record: select + insert for sessions, select for the backup, nothing for anon; RLS and require_aal2", async () => {
    const { rows } = await o.query(
      `select r.relrowsecurity as rls,
              (select array_agg(polname::text order by polname) from pg_policy where polrelid = r.oid) as policies,
              array(select p from unnest(array['select','insert','update','delete','truncate']) p
                     where has_table_privilege('authenticated', r.oid, p)) as auth,
              array(select p from unnest(array['select','insert','update','delete','truncate']) p
                     where has_table_privilege('service_role', r.oid, p)) as svc,
              array(select p from unnest(array['select','insert','update','delete','truncate']) p
                     where has_table_privilege('anon', r.oid, p)) as anon
         from pg_class r where r.oid = 'public.unit_type_applications'::regclass`,
    );
    expect(rows[0]).toEqual({
      rls: true,
      policies: ["require_aal2", "unit_type_applications_insert", "unit_type_applications_select"],
      auth: ["select", "insert"],
      svc: ["select"],
      anon: [],
    });
  });

  it("a session cannot forge a record for another user, nor read the organisation's records as an agent", async () => {
    const p = await newProject();
    await asUser(a, manager.id);
    await expect(
      a.query(
        `insert into unit_type_applications (org_id, operation_id, project_id, unit_type_id, request, units, price_changed, created_by)
         values ($1, $2, $3, $4, md5('x'), 1, 0, $5)`,
        [ORG, randomUUID(), p.id, p.type, admin.id],
      ),
    ).rejects.toThrow(/row-level security/);
    await a.query("rollback");
    await asUser(o, admin.id);
    await o.query(CALL, [p.id, p.type, randomUUID(), null]);
    await o.query("commit");
    await asUser(a, agent.id);
    const seen = await a.query("select count(*)::int as c from unit_type_applications where project_id = $1", [p.id]);
    await a.query("rollback");
    expect(seen.rows[0].c).toBe(0);
  });

  it("the restore pack's 0142 rows pass now, and read a rewritable record or a write-back body as drift", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const rowOf = (start: string) => {
      const from = pack.indexOf(start);
      expect(from, `the pack carries ${start}`).toBeGreaterThan(0);
      const to = pack.indexOf("\n  union all\n", from);
      return `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    };
    const stamp = rowOf("  select 'INTEGRITY: a unit-type stamp commits whole");
    const record = rowOf("  select 'INTEGRITY: a unit-type operation id is unique per organisation");
    for (const row of [stamp, record]) {
      const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
      expect(now.actual).toBe(now.expected);
    }
    // drift: a session-updatable record; a body that writes back a price it read
    await o.query("begin");
    try {
      await o.query("grant update on public.unit_type_applications to authenticated");
      expect((await o.query<{ actual: string }>(record)).rows[0]!.actual).toBe("false");
    } finally {
      await o.query("rollback");
    }
    await o.query("begin");
    try {
      const def = (await o.query<{ d: string }>("select pg_get_functiondef(to_regprocedure($1)) as d", [SIG])).rows[0]!.d;
      await o.query(def.replace("coalesce(v_price, u.asking_price)", "coalesce(v_price, null)"));
      expect((await o.query<{ actual: string }>(stamp)).rows[0]!.actual).toBe("false");
    } finally {
      await o.query("rollback");
    }
  });

  it("the chain verifies for both organisations after everything above", async () => {
    for (const org of [ORG, OTHER_ORG]) {
      const { rows } = await o.query("select ok, reason from verify_events_chain($1::uuid, null::bigint)", [org]);
      expect(rows[0]).toMatchObject({ ok: true });
    }
  });
});
