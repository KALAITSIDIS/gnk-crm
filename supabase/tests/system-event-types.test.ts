import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { CHECK_0134 } from "./revert-0134";
import { CHECK_0138, REVERT_0138_SQL, readMigration0138 } from "./revert-0138";

/**
 * A session cannot write the records only the system writes —
 * `enquiry_alert`, `lead_escalation` and `opened` (T-system-event-types,
 * migration 0138).
 *
 * THE GAP (reproduced at 0137 by this file): events_insert admitted a
 * session's event of any type but six reserved strings; three more are
 * written only by the system and machines read them as its word —
 * claim_notification_jobs closes a pending desk alert on an `enquiry_alert`
 * 'sent' line (shown below at 0134's policy: a forged line closes a real
 * enquiry's alert); an `opened` line renders as a buyer's view of a share
 * link; `lead_escalation` is the escalation's record.
 *
 * THE FIX PINNED HERE: events_insert refuses those three under any
 * entity_type; 0128 / 0131 / 0134's clauses are kept; the definers (some sign
 * with the caller — the retry and recovery requests) and the service role
 * still write them.
 *
 * TWO KINDS OF CALLER: supabase-js through PostgREST (an aal2 agent of a
 * throwaway organisation — the shape of the attack) and `pg` as postgres in
 * transactions that are always rolled back (the door and the claim — an
 * uncommitted job is invisible to the local alert cron — the session role
 * switch, the migration replay).
 *
 * Requires the local Supabase stack. Run: npm run test:rls
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const SLUG = `system-events-${RUN}`;
const RESERVED = ["enquiry_alert", "lead_escalation", "opened"] as const;
const RLS_REFUSAL = 'new row violates row-level security policy for table "events"';

let o: Client;
let svc: SupabaseClient;
let agent: TestUser;
const userIds: string[] = [];
let n = 0;

type R = { error: { code?: string; message?: string } | null; status: number };
async function sessionEvent(entityType: string, eventType: string, payload: Record<string, unknown> = {}): Promise<R> {
  return agent.client
    .from("events")
    .insert({ org_id: ORG, actor_id: agent.id, entity_type: entityType, entity_id: randomUUID(), event_type: eventType, payload });
}
const insertCheck = async () =>
  (
    await o.query<{ c: string }>(
      "select pg_get_expr(polwithcheck, polrelid) as c from pg_policy where polrelid = 'public.events'::regclass and polname = 'events_insert'",
    )
  ).rows[0]!.c;
async function rolledBack(body: (notices: string[]) => Promise<void>) {
  const notices: string[] = [];
  const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
  o.on("notice", onNotice);
  await o.query("begin");
  await o.query("set local lock_timeout = '5s'");
  await o.query(`set local search_path = "$user", public, extensions`);
  try {
    await body(notices);
  } finally {
    await o.query("rollback");
    o.off("notice", onNotice);
  }
}
/**
 * Inside a transaction: one lead event written as the agent's SESSION (role authenticated, aal2), in a savepoint —
 * null when it was accepted, the error message when the policy refused it (the savepoint undoes the role switch too).
 */
async function asSessionInsert(eventType: string, payload: Record<string, unknown> = {}, entityId: string = randomUUID()) {
  await o.query("savepoint sess");
  try {
    await o.query("set local role authenticated");
    await o.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: agent.id, role: "authenticated", aal: "aal2" })]);
    await o.query(
      "insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload) values ($1, $2, 'lead', $3, $4, $5::jsonb)",
      [ORG, agent.id, entityId, eventType, JSON.stringify(payload)],
    );
    await o.query("reset role");
    await o.query("select set_config('request.jwt.claims', '', true)");
    await o.query("release savepoint sess");
    return null;
  } catch (e) {
    await o.query("rollback to savepoint sess");
    return (e as Error).message;
  }
}
/** Inside a transaction: a real website enquiry through the door (its desk-alert job is pending). */
async function enquiry() {
  const { rows } = await o.query<{ lead_id: string }>(
    "select lead_id from submit_public_enquiry($1, 'ZZTEST Visitor', $2, null, 'ZZTEST forged alert probe')",
    [SLUG, `se-${RUN}-${++n}@example.invalid`],
  );
  return rows[0]!.lead_id;
}
async function claimFor(lead: string) {
  const { rows } = await o.query<{ kind: string }>(
    "select kind from claim_notification_jobs(p_worker => $1, p_limit => 5, p_lease_seconds => 60, p_lead_id => $2)",
    [`se-${RUN}`, lead],
  );
  return rows.map((r) => r.kind);
}
/** The diagnostic's four figures, after replaying 0138 over 0134's policy. */
async function diagnostic() {
  await o.query(REVERT_0138_SQL);
  const res = await o.query(readMigration0138());
  const results = Array.isArray(res) ? res : [res];
  const m = /^forged_sent_alerts=(\d+) actor_request_lines=(\d+) actor_other_lines=(\d+) boundary=(\d+)$/.exec(
    results[results.length - 1]!.rows[0].existing_rows,
  );
  expect(m, "the last row's shape").not.toBeNull();
  return { sent: Number(m![1]), request: Number(m![2]), other: Number(m![3]), boundary: m![4]! };
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `system events ${RUN}`, SLUG);
  const email = `se-agent-${RUN}@test.local`;
  try {
    agent = await createTestUser(svc, email, "agent", ORG);
    userIds.push(agent.id);
  } catch (e) {
    const { rows } = await o.query<{ id: string }>("select id from auth.users where email = $1", [email]);
    for (const r of rows) userIds.push(r.id);
    throw e;
  }
});

afterAll(async () => {
  await o.query("delete from notification_jobs where org_id = $1", [ORG]);
  await o.query("delete from leads where org_id = $1", [ORG]);
  for (const id of userIds) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) console.warn(`afterAll: auth user ${id} not deleted: ${error.message}`);
  }
  await o.query("delete from profiles where org_id = $1", [ORG]);
  await o.query("delete from events where org_id = $1", [ORG]);
  await o.query("delete from events_chain_checkpoint where org_id = $1", [ORG]);
  await o.query("delete from chain_checks where org_id = $1", [ORG]);
  await o.query("delete from deal_stages where org_id = $1", [ORG]);
  await o.query("delete from districts where org_id = $1", [ORG]);
  await o.query("delete from organizations where id = $1", [ORG]);
  await o.end();
});

// ---------------------------------------------------------------------------
describe("1. a session cannot write the system's records", () => {
  for (const [entityType, eventType] of [
    ["lead", "enquiry_alert"],
    ["lead", "lead_escalation"],
    ["share_link", "opened"],
    ["contact", "enquiry_alert"],
    ["deal", "opened"],
  ] as const) {
    it(`PostgREST, an aal2 agent: ${entityType} ${eventType} — refused (403 / 42501), under any entity_type`, async () => {
      const r = await sessionEvent(entityType, eventType, eventType === "enquiry_alert" ? { outcome: "sent" } : {});
      expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
      expect(r.error?.message).toBe(RLS_REFUSAL);
      expect(r.status).toBe(403);
    });
  }

  it("a forged 'sent' line can no longer close a real enquiry's desk alert: the forge is refused, the job is handed out", async () => {
    await rolledBack(async () => {
      const lead = await enquiry();
      expect(await asSessionInsert("enquiry_alert", { outcome: "sent" }, lead)).toContain("row-level security");
      expect(await claimFor(lead)).toContain("enquiry_desk_alert");
    });
  });

  it("the gap, at 0134's policy (the rollback): the same forge is accepted and closes the alert as already sent", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0138_SQL);
      const lead = await enquiry();
      expect(await asSessionInsert("enquiry_alert", { outcome: "sent" }, lead)).toBeNull();
      expect(await claimFor(lead), "nothing to send — the desk is never told").not.toContain("enquiry_desk_alert");
      const job = await o.query("select state, last_result from notification_jobs where lead_id = $1 and kind = 'enquiry_desk_alert'", [lead]);
      expect(job.rows[0]).toEqual({ state: "accepted", last_result: "legacy_sender" });
    });
  });
});

describe("2. what still writes them, and what a session still may", () => {
  it("a session's ordinary event is still accepted (201)", async () => {
    const r = await sessionEvent("lead", "called");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.status).toBe(201);
  });

  it("the service role still writes all three (the worker, the fixtures)", async () => {
    for (const t of RESERVED) {
      const { error } = await svc
        .from("events")
        .insert({ org_id: ORG, actor_id: null, entity_type: "lead", entity_id: randomUUID(), event_type: t, payload: {} });
      expect(error, t).toBeNull();
    }
  });

  it("the public share page, called AS anon, still writes its own `opened` line (a definer: the policy does not bind it)", async () => {
    await rolledBack(async () => {
      const token = randomBytes(24).toString("hex");
      const sha = createHash("sha256").update(token).digest("hex");
      const { rows } = await o.query<{ id: string }>(
        "insert into share_links (org_id, token_sha256, expires_at, created_by) values ($1, $2, now() + interval '1 day', $3) returning id",
        [ORG, sha, agent.id],
      );
      await o.query("set local role anon");
      await o.query("select resolve_share_link($1)", [sha]);
      await o.query("reset role");
      const c = await o.query("select count(*)::int as n from events where entity_id = $1 and event_type = 'opened' and actor_id is null", [rows[0]!.id]);
      expect(c.rows[0].n).toBe(1);
    });
  });

  it("the policy is 0138's: 0128's, 0131's and 0134's clauses kept verbatim, the new one beside them", async () => {
    await rolledBack(async () => {
      expect(await insertCheck()).toBe(CHECK_0138);
    });
  });
});

describe("3. the migration itself (rolled back)", () => {
  it("replays over 0134's policy: preflight, postflight, the diagnostic as its last row, the boundary kept as the policy's comment", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0138_SQL);
      expect(await insertCheck()).toBe(CHECK_0134);
      const res = await o.query(readMigration0138());
      const results = Array.isArray(res) ? res : [res];
      const maxNow = (await o.query<{ m: string }>("select coalesce(max(id), 0)::text as m from events")).rows[0]!.m;
      expect(results[results.length - 1]!.rows[0].existing_rows).toMatch(
        new RegExp(`^forged_sent_alerts=\\d+ actor_request_lines=\\d+ actor_other_lines=\\d+ boundary=${maxNow}$`),
      );
      expect(notices.some((m) => m.startsWith("0138: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0138: postflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0138: existing rows (read-only, nothing repaired) — forged_sent_alerts="))).toBe(true);
      expect(await insertCheck()).toBe(CHECK_0138);
      const comment = (
        await o.query<{ c: string }>("select obj_description(oid, 'pg_policy') as c from pg_policy where polrelid = 'public.events'::regclass and polname = 'events_insert'")
      ).rows[0]!.c;
      expect(comment).toBe(`0138 enforcement boundary: from event id > ${maxNow} no session may write an enquiry_alert / lead_escalation / opened event.`);
    });
  });

  it("the diagnostic counts each shape in its own column — and repairs nothing", async () => {
    await rolledBack(async () => {
      const before = await diagnostic();
      await o.query(REVERT_0138_SQL);
      const plants = [randomUUID(), randomUUID(), randomUUID()];
      // pre-0138 session lines: a forged 'sent' (the claim's shape), and two others
      expect(await asSessionInsert("enquiry_alert", { outcome: "sent" }, plants[0])).toBeNull();
      expect(await asSessionInsert("lead_escalation", {}, plants[1])).toBeNull();
      expect(await asSessionInsert("opened", {}, plants[2])).toBeNull();
      // the shape the staff-called definers sign (written here as postgres, as the definer would)
      await o.query(
        `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
         values ($1, $2, 'lead', $3, 'enquiry_alert', '{"outcome":"retry_requested"}'::jsonb)`,
        [ORG, agent.id, randomUUID()],
      );
      // system lines with no actor: counted nowhere
      for (const t of RESERVED) {
        await o.query(
          `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload) values ($1, null, 'lead', $2, $3, '{"outcome":"sent"}'::jsonb)`,
          [ORG, randomUUID(), t],
        );
      }
      const after = await diagnostic();
      expect({ sent: after.sent, request: after.request, other: after.other }).toEqual({
        sent: before.sent + 1,
        request: before.request + 1,
        other: before.other + 2,
      });
      const kept = await o.query("select count(*)::int as n from events where entity_id = any($1)", [plants]);
      expect(kept.rows[0].n, "nothing repaired").toBe(3);
    });
  });

  it("the preflight refuses, changing nothing, when events_insert is not 0134's (applied twice, or drifted)", async () => {
    await rolledBack(async () => {
      await o.query("savepoint s");
      await expect(o.query(readMigration0138())).rejects.toThrow(/0138 aborted: events_insert's check is not 0134's/);
      await o.query("rollback to savepoint s");
      await o.query("alter policy events_insert on public.events with check (org_id = (select current_org_id()) and actor_id = (select auth.uid()))");
      const drifted = await insertCheck();
      await o.query("savepoint t");
      await expect(o.query(readMigration0138())).rejects.toThrow(/0138 aborted: events_insert's check is not 0134's/);
      await o.query("rollback to savepoint t");
      expect(await insertCheck(), "nothing was changed").toBe(drifted);
    });
  });

  it("the postflight refuses the file's own text without the new clause — the altered policy goes with it", async () => {
    const bad = readMigration0138().replace("    and event_type not in ('enquiry_alert', 'lead_escalation', 'opened')\n", "");
    expect(bad).not.toBe(readMigration0138());
    await rolledBack(async () => {
      await o.query(REVERT_0138_SQL);
      await o.query("savepoint s");
      await expect(o.query(bad)).rejects.toThrow(/0138 postflight: events_insert is not the 0138 check/);
      await o.query("rollback to savepoint s");
      expect(await insertCheck()).toBe(CHECK_0134);
    });
  });

  it("the file refuses before it changes anything", () => {
    const sql = readMigration0138().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0138 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0138 postflight")).toBeGreaterThan(firstChange);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0138();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0138 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("the rollback recipe restores 0134's policy — and with it a session's right to write all three", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0138_SQL);
      expect(await insertCheck()).toBe(CHECK_0134);
      for (const t of RESERVED) expect(await asSessionInsert(t), t).toBeNull();
    });
  });

  it("the restore pack's 0138 row reads true now and false on 0134's policy", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'SECURITY: a session cannot write the system''s enquiry_alert / lead_escalation / opened (0138)'");
    expect(from, "the pack carries the 0138 row").toBeGreaterThan(0);
    const to = pack.indexOf("\n  union all\n", from);
    const row = `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now).toMatchObject({ expected: "true", actual: "true" });
    await rolledBack(async () => {
      await o.query(REVERT_0138_SQL);
      expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
    });
  });
});
