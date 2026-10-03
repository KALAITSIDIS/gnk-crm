import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { BODY_0114_MD5, REVERT_0136_SQL, SIG_0136 as SIG, readMigration0136 } from "./revert-0136";

/**
 * The website enquiry's round-robin routing counts only its own organisation's
 * leads and `assigned` events (T-routing-own-org, migration 0136).
 *
 * THE GAP (reproduced at 0135 by this file): submit_public_enquiry() — the
 * door the Next route calls as the service role for every website enquiry —
 * in `round_robin` mode picks, among the organisation's routed agents, the one
 * with the fewest open leads, then the one assigned longest ago. Both counts
 * were unbounded by organisation, and another organisation's session may write
 * both inputs (a lead naming our agent as its assignee; an `assigned` lead
 * event naming our agent): organisation B steered which of OUR agents got the
 * next enquiry.
 *
 * THE FIX PINNED HERE: `l.org_id = v_org_id` and `e.org_id = v_org_id`; the
 * function is otherwise 0114's. NOT pinned (BACKLOG): the mode and agent list
 * are one GLOBAL row any organisation's admin may rewrite; a member of our own
 * organisation may still steer the counts.
 *
 * Every test runs in a transaction that is always rolled back. The routing row
 * (cyprus_config.lead_routing, `off` on the shared stack and on hosted) is set
 * there; the other organisation's writes are made there AS ITS AGENT'S SESSION
 * (role authenticated, its JWT claims at aal2 — leads_insert / events_insert
 * apply), and the door is called as postgres. Nothing persists between tests.
 *
 * Requires the local Supabase stack. Run: npm run test:rls
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID(); // ours: the door and the routed agents
const OTHER_ORG = randomUUID(); // theirs: the steering writes
const RUN = Date.now().toString(36);
const SLUG = `routing-own-${RUN}`;

let o: Client;
let svc: SupabaseClient;
let a1: TestUser; // our first routed agent (the older profile: the final tie-break)
let a2: TestUser; // our second routed agent
let theirAgent: TestUser;
const userIds: string[] = [];
let n = 0;

async function bodyMd5() {
  const { rows } = await o.query<{ md5: string }>(`select md5(replace(prosrc, E'\\r', '')) as md5 from pg_proc where oid = '${SIG}'::regprocedure`);
  return rows[0]!.md5;
}
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
/** Inside a transaction: the global routing row. */
async function routing(mode: "round_robin" | "off", agents: string[]) {
  await o.query(
    `insert into cyprus_config (key, value) values ('lead_routing', $1::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify({ mode, agents })],
  );
}
/** Inside a transaction: one website enquiry through the door; the lead and the agent it was routed to (or null). */
async function route(): Promise<{ lead: string; agent: string | null }> {
  const { rows } = await o.query<{ lead_id: string }>(
    "select lead_id from submit_public_enquiry($1, 'ZZTEST Visitor', $2, null, 'ZZTEST routing probe')",
    [SLUG, `rr-${RUN}-${++n}@example.invalid`],
  );
  expect(rows, "the door accepted the enquiry").toHaveLength(1);
  const a = await o.query<{ assigned_agent_id: string | null }>("select assigned_agent_id from leads where id = $1", [rows[0]!.lead_id]);
  return { lead: rows[0]!.lead_id, agent: a.rows[0]!.assigned_agent_id };
}

/** Inside a transaction: `body` runs as the other organisation's agent's session (RLS applies), then postgres again. */
async function asTheirSession(body: () => Promise<void>) {
  await o.query("set local role authenticated");
  await o.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: theirAgent.id, role: "authenticated", aal: "aal2" }),
  ]);
  try {
    await body();
  } finally {
    await o.query("reset role");
    await o.query("select set_config('request.jwt.claims', '', true)");
  }
}
/** Their open leads naming one of our agents — a session write leads_insert admits (no RETURNING: the row is not theirs to read). */
async function theirLeadsNaming(agentId: string, count = 1) {
  await asTheirSession(async () => {
    for (let i = 0; i < count; i++) {
      await o.query(
        "insert into leads (id, org_id, source, channel, status, message, assigned_agent_id) values ($1, $2, 'other', 'phone', 'new', 'ZZTEST their lead', $3)",
        [randomUUID(), OTHER_ORG, agentId],
      );
    }
  });
}
/** Their `assigned` lead event naming one of our agents — a session write events_insert admits. */
async function theirAssignedEventNaming(agentId: string) {
  await asTheirSession(async () => {
    await o.query(
      `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
       values ($1, $2, 'lead', $3, 'assigned', jsonb_build_object('to', $4::text))`,
      [OTHER_ORG, theirAgent.id, randomUUID(), agentId],
    );
  });
}
/** The diagnostic's two counts, as 0136's last row reports them, after replaying it over 0114's body. */
async function diagnostic() {
  await o.query(REVERT_0136_SQL);
  const res = await o.query(readMigration0136());
  const results = Array.isArray(res) ? res : [res];
  const m = /^leads_assigned_across_orgs=(\d+) assigned_events_across_orgs=(\d+)$/.exec(results[results.length - 1]!.rows[0].existing_rows);
  expect(m, "the last row's shape").not.toBeNull();
  return { leads: Number(m![1]), events: Number(m![2]) };
}
/** 0136's function statement, optionally edited — for the single-predicate checks. */
function fn0136(edit: (s: string) => string = (s) => s) {
  const sql = readMigration0136();
  const a = sql.indexOf("create or replace function public.submit_public_enquiry(");
  const b = sql.indexOf("end $fn$;", a) + "end $fn$;".length;
  const text = sql.slice(a, b);
  const edited = edit(text);
  return { text: edited, changed: edited !== text };
}
const LEADS_PRED = ["where l.org_id = v_org_id\n                  and l.assigned_agent_id", "where l.assigned_agent_id"] as const;
const EVENTS_PRED = ["where e.org_id = v_org_id\n                  and e.entity_type", "where e.entity_type"] as const;

// ---------------------------------------------------------------------------
beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `routing own ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER_ORG, `routing other ${RUN}`, `routing-other-${RUN}`);
  const user = async (who: string, role: "agent", org: string) => {
    const email = `ro-${who}-${RUN}@test.local`;
    try {
      const u = await createTestUser(svc, email, role, org);
      userIds.push(u.id);
      return u;
    } catch (e) {
      const { rows } = await o.query<{ id: string }>("select id from auth.users where email = $1", [email]);
      for (const r of rows) if (!userIds.includes(r.id)) userIds.push(r.id);
      throw e;
    }
  };
  a1 = await user("a1", "agent", ORG);
  a2 = await user("a2", "agent", ORG);
  theirAgent = await user("their-agent", "agent", OTHER_ORG);
  // the final tie-break is the older profile: make it a1, explicitly
  await o.query("update profiles set created_at = now() - interval '2 days' where id = $1", [a1.id]);
  await o.query("update profiles set created_at = now() - interval '1 day' where id = $1", [a2.id]);
});

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from notification_jobs where org_id = $1", [org]);
    await o.query("delete from leads where org_id = $1", [org]);
  }
  for (const id of userIds) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) console.warn(`afterAll: auth user ${id} not deleted: ${error.message}`);
  }
  for (const org of [ORG, OTHER_ORG]) {
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
describe("1. another organisation's leads and `assigned` events no longer steer which of our agents gets the next enquiry", () => {
  it("their `assigned` event naming a1 does not count as a1's last assignment", async () => {
    await rolledBack(async () => {
      await theirAssignedEventNaming(a1.id);
      await routing("round_robin", [a1.id, a2.id]);
      expect((await route()).agent, "neither of ours was ever assigned here: the older profile, a1").toBe(a1.id);
    });
  });

  it("their open leads naming a1 do not count against a1", async () => {
    await rolledBack(async () => {
      await theirLeadsNaming(a1.id, 3);
      await routing("round_robin", [a1.id, a2.id]);
      expect((await route()).agent, "neither of ours has an open lead: the older profile, a1").toBe(a1.id);
    });
  });
});

describe("2. our own counts still steer the rotation", () => {
  it("our own open lead on a1 sends the next enquiry to a2", async () => {
    await rolledBack(async () => {
      await o.query("insert into leads (org_id, source, channel, status, assigned_agent_id) values ($1, 'other', 'phone', 'new', $2)", [ORG, a1.id]);
      await routing("round_robin", [a1.id, a2.id]);
      expect((await route()).agent).toBe(a2.id);
    });
  });

  it("with equal open leads, our own latest `assigned` naming a1 sends the next to a2 — and the rotation alternates", async () => {
    await rolledBack(async () => {
      await o.query(
        `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
         values ($1, null, 'lead', $2, 'assigned', jsonb_build_object('to', $3::text))`,
        [ORG, randomUUID(), a1.id],
      );
      await routing("round_robin", [a1.id, a2.id]);
      expect((await route()).agent).toBe(a2.id);
      // a2 now holds one open enquiry, a1 none: the next goes to a1
      expect((await route()).agent).toBe(a1.id);
    });
  });

  it("`off` assigns nobody and writes no `assigned` event for the lead", async () => {
    await rolledBack(async () => {
      await routing("off", [a1.id, a2.id]);
      const { lead, agent } = await route();
      expect(agent).toBeNull();
      const ev = await o.query("select count(*)::int as n from events where entity_type = 'lead' and entity_id = $1 and event_type = 'assigned'", [lead]);
      expect(ev.rows[0].n).toBe(0);
    });
  });
});

describe("3. the function keeps its shape and its callers", () => {
  it("a definer owned by postgres, search_path public, its comment 0114's plus one sentence", async () => {
    const { rows } = await o.query(
      `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig, obj_description(p.oid, 'pg_proc') as comment
         from pg_proc p where p.oid = '${SIG}'::regprocedure`,
    );
    expect(rows[0]).toMatchObject({ prosecdef: true, owner: "postgres", proconfig: ["search_path=public"] });
    let before = "";
    await rolledBack(async () => {
      await o.query(REVERT_0136_SQL);
      before = (await o.query(`select obj_description('${SIG}'::regprocedure, 'pg_proc') as c`)).rows[0].c;
    });
    expect(rows[0].comment).toBe(`${before} 0136: round-robin counts only this organisation's open leads and \`assigned\` events.`);
  });

  it("the body is 0114's but the two predicates and their comment", async () => {
    const now = (await o.query<{ src: string }>(`select prosrc as src from pg_proc where oid = '${SIG}'::regprocedure`)).rows[0]!.src;
    let before = "";
    await rolledBack(async () => {
      await o.query(REVERT_0136_SQL);
      before = (await o.query<{ src: string }>(`select prosrc as src from pg_proc where oid = '${SIG}'::regprocedure`)).rows[0]!.src;
    });
    const stripped = now
      .replace(
        "     -- 0136: both counts are THIS organisation's — another organisation's\n     -- sessions may write leads naming our agents and `assigned` events about\n     -- them, and must not steer which of our agents is next.\n",
        "",
      )
      .replace(...LEADS_PRED)
      .replace(...EVENTS_PRED);
    expect(stripped).toBe(before);
    expect(now).not.toBe(before);
  });

  it("executable by the service role, by no session role", async () => {
    const asAnon = await anonClient().rpc("submit_public_enquiry", { p_org_slug: SLUG, p_name: "x", p_email: "x@example.invalid", p_phone: null, p_message: "x" });
    expect(asAnon.error?.code).toBe("42501");
    const asAgent = await a1.client.rpc("submit_public_enquiry", { p_org_slug: SLUG, p_name: "x", p_email: "x@example.invalid", p_phone: null, p_message: "x" });
    expect(asAgent.error?.code).toBe("42501");
    const { rows } = await o.query(
      `select has_function_privilege('anon', '${SIG}', 'execute') as anon, has_function_privilege('authenticated', '${SIG}', 'execute') as auth,
              has_function_privilege('service_role', '${SIG}', 'execute') as svc`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });
});

describe("4. the migration itself (rolled back)", () => {
  it("replays over 0114's body: preflight, postflight, the diagnostic as its last row, the same body as applied", async () => {
    const applied = await bodyMd5();
    await rolledBack(async (notices) => {
      await o.query(REVERT_0136_SQL);
      expect(await bodyMd5()).toBe(BODY_0114_MD5);
      const res = await o.query(readMigration0136());
      const results = Array.isArray(res) ? res : [res];
      const last = results[results.length - 1]!;
      expect(last.rows).toHaveLength(1);
      expect(last.rows[0].existing_rows).toMatch(/^leads_assigned_across_orgs=\d+ assigned_events_across_orgs=\d+$/);
      expect(notices.some((m) => m.startsWith("0136: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0136: postflight passed"))).toBe(true);
      expect(await bodyMd5()).toBe(applied);
    });
  });

  it("the diagnostic counts exactly one more of each for one planted lead and one planted event — and repairs nothing", async () => {
    await rolledBack(async () => {
      const before = await diagnostic();
      const lead = randomUUID();
      await asTheirSession(async () => {
        await o.query(
          "insert into leads (id, org_id, source, channel, status, message, assigned_agent_id) values ($1, $2, 'other', 'phone', 'new', 'ZZTEST their lead', $3)",
          [lead, OTHER_ORG, a2.id],
        );
      });
      await theirAssignedEventNaming(a2.id);
      const after = await diagnostic();
      expect(after).toEqual({ leads: before.leads + 1, events: before.events + 1 });
      const still = await o.query("select assigned_agent_id from leads where id = $1", [lead]);
      expect(still.rows[0].assigned_agent_id, "nothing repaired").toBe(a2.id);
    });
  });

  for (const [what, edit] of [
    ["both predicates missing", (s: string) => s.replace(...LEADS_PRED).replace(...EVENTS_PRED)],
    ["the leads predicate missing", (s: string) => s.replace(...LEADS_PRED)],
    ["the events predicate missing", (s: string) => s.replace(...EVENTS_PRED)],
  ] as const) {
    it(`the postflight refuses the file's own text with ${what} — the replaced body goes with the refusal`, async () => {
      const bad = edit(readMigration0136());
      expect(bad, "the edit really went in").not.toBe(readMigration0136());
      await rolledBack(async () => {
        await o.query(REVERT_0136_SQL);
        await o.query("savepoint s");
        await expect(o.query(bad)).rejects.toThrow(/0136 postflight: the round-robin counts are not bounded by the enquiry's organisation/);
        await o.query("rollback to savepoint s");
        expect(await bodyMd5()).toBe(BODY_0114_MD5);
      });
    });
  }

  for (const [what, drift, refusal] of [
    ["applied twice (the body is already 0136's)", "", /0136 aborted: submit_public_enquiry is not 0114's definer body/],
    ["a body that differs from 0114's", "__REVERT_EDITED__", /0136 aborted: submit_public_enquiry is not 0114's definer body/],
    ["not a definer", `alter function ${SIG} security invoker`, /0136 aborted: submit_public_enquiry is not 0114's definer body \(md5 missing/],
    ["a session role may execute it", `grant execute on function ${SIG} to authenticated`, /0136 aborted: a session role may execute submit_public_enquiry/],
    ["the service role may not execute it", `revoke execute on function ${SIG} from service_role`, /0136 aborted: the service role may not execute submit_public_enquiry/],
    [
      "an overload beside it",
      "create function public.submit_public_enquiry(p text) returns int language sql as $f$ select 0 $f$",
      /0136 aborted: submit_public_enquiry is missing or overloaded/,
    ],
  ] as const) {
    it(`the preflight refuses: ${what}`, async () => {
      await rolledBack(async () => {
        if (drift === "__REVERT_EDITED__") {
          await o.query(REVERT_0136_SQL.replace("-- A way to reply is the point of an enquiry.", "-- A way to reply is the point of an enquiry (edited by hand)."));
        } else if (drift) {
          await o.query(REVERT_0136_SQL);
          await o.query(drift);
        }
        const md5 = await bodyMd5();
        await o.query("savepoint s");
        await expect(o.query(readMigration0136())).rejects.toThrow(refusal);
        await o.query("rollback to savepoint s");
        expect(await bodyMd5(), "the body is as it was").toBe(md5);
      });
    });
  }

  it("the file refuses before it changes anything", () => {
    const sql = readMigration0136().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0136 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0136 postflight")).toBeGreaterThan(firstChange);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0136();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0136 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  for (const [half, plant] of [
    ["their open leads", () => theirLeadsNaming(a1.id, 3)],
    ["their `assigned` event", () => theirAssignedEventNaming(a1.id)],
  ] as const) {
    it(`the rollback recipe restores 0114's body — and with it the steering by ${half}`, async () => {
      await rolledBack(async () => {
        await plant();
        await o.query(REVERT_0136_SQL);
        expect(await bodyMd5()).toBe(BODY_0114_MD5);
        await routing("round_robin", [a1.id, a2.id]);
        expect((await route()).agent, `at 0114 ${half} count against a1`).toBe(a2.id);
      });
    });
  }

  it("the restore pack's 0136 row reads true now, false on 0114's body and false with either predicate missing", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'SECURITY: the website enquiry''s round-robin counts only its own organisation (0136)'");
    expect(from, "the pack carries the 0136 row").toBeGreaterThan(0);
    const to = pack.indexOf("\n  union all\n", from);
    const row = `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now).toMatchObject({ expected: "true", actual: "true" });
    for (const install of [
      () => REVERT_0136_SQL,
      () => {
        const f = fn0136((s) => s.replace(...LEADS_PRED));
        expect(f.changed).toBe(true);
        return f.text;
      },
      () => {
        const f = fn0136((s) => s.replace(...EVENTS_PRED));
        expect(f.changed).toBe(true);
        return f.text;
      },
    ]) {
      await rolledBack(async () => {
        await o.query(install());
        expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
      });
    }
  });
});
