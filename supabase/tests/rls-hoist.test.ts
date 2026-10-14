/**
 * Guard for migrations 0030 and 0147. Requires the local Supabase stack.
 *
 * Every current_org_id() / current_role_gnk() call in an RLS policy must sit
 * inside a `(select …)` wrapper so Postgres evaluates it once per statement
 * instead of once per row (counted 2026-08-11: 21 calls vs 1 on a 20-row
 * scan). 0030 hoisted the 7 paginated list tables, 0100 twelve more policies,
 * and 0147 the last 51 on 19 small tables, so since 0147 the rule is
 * SCHEMA-WIDE: rls_bare_helper_calls() looks at every policy in public,
 * permissive and restrictive, and must be empty. A policy written the old way
 * on any table regresses that silently — this test is what notices. The
 * guard's logic lives in the migration (0147's body) and is NOT duplicated
 * here; the independent scan below exists so a broken guard cannot pass
 * vacuously.
 *
 * rls_hoisted_policy_count() keeps its seven-table scope: it is the presence
 * check (a migration that dropped the list tables' policies would leave
 * "nothing bare" perfectly true).
 *
 * Section "0147 itself" replays the migration over its rollback text
 * (supabase/tests/revert-0147.ts), always inside rolled-back transactions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { COMMENTS_0146_MD5, GUARD_0030_MD5, GUARD_0147_MD5, REVERT_0147_SQL, alters0147, policyOf, readMigration0147 } from "./revert-0147";

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const svc = serviceClient();
const run = Date.now().toString(36);

let plain: TestUser;
let o: Client;

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  plain = await createTestUser(svc, `rls-hoist-${run}@test.local`, "agent", ORG_A);
  o = new Client({ connectionString: DB_URL });
  await o.connect();
});

afterAll(async () => {
  await o.end();
});

/**
 * Every policy in public with a bare helper call, read WITHOUT the guard function: the number of helper calls in its
 * predicates against the number of wrapped ones (a wrapped call contains exactly one call).
 */
async function bareByScan(): Promise<string[]> {
  const { rows } = await o.query<{ name: string }>(
    `select p.tablename || '.' || p.policyname as name
       from pg_policies p
      where p.schemaname = 'public'
        and (select count(*) from regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), '(current_org_id|current_role_gnk)\\(\\)', 'g'))
            <> (select count(*) from regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
                  '\\( SELECT (public\\.)?(current_org_id|current_role_gnk)\\(\\) AS (current_org_id|current_role_gnk)\\)', 'g'))
      order by 1`,
  );
  return rows.map((r) => r.name);
}
async function guard(): Promise<string[]> {
  const { rows } = await o.query<{ name: string }>("select tablename || '.' || policyname as name from public.rls_bare_helper_calls() order by 1");
  return rows.map((r) => r.name);
}
/** Inside a transaction: every policy of the schema, fingerprinted (name, command, flag, roles and both predicates). */
async function fingerprint(): Promise<string> {
  await o.query(`set local search_path = "$user", public, extensions`);
  const { rows } = await o.query<{ f: string }>(
    `select md5(string_agg(tablename || '.' || policyname || '|' || cmd || '|' || permissive || '|' || roles::text || '|'
                           || coalesce(qual, '<none>') || '|' || coalesce(with_check, '<none>'), E'\\n' order by tablename, policyname)) as f
       from pg_policies where schemaname = 'public'`,
  );
  return rows[0]!.f;
}
async function guardMd5(): Promise<string> {
  const { rows } = await o.query<{ m: string }>(
    "select md5(replace(prosrc, E'\\r', '')) as m from pg_proc where oid = 'public.rls_bare_helper_calls()'::regprocedure",
  );
  return rows[0]!.m;
}
async function rolledBack(body: (notices: string[]) => Promise<void>) {
  const notices: string[] = [];
  const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
  o.on("notice", onNotice);
  await o.query("begin");
  try {
    await body(notices);
  } finally {
    await o.query("rollback");
    o.off("notice", onNotice);
  }
}

describe("0030 / 0147 — RLS helpers stay hoisted, schema-wide", () => {
  it("no bare helper call remains on any policy in the schema", async () => {
    const { data, error } = await svc.rpc("rls_bare_helper_calls");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("an independent scan of pg_policies agrees: no policy anywhere calls a helper bare", async () => {
    const bare = await bareByScan();
    console.log(`[evidence] bare helper calls by independent scan: ${bare.length}${bare.length ? ` (${bare.join(", ")})` : ""}`);
    expect(bare).toEqual([]);
  });

  it("the guard is schema-wide: a bare call on a small table, and on a restrictive policy, is reported (rolled back)", async () => {
    await rolledBack(async () => {
      await o.query("alter policy areas_select on public.areas using ((org_id = current_org_id()))");
      await o.query("create policy zz_probe_restrictive on public.unit_types as restrictive for select to authenticated using (current_role_gnk() is not null)");
      const reported = await guard();
      console.log(`[evidence] guard with two planted bare calls: ${JSON.stringify(reported)}`);
      expect(reported).toEqual(["areas.areas_select", "unit_types.zz_probe_restrictive"]);
      expect(await bareByScan()).toEqual(reported);
    });
  });

  // Not a restatement of the tests above: those prove nothing is BARE, this
  // proves the hoist is actually PRESENT. A migration that dropped all 21
  // policies and recreated none would satisfy "no bare calls" perfectly.
  it("all 21 policies on the list tables are hoisted", async () => {
    const { data, error } = await svc.rpc("rls_hoisted_policy_count");
    expect(error).toBeNull();
    expect(data).toBe(21);
  });

  it.each(["rls_bare_helper_calls", "rls_hoisted_policy_count"])(
    "%s is not executable by an ordinary authenticated session",
    async (fn) => {
      const { error } = await plain.client.rpc(fn);
      expect(error).not.toBeNull();
      // Must fail because it is REVOKED, not because it is missing: a dropped
      // function would also error, and this assertion would pass while proving
      // nothing. PostgREST maps a permission failure to 42501.
      expect(error?.code, `unexpected failure: ${error?.message}`).toBe("42501");
    },
  );

  it("the guard kept 0030's grants and shape through 0147's CREATE OR REPLACE — and carries 0147's body", async () => {
    const { rows } = await o.query(
      `select p.proacl::text as acl, p.prosecdef, p.provolatile, p.proconfig, pg_get_function_result(p.oid) as ret
         from pg_proc p where p.oid = 'public.rls_bare_helper_calls()'::regprocedure`,
    );
    expect(rows[0]).toEqual({
      acl: "{postgres=X/postgres,service_role=X/postgres}",
      prosecdef: true,
      provolatile: "s",
      proconfig: ["search_path=pg_catalog"],
      ret: "TABLE(tablename text, policyname text)",
    });
    expect(await guardMd5()).toBe(GUARD_0147_MD5);
  });

  it("no guard comment says helpers are left bare", async () => {
    const { rows } = await o.query<{ c: string }>(
      `select obj_description(p.oid, 'pg_proc') as c from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname in ('rls_bare_helper_calls', 'rls_bare_auth_calls', 'rls_hoisted_policy_count')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.c).not.toMatch(/still bare|7 paginated list tables that still|seven-table scope:/);
  });
});

describe("0147 itself (rolled back)", () => {
  it("replays over its rollback text: preflight, self-check, the summary row — and the schema it leaves is the live one", async () => {
    let live = "";
    await rolledBack(async () => {
      live = await fingerprint();
    });
    await rolledBack(async (notices) => {
      await o.query(REVERT_0147_SQL());
      expect(await fingerprint(), "the rollback text changes the schema").not.toBe(live);
      const res = await o.query(readMigration0147());
      const results = Array.isArray(res) ? res : [res];
      expect(results[results.length - 1]!.rows[0].summary).toBe(
        "0147 applied — 51 policies hoisted on 19 tables; bare helper calls schema-wide: 0; list-table hoisted count: 21",
      );
      expect(notices.some((m) => m.startsWith("0147: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0147: self-check passed"))).toBe(true);
      expect(await fingerprint(), "the replayed schema is the live one, policy for policy").toBe(live);
      expect(await guardMd5()).toBe(GUARD_0147_MD5);
    });
  });

  it("the rollback text restores 0146's catalogue: the 51 bare again, 0030's guard, the three comments", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0147_SQL());
      const bare = await bareByScan();
      expect(bare).toHaveLength(51);
      expect(bare).toEqual(alters0147().map((s) => policyOf(s).join(".")).sort());
      expect(await guardMd5()).toBe(GUARD_0030_MD5);
      expect(await guard(), "0030's guard looks at the seven list tables only").toEqual([]);
      const { rows } = await o.query<{ proname: string; m: string }>(
        `select p.proname, md5(coalesce(obj_description(p.oid, 'pg_proc'), '')) as m from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.proname in ('rls_bare_helper_calls', 'rls_bare_auth_calls', 'rls_hoisted_policy_count')`,
      );
      expect(Object.fromEntries(rows.map((r) => [r.proname, r.m]))).toEqual(COMMENTS_0146_MD5);
    });
  });

  it("the self-check refuses the file with any one of its 51 ALTERs dropped — and nothing is kept", async () => {
    const file = readMigration0147();
    const refused: string[] = [];
    for (const stmt of alters0147()) {
      const bad = file.replace(`${stmt}\n`, "");
      expect(bad, policyOf(stmt).join(".")).not.toBe(file);
      await rolledBack(async () => {
        await o.query(REVERT_0147_SQL());
        const before = await fingerprint();
        await o.query("savepoint s");
        await expect(o.query(bad), policyOf(stmt).join(".")).rejects.toThrow(/0147 self-check: /);
        await o.query("rollback to savepoint s");
        expect(await fingerprint(), "nothing kept").toBe(before);
      });
      refused.push(policyOf(stmt).join("."));
    }
    console.log(`[evidence] 0147 with one ALTER dropped: refused for all ${refused.length}`);
    expect(refused).toHaveLength(51);
  }, 300_000);

  it("the self-check refuses an ALTER that changes a predicate's meaning", async () => {
    const file = readMigration0147();
    const stmt = alters0147().find((s) => s.startsWith("alter policy documents_select on public.documents"))!;
    const changed = stmt.replace("(visibility = 'internal'::text)", "(visibility = 'public'::text)");
    expect(changed).not.toBe(stmt);
    await rolledBack(async () => {
      await o.query(REVERT_0147_SQL());
      await o.query("savepoint s");
      await expect(o.query(file.replace(stmt, () => changed))).rejects.toThrow(
        /0147 self-check: a policy changed MEANING, not just evaluation strategy: documents\.documents_select/,
      );
      await o.query("rollback to savepoint s");
    });
  });

  it("the self-check refuses a widened guard that does not see the whole schema", async () => {
    const file = readMigration0147();
    const narrowed = file.replace(
      "   where p.schemaname = 'public'\n     and replace(replace(replace(replace(\n           coalesce(p.qual,'') || coalesce(p.with_check,''),",
      "   where p.schemaname = 'public' and p.permissive = 'PERMISSIVE'\n     and replace(replace(replace(replace(\n           coalesce(p.qual,'') || coalesce(p.with_check,''),",
    );
    expect(narrowed).not.toBe(file);
    await rolledBack(async () => {
      await o.query(REVERT_0147_SQL());
      await o.query("savepoint s");
      await expect(o.query(narrowed)).rejects.toThrow(/0147 self-check: rls_bare_helper_calls\(\) is not this file's body/);
      await o.query("rollback to savepoint s");
    });
  });

  const drifts: [string, string | null, RegExp][] = [
    ["applied twice (the 51 are already hoisted)", null, /0147 aborted: the bare-helper policies are not the 51/],
    [
      "one of the 51 drifted",
      "alter policy areas_select on public.areas using ((org_id = current_org_id()) and true)",
      /0147 aborted: the bare-helper policies are not the 51 .*areas\.areas_select/,
    ],
    [
      "one of the 51 already hoisted",
      "alter policy unit_types_select on public.unit_types using ((org_id = (select current_org_id())))",
      /0147 aborted: the bare-helper policies are not the 51 .*missing or changed unit_types\.unit_types_select/,
    ],
    [
      "a 52nd bare policy",
      "create policy zz_probe on public.unit_types as restrictive for select to authenticated using (current_role_gnk() is not null)",
      /0147 aborted: the bare-helper policies are not the 51 .*unexpected or changed unit_types\.zz_probe/,
    ],
    ["one of the 51 narrowed to a role", "alter policy areas_select on public.areas to authenticated", /0147 aborted: the bare-helper policies are not the 51 .*areas\.areas_select/],
    [
      "the guard's body drifted",
      "create or replace function public.rls_bare_helper_calls() returns table (tablename text, policyname text) language sql stable security definer set search_path = pg_catalog as $f$ select null::text, null::text where false $f$",
      /0147 aborted: a guard function is not 0030 \/ 0100's \(rls_bare_helper_calls\)/,
    ],
    [
      "the guard granted to authenticated",
      "grant execute on function public.rls_bare_helper_calls() to authenticated",
      /0147 aborted: a guard function is not 0030 \/ 0100's \(rls_bare_helper_calls\)/,
    ],
  ];
  for (const [what, drift, refusal] of drifts) {
    it(`the preflight refuses: ${what} — and changes nothing`, async () => {
      await rolledBack(async () => {
        if (drift !== null) {
          await o.query(REVERT_0147_SQL());
          await o.query(drift);
        }
        const before = await fingerprint();
        const md5 = await guardMd5();
        await o.query("savepoint s");
        await expect(o.query(readMigration0147())).rejects.toThrow(refusal);
        await o.query("rollback to savepoint s");
        expect(await fingerprint()).toBe(before);
        expect(await guardMd5()).toBe(md5);
      });
    });
  }

  it("the file refuses before it changes anything", () => {
    const sql = readMigration0147().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0147 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0147 self-check")).toBeGreaterThan(firstChange);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0147();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0147 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("the restore pack's 0147 row reads 0 now, and 51 on the rollback text", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'PERFORMANCE: no RLS policy in public calls current_org_id() / current_role_gnk() bare (0147)'");
    expect(from, "the pack carries the 0147 row").toBeGreaterThan(0);
    const to = pack.indexOf("\n  union all\n", from);
    const row = `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    expect((await o.query(row)).rows[0]).toMatchObject({ expected: "0", actual: "0" });
    await rolledBack(async () => {
      await o.query(REVERT_0147_SQL());
      expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("51");
    });
  });
});
