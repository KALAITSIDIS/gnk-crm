import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { BODY_0093_MD5, REVERT_0140_SQL, SIG_0140 as SIG, readMigration0140 } from "./revert-0140";

/**
 * The dashboard's "won this month" counts a won deal at its CONFIRMED final
 * value (migration 0140; BACKLOG "The dashboard's \"won this month\" lost
 * `final_value` again").
 *
 * THE GAP (reproduced at 0093 by this file — the test marked RED at 0093
 * failed there): 0076 made a won deal count at coalesce(final_value,
 * expected_value) everywhere; 0093 rebuilt admin_dashboard_stats() from 0057's
 * body and undid it for the dashboard tile, which summed the ESTIMATE again.
 * close_deal records the accepted offer's amount as final_value, so nearly
 * every real win reads wrong.
 *
 * The behavioural tests run through PostgREST as an aal2 admin of a throwaway
 * organisation: the function is SECURITY INVOKER, so RLS scopes it to that
 * organisation and its total is exactly this file's own deals. The migration
 * tests replay the file over 0093's body inside rolled-back transactions.
 */

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER = randomUUID();
const RUN = Date.now().toString(36);
const DAY = 86_400_000;

let svc: SupabaseClient;
let o: Client;
let admin: TestUser;
let otherAdmin: TestUser;
const userIds: string[] = [];

async function rolledBack(fn: () => Promise<void>) {
  await o.query("begin");
  try {
    await o.query("set local lock_timeout = '5s'");
    await fn();
  } finally {
    await o.query("rollback");
  }
}

async function wonStage(org: string): Promise<string> {
  const { rows } = await o.query<{ id: string }>(
    "select id from deal_stages where org_id = $1 and deal_type = 'sale' order by is_won desc, sort_order limit 1",
    [org],
  );
  return rows[0]!.id;
}

/** A won deal, as the service role (the close guard binds sessions only). */
async function wonDeal(org: string, est: number | null, fin: number | null, wonAt: Date): Promise<string> {
  const { data, error } = await svc
    .from("deals")
    .insert({
      org_id: org,
      stage_id: await wonStage(org),
      deal_type: "sale",
      title: `DWV ${RUN} ${est}/${fin}`,
      status: "won",
      expected_value: est,
      final_value: fin,
      won_at: wonAt.toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`won deal: ${error.message}`);
  return data.id as string;
}

/** won_month through PostgREST, as the given admin, for a window opening a day ago. */
async function wonMonth(as: TestUser) {
  const since = new Date(Date.now() - DAY).toISOString();
  const { data, error } = await as.client.rpc("admin_dashboard_stats", {
    p_month_start: since,
    p_d7: since,
    p_d30: since,
  });
  if (error) throw new Error(`admin_dashboard_stats: ${error.message}`);
  const w = (data as { won_month: { total: number | string; count: number } }).won_month;
  return { total: Number(w.total), count: w.count };
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `dashboard won ${RUN}`, `dashboard-won-${RUN}`);
  await ensureTestOrg(svc, OTHER, `dashboard won other ${RUN}`, `dashboard-won-other-${RUN}`);
  admin = await createTestUser(svc, `dwv-a-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  otherAdmin = await createTestUser(svc, `dwv-b-${RUN}@test.local`, "admin", OTHER);
  userIds.push(otherAdmin.id);
  // this organisation's wins: one closed at a confirmed price above its
  // estimate, one with no final value recorded, one won before the window
  await wonDeal(ORG, 100_000, 250_000, new Date());
  await wonDeal(ORG, 80_000, null, new Date());
  await wonDeal(ORG, 999_000, 999_000, new Date(Date.now() - 40 * DAY));
  // another organisation's win in the same window (estimate = final: this
  // one pins the scoping alone, whichever value the tile reads)
  await wonDeal(OTHER, 5_000_000, 5_000_000, new Date());
});

afterAll(async () => {
  for (const org of [ORG, OTHER]) await o.query("delete from deals where org_id = $1", [org]);
  for (const id of userIds) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) console.warn(`afterAll: auth user ${id} not deleted: ${error.message}`);
  }
  for (const org of [ORG, OTHER]) {
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
describe("1. the admin's \"won this month\", through PostgREST", () => {
  it("RED at 0093: a won deal counts at its CONFIRMED final value, one without one at its estimate", async () => {
    expect(await wonMonth(admin)).toEqual({ total: 250_000 + 80_000, count: 2 });
  });

  it("only this organisation's wins, only inside the window (another organisation's and an older win are not counted)", async () => {
    const mine = await wonMonth(admin);
    expect(mine.count).toBe(2);
    expect(await wonMonth(otherAdmin)).toEqual({ total: 5_000_000, count: 1 });
  });
});

// ---------------------------------------------------------------------------
describe("2. the function keeps its shape and its callers", () => {
  it("sql, STABLE, SECURITY INVOKER, search_path public, returning jsonb with the same six keys", async () => {
    const { rows } = await o.query<{ ok: boolean; keys: string[] }>(
      `select (not p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=public']
               and pg_get_function_result(p.oid) = 'jsonb'
               and p.prolang = (select oid from pg_language where lanname = 'sql')) as ok,
              (select array_agg(k order by k) from jsonb_object_keys(public.admin_dashboard_stats(now(), now(), now())) k) as keys
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [SIG],
    );
    expect(rows[0]).toEqual({
      ok: true,
      keys: ["lead_sources30", "leads7", "open_pipeline", "property_statuses", "stages", "won_month"],
    });
  });

  it("executable by authenticated and the service role, never by anon", async () => {
    const { rows } = await o.query<{ anon: boolean; auth: boolean; svc: boolean }>(
      `select has_function_privilege('anon', $1, 'execute') as anon,
              has_function_privilege('authenticated', $1, 'execute') as auth,
              has_function_privilege('service_role', $1, 'execute') as svc`,
      [SIG],
    );
    expect(rows[0]).toEqual({ anon: false, auth: true, svc: true });
  });

  it("the body is 0093's but 0076's two lines and a comment", async () => {
    const { rows } = await o.query<{ s: string }>("select replace(prosrc, E'\\r', '') as s from pg_proc where oid = to_regprocedure($1)", [SIG]);
    expect(rows[0]!.s, "the fix is there").toContain("select coalesce(final_value, expected_value, 0) as won_value");
    const back = rows[0]!.s
      .replace(
        "    -- 0140 (0076's rule, undone by 0093): a won deal counts at its CONFIRMED\n    -- final value; the estimate only where none was recorded\n    select coalesce(final_value, expected_value, 0) as won_value",
        "    select coalesce(expected_value, 0) as expected_value",
      )
      .replace("coalesce((select sum(won_value) from won_deals), 0)", "coalesce((select sum(expected_value) from won_deals), 0)");
    const { rows: m } = await o.query<{ m: string }>("select md5($1) as m", [back]);
    expect(m[0]!.m).toBe(BODY_0093_MD5);
  });
});

// ---------------------------------------------------------------------------
describe("3. the migration itself (rolled back)", () => {
  const bodyMd5 = async () =>
    (await o.query<{ m: string }>("select md5(replace(prosrc, E'\\r', '')) as m from pg_proc where oid = to_regprocedure($1)", [SIG])).rows[0]!.m;
  /** won_month as postgres, over a far-future window holding one planted deal (estimate 100, final 250) */
  const plantedTotal = async () => {
    await o.query(
      `insert into deals (org_id, deal_type, stage_id, title, status, expected_value, final_value, won_at)
       values ($1, 'sale', $2, 'DWV planted', 'won', 100, 250, '2999-01-02T00:00:00Z')`,
      [ORG, await wonStage(ORG)],
    );
    const { rows } = await o.query<{ t: string }>(
      "select (public.admin_dashboard_stats('2999-01-01T00:00:00Z', now(), now()) -> 'won_month' ->> 'total') as t",
    );
    return Number(rows[0]!.t);
  };

  it("replays over 0093's body: preflight, postflight, the probe, the summary as its last row", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0140_SQL);
      expect(await bodyMd5()).toBe(BODY_0093_MD5);
      expect(await plantedTotal(), "0093 sums the estimate").toBe(100);
      await o.query("delete from deals where title = 'DWV planted'");
      const res = await o.query(readMigration0140());
      const last = (Array.isArray(res) ? res[res.length - 1] : res) as { rows: { summary: string }[] };
      expect(last.rows[0]!.summary).toBe("won_month_reads_final_value=true probe_total=250 keys=6");
      expect(await plantedTotal()).toBe(250);
    });
  });

  it("the preflight refuses, changing nothing, when the body is not 0093's (applied twice) or anon may execute it", async () => {
    await rolledBack(async () => {
      await o.query("savepoint s");
      await expect(o.query(readMigration0140())).rejects.toThrow(/^0140 aborted: admin_dashboard_stats is not 0093's body and attributes/);
      await o.query("rollback to savepoint s");
      await o.query(REVERT_0140_SQL);
      await o.query(`grant execute on function ${SIG} to anon`);
      await o.query("savepoint t");
      await expect(o.query(readMigration0140())).rejects.toThrow(/^0140 aborted: admin_dashboard_stats's grants are not 0093's/);
      await o.query("rollback to savepoint t");
      expect(await bodyMd5(), "nothing was changed").toBe(BODY_0093_MD5);
    });
  });

  it("the postflight refuses the file's own text without the fix — the replaced function goes with it", async () => {
    const unfixed = readMigration0140()
      .replace("select coalesce(final_value, expected_value, 0) as won_value", "select coalesce(expected_value, 0) as expected_value")
      .replace("coalesce((select sum(won_value) from won_deals), 0)", "coalesce((select sum(expected_value) from won_deals), 0)");
    expect(unfixed).not.toBe(readMigration0140());
    await rolledBack(async () => {
      await o.query(REVERT_0140_SQL);
      await o.query("savepoint s");
      await expect(o.query(unfixed)).rejects.toThrow(/^0140 postflight: won_month does not sum the confirmed final value/);
      await o.query("rollback to savepoint s");
      expect(await bodyMd5()).toBe(BODY_0093_MD5);
    });
  });

  it("the file refuses before it changes anything", () => {
    const sql = readMigration0140().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0140 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0140 postflight")).toBeGreaterThan(firstChange);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0140();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0140 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("the rollback recipe restores 0093's body — and with it the estimate", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0140_SQL);
      expect(await bodyMd5()).toBe(BODY_0093_MD5);
      expect(await plantedTotal()).toBe(100);
    });
  });

  it("the restore pack's 0140 row reads true now and false on 0093's body", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'INTEGRITY: the dashboard''s won this month reads the confirmed final value (0140)'");
    expect(from, "the pack carries the 0140 row").toBeGreaterThan(0);
    const to = pack.indexOf("\n  union all\n", from);
    const row = `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    expect((await o.query<{ expected: string; actual: string }>(row)).rows[0]).toMatchObject({ expected: "true", actual: "true" });
    await rolledBack(async () => {
      await o.query(REVERT_0140_SQL);
      expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
    });
  });
});
