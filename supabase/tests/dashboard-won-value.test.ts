import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cyprusMonthStart } from "@/lib/utils/tz";
import { anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
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
 * THE RULE: a won deal at final_value when one is recorded, else at its
 * estimate; a final value of 0 is 0 (coalesce tests for null, not
 * truthiness); a won deal with neither is counted and adds 0 (0093's handling,
 * kept). Open deals stay at their estimate in open_pipeline and stages; lost
 * deals are never a win; the window is won_at >= p_month_start (inclusive, no
 * upper bound — 0018's shape, unchanged), and the app passes the CYPRUS
 * month's first instant (cyprusMonthStart).
 *
 * The behavioural tests run through PostgREST as aal2 users of throwaway
 * organisations: the function is SECURITY INVOKER, so RLS scopes it to the
 * caller's organisation (and an agent to their own deals) and its total is
 * exactly this file's own deals. The migration tests replay the file over
 * 0093's body inside rolled-back transactions.
 */

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER = randomUUID();
const BND = randomUUID(); // the Cyprus month-boundary organisation
const RUN = Date.now().toString(36);
const HOUR = 3_600_000;
const DAY = 86_400_000;

let svc: SupabaseClient;
let o: Client;
let admin: TestUser;
let agent: TestUser;
let otherAdmin: TestUser;
let bndAdmin: TestUser;
const userIds: string[] = [];

/** ORG's in-window wins, oldest first, one hour apart — so a window opening at
 *  each one's won_at isolates its contribution by difference. */
const IN_WINDOW: { label: string; est: number | null; fin: number | null; counts: number }[] = [
  { label: "estimated 100 000, closed at 250 000", est: 100_000, fin: 250_000, counts: 250_000 },
  { label: "legacy: estimate 80 000, no final value", est: 80_000, fin: null, counts: 80_000 },
  { label: "closed at a confirmed 0 over an estimate of 90 000", est: 90_000, fin: 0, counts: 0 },
  { label: "neither an estimate nor a final value", est: null, fin: null, counts: 0 },
  { label: "no estimate, closed at 120 000", est: null, fin: 120_000, counts: 120_000 },
];
const IN_WINDOW_BASE = Date.now() - 10 * HOUR;
const wonAtOf = (i: number) => new Date(IN_WINDOW_BASE + i * HOUR);

async function rolledBack(fn: () => Promise<void>) {
  await o.query("begin");
  try {
    await o.query("set local lock_timeout = '5s'");
    await fn();
  } finally {
    await o.query("rollback");
  }
}

async function stageOf(org: string, kind: "won" | "lost" | "open"): Promise<string> {
  const where = kind === "won" ? "is_won" : kind === "lost" ? "is_lost" : "not is_won and not is_lost";
  const { rows } = await o.query<{ id: string }>(
    `select id from deal_stages where org_id = $1 and deal_type = 'sale' and ${where} order by sort_order limit 1`,
    [org],
  );
  return rows[0]!.id;
}
const wonStage = (org: string) => stageOf(org, "won");

/** A won deal, as the service role (the close guard binds sessions only). */
async function wonDeal(
  org: string,
  est: number | null,
  fin: number | null,
  wonAt: Date,
  agentId: string | null = null,
): Promise<string> {
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
      agent_id: agentId,
    })
    .select("id")
    .single();
  if (error) throw new Error(`won deal: ${error.message}`);
  return data.id as string;
}

type Stats = {
  open_pipeline: { total: number; count: number };
  won_month: { total: number; count: number };
  stages: { stage_id: string; total: number; count: number }[];
};

/** The whole function through PostgREST, as the given user. */
async function stats(as: TestUser, monthStart: string): Promise<Stats> {
  const { data, error } = await as.client.rpc("admin_dashboard_stats", {
    p_month_start: monthStart,
    p_d7: monthStart,
    p_d30: monthStart,
  });
  if (error) throw new Error(`admin_dashboard_stats: ${error.message}`);
  return data as Stats;
}

/** won_month through PostgREST, as the given user, for a window opening at `since` (default: a day ago). */
async function wonMonth(as: TestUser, since: string = new Date(Date.now() - DAY).toISOString()) {
  const w = (await stats(as, since)).won_month;
  return { total: Number(w.total), count: w.count };
}

let openStageOrg: string;

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `dashboard won ${RUN}`, `dashboard-won-${RUN}`);
  await ensureTestOrg(svc, OTHER, `dashboard won other ${RUN}`, `dashboard-won-other-${RUN}`);
  await ensureTestOrg(svc, BND, `dashboard won boundary ${RUN}`, `dashboard-won-bnd-${RUN}`);
  admin = await createTestUser(svc, `dwv-a-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `dwv-g-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  otherAdmin = await createTestUser(svc, `dwv-b-${RUN}@test.local`, "admin", OTHER);
  userIds.push(otherAdmin.id);
  bndAdmin = await createTestUser(svc, `dwv-c-${RUN}@test.local`, "admin", BND);
  userIds.push(bndAdmin.id);

  // this organisation's wins inside the window (the first one is the agent's)
  for (const [i, d] of IN_WINDOW.entries()) {
    await wonDeal(ORG, d.est, d.fin, wonAtOf(i), i === 0 ? agent.id : null);
  }
  // a win before the window
  await wonDeal(ORG, 999_000, 999_000, new Date(Date.now() - 40 * DAY));
  // a LOST deal inside the window: never a win, whatever it was worth
  const lost = await svc.from("deals").insert({
    org_id: ORG,
    stage_id: await stageOf(ORG, "lost"),
    deal_type: "sale",
    title: `DWV ${RUN} lost`,
    status: "lost",
    expected_value: 5_555_555,
    lost_at: new Date(Date.now() - HOUR).toISOString(),
    lost_reason: "Buyer withdrew",
  });
  if (lost.error) throw new Error(`lost deal: ${lost.error.message}`);
  // an OPEN deal that somehow carries a final value: the pipeline still reads
  // its estimate (only a won deal has a confirmed price)
  openStageOrg = await stageOf(ORG, "open");
  const open = await svc.from("deals").insert({
    org_id: ORG,
    stage_id: openStageOrg,
    deal_type: "sale",
    title: `DWV ${RUN} open`,
    status: "open",
    expected_value: 70_000,
    final_value: 1,
  });
  if (open.error) throw new Error(`open deal: ${open.error.message}`);
  // another organisation's win in the same window (estimate = final: this
  // one pins the scoping alone, whichever value the tile reads)
  await wonDeal(OTHER, 5_000_000, 5_000_000, new Date());

  // the boundary organisation: a win AT the first instant of a Cyprus month,
  // and one a millisecond before it — October (EEST, UTC+3) and December
  // (EET, UTC+2) 2026
  const oct = Date.parse("2026-09-30T21:00:00.000Z");
  const dec = Date.parse("2026-11-30T22:00:00.000Z");
  await wonDeal(BND, 200_000, 250_000, new Date(oct));
  await wonDeal(BND, 400_000, 450_000, new Date(oct - 1));
  await wonDeal(BND, 10_000, 12_000, new Date(dec));
  await wonDeal(BND, 20_000, 22_000, new Date(dec - 1));
});

afterAll(async () => {
  for (const org of [ORG, OTHER, BND]) {
    await o.query("delete from offers where org_id = $1", [org]);
    await o.query("delete from deals where org_id = $1", [org]);
  }
  for (const id of userIds) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) console.warn(`afterAll: auth user ${id} not deleted: ${error.message}`);
  }
  for (const org of [ORG, OTHER, BND]) {
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
    // at 0093 this read 100 000 + 80 000 + 90 000 + 0 + 0 = 270 000
    expect(await wonMonth(admin)).toEqual({ total: 250_000 + 80_000 + 0 + 0 + 120_000, count: 5 });
  });

  it("each win contributes exactly its rule's figure: final value, else estimate; a confirmed 0 is 0; neither counts and adds 0", async () => {
    const at = (i: number) => wonMonth(admin, wonAtOf(i).toISOString());
    for (const [i, d] of IN_WINDOW.entries()) {
      const from = await at(i);
      const after = i + 1 < IN_WINDOW.length ? await at(i + 1) : { total: 0, count: 0 };
      expect({ total: from.total - after.total, count: from.count - after.count }, d.label).toEqual({
        total: d.counts,
        count: 1,
      });
    }
  });

  it("only this organisation's wins, only inside the window: another organisation's, an older win and a lost deal are not counted", async () => {
    const mine = await wonMonth(admin);
    expect(mine.count).toBe(IN_WINDOW.length);
    expect(mine.total).toBeLessThan(5_555_555);
    expect(await wonMonth(otherAdmin)).toEqual({ total: 5_000_000, count: 1 });
  });

  it("an agent sees only their own deals — the agent's one win, at its final value", async () => {
    expect(await wonMonth(agent)).toEqual({ total: 250_000, count: 1 });
    const s = await stats(agent, new Date(Date.now() - DAY).toISOString());
    expect(s.open_pipeline).toEqual({ total: 0, count: 0 });
  });

  it("open deals keep their estimate: the open pipeline and its stage read 70 000, not the stray final value", async () => {
    const s = await stats(admin, new Date(Date.now() - DAY).toISOString());
    expect({ total: Number(s.open_pipeline.total), count: s.open_pipeline.count }).toEqual({ total: 70_000, count: 1 });
    expect(s.stages.map((x) => ({ stage_id: x.stage_id, total: Number(x.total), count: x.count }))).toEqual([
      { stage_id: openStageOrg, total: 70_000, count: 1 },
    ]);
  });

  it("anon cannot execute it through PostgREST", async () => {
    const { data, error } = await anonClient().rpc("admin_dashboard_stats", {
      p_month_start: new Date().toISOString(),
      p_d7: new Date().toISOString(),
      p_d30: new Date().toISOString(),
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("the Cyprus month boundary: a win at local midnight on the 1st is in that month at its final value, one a millisecond earlier is not — summer (UTC+3) and winter (UTC+2)", async () => {
    // the instants the dashboard itself passes (lib/utils/tz.ts, admin-dashboard.tsx)
    const sep = cyprusMonthStart(new Date("2026-09-30T20:59:59.999Z"));
    const oct = cyprusMonthStart(new Date("2026-10-15T09:00:00.000Z"));
    const dec = cyprusMonthStart(new Date("2026-12-10T09:00:00.000Z"));
    expect([sep, oct, dec]).toEqual(["2026-08-31T21:00:00.000Z", "2026-09-30T21:00:00.000Z", "2026-11-30T22:00:00.000Z"]);
    // December: only the win at 22:00Z on 30 November (Cyprus midnight, EET)
    expect(await wonMonth(bndAdmin, dec)).toEqual({ total: 12_000, count: 1 });
    // October: the win at 21:00Z on 30 September (Cyprus midnight, EEST), not
    // the one at 20:59:59.999Z — plus both December wins (no upper bound)
    expect(await wonMonth(bndAdmin, oct)).toEqual({ total: 250_000 + 22_000 + 12_000, count: 3 });
    // September's window takes the millisecond-earlier win at ITS final value
    expect(await wonMonth(bndAdmin, sep)).toEqual({ total: 450_000 + 250_000 + 22_000 + 12_000, count: 4 });
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

  it("every other section reads exactly what 0093's body reads; won_month keeps its count and moves only its total", async () => {
    const windows: [string, string, string][] = [
      [cyprusMonthStart(new Date()), new Date(Date.now() - 7 * DAY).toISOString(), new Date(Date.now() - 30 * DAY).toISOString()],
      ["2026-09-30T21:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-09-10T00:00:00.000Z"],
      ["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z"],
      ["2999-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z"],
    ];
    type Out = { won_month: { total: string; count: number } } & Record<string, unknown>;
    const read = async () => {
      const out: Out[] = [];
      for (const w of windows) {
        const { rows } = await o.query<{ v: Out }>("select public.admin_dashboard_stats($1, $2, $3) as v", w);
        out.push(rows[0]!.v);
      }
      return out;
    };
    await rolledBack(async () => {
      // one planted win in the far-future window, so the two bodies provably differ there
      await o.query(
        `insert into deals (org_id, deal_type, stage_id, title, status, expected_value, final_value, won_at)
         values ($1, 'sale', $2, 'DWV planted', 'won', 100, 250, '2999-01-02T00:00:00Z')`,
        [ORG, await wonStage(ORG)],
      );
      const now = await read();
      await o.query(REVERT_0140_SQL);
      expect((await o.query<{ m: string }>("select md5(replace(prosrc, E'\\r', '')) as m from pg_proc where oid = to_regprocedure($1)", [SIG])).rows[0]!.m).toBe(BODY_0093_MD5);
      const then = await read();
      for (const [i, w] of windows.entries()) {
        const { won_month: a, ...restNow } = now[i]!;
        const { won_month: b, ...restThen } = then[i]!;
        expect(restNow, `window ${w[0]}: the other five sections`).toEqual(restThen);
        expect(a.count, `window ${w[0]}: won_month.count`).toBe(b.count);
      }
      expect(Number(now[3]!.won_month.total) - Number(then[3]!.won_month.total), "the planted win: 250 now, 100 at 0093").toBe(150);
    });
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

  it("the probe fails CLOSED when another won deal shares its far-future window — the whole file refuses, nothing changed", async () => {
    // the probe sums every organisation (it runs as postgres, no RLS); a
    // stray won_at >= 2999-01-01 anywhere makes it read more than its own
    // 250 — so the hosted preflight counts such rows first (DECISIONS)
    await rolledBack(async () => {
      await o.query(REVERT_0140_SQL);
      await o.query(
        `insert into deals (org_id, deal_type, stage_id, title, status, expected_value, final_value, won_at)
         values ($1, 'sale', $2, 'DWV stray', 'won', 7, 7, '2999-06-01T00:00:00Z')`,
        [OTHER, await wonStage(OTHER)],
      );
      await o.query("savepoint s");
      await expect(o.query(readMigration0140())).rejects.toThrow(/^0140 postflight: the probe's won deal \(estimate 100, final 250\) read as total 257\.00 over 2 deal\(s\)/);
      await o.query("rollback to savepoint s");
      expect(await bodyMd5(), "nothing was changed").toBe(BODY_0093_MD5);
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

// ---------------------------------------------------------------------------
describe("4. closing a deal moves the tile by its confirmed price; the estimate stays stored", () => {
  it("close_deal at the accepted offer's 250 000: won_month rises by 250 000, not the stale 999 999 estimate, and expected_value is untouched", async () => {
    const { data: deal, error } = await svc
      .from("deals")
      .insert({
        org_id: ORG,
        stage_id: openStageOrg,
        deal_type: "sale",
        title: `DWV ${RUN} to close`,
        status: "open",
        expected_value: 999_999,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const offer = await svc
      .from("offers")
      .insert({ org_id: ORG, deal_id: deal!.id, amount: 250_000, status: "accepted" });
    expect(offer.error).toBeNull();

    const before = await wonMonth(admin);
    const close = await admin.client.rpc("close_deal", { p_deal_id: deal!.id, p_outcome: "won" });
    expect(close.error).toBeNull();
    const after = await wonMonth(admin);
    expect({ total: after.total - before.total, count: after.count - before.count }).toEqual({ total: 250_000, count: 1 });

    const { data: stored } = await svc.from("deals").select("status, expected_value, final_value").eq("id", deal!.id).single();
    expect(stored).toEqual({ status: "won", expected_value: 999_999, final_value: 250_000 });
  });
});
