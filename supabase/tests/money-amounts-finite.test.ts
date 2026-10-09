import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import {
  ANON_KEY,
  SERVICE_ROLE_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";
import { FINITE_CHECKS_0144, REVERT_0144_SQL, readMigration0144 } from "./revert-0144";

/**
 * 0144: a deal or offer amount is a NUMBER — offers.amount,
 * deals.expected_value and deals.final_value refuse 'NaN' for every writer.
 *
 * numeric(14,2) stores NaN (its typmod refuses only ±Infinity and overflow),
 * and the 0076 / 0077 CHECKs test `>= 0`, which NaN passes: numeric sorts NaN
 * above every number. One such row turns every sum over the column NaN.
 *
 *   1. a session's writes through PostgREST — INSERT, PATCH, upsert, a batch —
 *      with the JSON STRING "NaN" (a bare NaN token is not JSON), as an admin
 *      and as the deal's agent: refused by the new CHECK (23514 naming it),
 *      never mistaken for an RLS refusal (42501, a listing manager's shape),
 *      nothing changed. final_value is not a session's to write at all (the
 *      closed-deal guard — 0118, its body 0131's — unchanged) and close_deal
 *      refuses NaN itself (unchanged);
 *   2. service_role (the importer's client), postgres and a SECURITY DEFINER
 *      body — none of which the closed-deal guard binds — refused by the same
 *      CHECKs in all three columns;
 *   3. what was refused before stays refused: ±Infinity (the numeric(14,2)
 *      type, 22003), negatives (the non-negative CHECKs), overflow (22003);
 *      and the CHECKs' infinity arms hold on their own;
 *   4. what was valid stays valid: decimals rounded to cents, the 10^12 limit,
 *      an offer of 0 and a deal value of 0 or none;
 *   5. closing a deal and the totals built on these columns: close_deal as
 *      before, and the dashboard's open-pipeline and won-this-month totals and
 *      the agent report's won value stay exact numbers when a NaN write is
 *      attempted;
 *   6. the migration: its shape, the one-transaction guard, replay over the
 *      state before it, the preflight refusing stored NaN rows (counts only,
 *      no repair, no partial DDL) and the operator's read-only preflight
 *      script listing them, a bounded lock wait, replay safety, postflight
 *      mutants, the rollback, the restore pack's row.
 *
 * At 0143 this file is RED where the defect lives: every NaN write in
 * sections 1 and 2 (the CSV and restore paths included) was accepted and the
 * section 5 totals read "NaN"; section 3's infinity-arm test and section 6
 * need 0144's CHECKs and had nothing to find; the controls, and the
 * protections that already existed (RLS, the closed-deal guard, close_deal's
 * own check, the type's 22003, the non-negative CHECKs), passed. A THROWAWAY
 * ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();

/** Spellings PostgreSQL's numeric input reads as NaN (measured: case and surrounding spaces do not matter). */
const NAN_SPELLINGS = ["NaN", "nan", " NaN "] as const;
const INFINITIES = ["Infinity", "-Infinity", "inf"] as const;

let o: Client; // postgres: fixtures, observation, the migration replays, cleanup
let a: Client; // a second session holding a lock
let svc: SupabaseClient;
let admin: TestUser;
let agent: TestUser; // owns the fixture deals
let lm: TestUser; // listing manager: may write neither table
const userIds: string[] = [];
let openStage: string;
let n = 0;

type Write = { error: PostgrestError | null };
type PgError = Error & { code?: string; constraint?: string };

/** Refused by THIS check — not RLS (42501), the type (22003), a trigger (P0001) or a parse error (22P02). */
function refusedBy(res: Write, constraint: string) {
  expect(res.error, `${constraint} must refuse this write; it was accepted`).not.toBeNull();
  expect(res.error!.code, res.error!.message).toBe("23514");
  expect(res.error!.message).toContain(`"${constraint}"`);
}
function overflowed(res: Write) {
  expect(res.error?.code, res.error?.message).toBe("22003");
  expect(res.error?.message).toBe("numeric field overflow");
}
async function pgRefusedBy(q: Promise<unknown>, constraint: string) {
  const e = await q.then(
    () => null,
    (err: PgError) => err,
  );
  expect(e, `${constraint} must refuse this statement; it was accepted`).not.toBeNull();
  expect(e!.code, e!.message).toBe("23514");
  expect(e!.constraint).toBe(constraint);
}

async function newDeal(opts: { agentId?: string; expected?: string | null } = {}): Promise<string> {
  n += 1;
  const { rows } = await o.query<{ id: string }>(
    `insert into public.deals (org_id, stage_id, title, agent_id, created_by, expected_value)
     values ($1, $2, $3, $4, $4, $5) returning id`,
    [ORG, openStage, `ZZFIN ${TAG} ${n}`, opts.agentId ?? agent.id, opts.expected === undefined ? "100000.00" : opts.expected],
  );
  return rows[0]!.id;
}
async function newOffer(dealId: string, amount = "90000.00", status = "submitted"): Promise<string> {
  const { rows } = await o.query<{ id: string }>(
    `insert into public.offers (org_id, deal_id, amount, status) values ($1, $2, $3, $4) returning id`,
    [ORG, dealId, amount, status],
  );
  return rows[0]!.id;
}
const dealInsert = (v: unknown, extra: Record<string, unknown> = {}) => ({
  org_id: ORG,
  stage_id: openStage,
  title: `ZZFIN ${TAG} via api`,
  agent_id: agent.id,
  expected_value: v,
  ...extra,
});

/** Everything a refused write must leave exactly as it was: every amount in the org and the row and event counts. */
async function footprint() {
  const { rows } = await o.query(
    `select (select json_agg(json_build_array(id, amount::text) order by id) from public.offers where org_id = $1) as offers,
            (select json_agg(json_build_array(id, expected_value::text, final_value::text, status) order by id)
               from public.deals where org_id = $1) as deals,
            (select count(*)::int from public.events where org_id = $1) as events`,
    [ORG],
  );
  return rows[0];
}
async function stored(table: "offers" | "deals", id: string) {
  const cols = table === "offers" ? "amount::text as amount" : "expected_value::text as expected_value, final_value::text as final_value, status::text as status";
  return (await o.query(`select ${cols} from public.${table} where id = $1`, [id])).rows[0];
}
async function finiteChecks(): Promise<number> {
  const { rows } = await o.query<{ c: number }>(
    `select count(*)::int as c from pg_constraint where conname = any($1::text[]) and contype = 'c' and convalidated`,
    [FINITE_CHECKS_0144 as unknown as string[]],
  );
  return rows[0]!.c;
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  a = new Client({ connectionString: DB_URL });
  await Promise.all([o.connect(), a.connect()]);
  await ensureTestOrg(svc, ORG, `Finite amounts ${RUN}`, `finite-amounts-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `fa-admin-${RUN}@test.local`, "admin", ORG);
  agent = await createTestUser(svc, `fa-agent-${RUN}@test.local`, "agent", ORG);
  lm = await createTestUser(svc, `fa-lm-${RUN}@test.local`, "listing_manager", ORG);
  userIds.push(admin.id, agent.id, lm.id);
  openStage = (
    await o.query<{ id: string }>(
      `select id from public.deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1`,
      [ORG],
    )
  ).rows[0]!.id;
});

afterEach(async () => {
  await a.query("rollback").catch(() => undefined);
});

afterAll(async () => {
  await o.query("rollback").catch(() => undefined);
  await o.query("delete from public.tasks where org_id = $1", [ORG]);
  await o.query("delete from public.leads where org_id = $1", [ORG]);
  await o.query("delete from public.offers where org_id = $1", [ORG]);
  await o.query("delete from public.deals where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await o.query("delete from public.profiles where org_id = $1", [ORG]);
  await o.query("delete from public.events where org_id = $1", [ORG]);
  await o.query("delete from public.events_chain_checkpoint where org_id = $1", [ORG]);
  await o.query("delete from public.chain_checks where org_id = $1", [ORG]);
  await o.query("delete from public.deal_stages where org_id = $1", [ORG]);
  await o.query("delete from public.districts where org_id = $1", [ORG]);
  await o.query("delete from public.organizations where id = $1", [ORG]);
  await Promise.all([o.end(), a.end()]);
});

// ---------------------------------------------------------------------------
describe("1. a session's own writes through PostgREST", () => {
  it("controls: the same requests with valid amounts are permitted to the admin and to the deal's agent", async () => {
    for (const user of [admin, agent]) {
      const d = await user.client.from("deals").insert(dealInsert("150000.50")).select("id, expected_value").single();
      expect(d.error).toBeNull();
      expect(d.data!.expected_value).toBe(150000.5);
      const dealId = d.data!.id as string;

      const of = await user.client.from("offers").insert({ org_id: ORG, deal_id: dealId, amount: "145000.25" }).select("id, amount").single();
      expect(of.error).toBeNull();
      expect(of.data!.amount).toBe(145000.25);
      const offerId = of.data!.id as string;

      const up = await user.client.from("offers").update({ amount: "146000" }).eq("id", offerId).select("amount").single();
      expect(up.error).toBeNull();
      expect(up.data!.amount).toBe(146000);
      const ups = await user.client
        .from("offers")
        .upsert({ id: offerId, org_id: ORG, deal_id: dealId, amount: "147000.10" }, { onConflict: "id" })
        .select("amount")
        .single();
      expect(ups.error).toBeNull();
      expect(ups.data!.amount).toBe(147000.1);

      const dup = await user.client.from("deals").update({ expected_value: "151000" }).eq("id", dealId).select("expected_value").single();
      expect(dup.error).toBeNull();
      expect(dup.data!.expected_value).toBe(151000);
      const dups = await user.client
        .from("deals")
        .upsert({ id: dealId, ...dealInsert("152000.75") }, { onConflict: "id" })
        .select("expected_value")
        .single();
      expect(dups.error).toBeNull();
      expect(dups.data!.expected_value).toBe(152000.75);
    }
  });

  it("a listing manager's write is refused by RLS (42501) — the shape of a permission failure, which no check below may be", async () => {
    const d = await newDeal();
    const before = await footprint();
    for (const v of ["1000.00", "NaN"]) {
      expect((await lm.client.from("offers").insert({ org_id: ORG, deal_id: d, amount: v })).error?.code).toBe("42501");
      expect((await lm.client.from("deals").insert(dealInsert(v))).error?.code).toBe("42501");
    }
    expect(await footprint()).toEqual(before);
  });

  for (const who of ["admin", "agent"] as const) {
    for (const v of NAN_SPELLINGS) {
      it(`${who}: INSERT, PATCH and upsert of offers.amount = ${JSON.stringify(v)} are refused by offers_amount_finite, changing nothing`, async () => {
        const user = who === "admin" ? admin : agent;
        const d = await newDeal();
        const of = await newOffer(d);
        const before = await footprint();
        refusedBy(await user.client.from("offers").insert({ org_id: ORG, deal_id: d, amount: v }), "offers_amount_finite");
        refusedBy(await user.client.from("offers").update({ amount: v }).eq("id", of), "offers_amount_finite");
        refusedBy(
          await user.client.from("offers").upsert({ id: of, org_id: ORG, deal_id: d, amount: v }, { onConflict: "id" }),
          "offers_amount_finite",
        );
        refusedBy(
          await user.client.from("offers").upsert({ id: randomUUID(), org_id: ORG, deal_id: d, amount: v }, { onConflict: "id" }),
          "offers_amount_finite",
        );
        expect(await footprint()).toEqual(before);
        expect((await stored("offers", of)).amount).toBe("90000.00");
      });

      it(`${who}: INSERT, PATCH and upsert of deals.expected_value = ${JSON.stringify(v)} are refused by deals_expected_value_finite, changing nothing`, async () => {
        const user = who === "admin" ? admin : agent;
        const d = await newDeal();
        const before = await footprint();
        refusedBy(await user.client.from("deals").insert(dealInsert(v)), "deals_expected_value_finite");
        refusedBy(await user.client.from("deals").update({ expected_value: v }).eq("id", d), "deals_expected_value_finite");
        refusedBy(await user.client.from("deals").upsert({ id: d, ...dealInsert(v) }, { onConflict: "id" }), "deals_expected_value_finite");
        refusedBy(
          await user.client.from("deals").upsert({ id: randomUUID(), ...dealInsert(v) }, { onConflict: "id" }),
          "deals_expected_value_finite",
        );
        expect(await footprint()).toEqual(before);
        expect((await stored("deals", d)).expected_value).toBe("100000.00");
      });
    }
  }

  it("a batch with one NaN row is refused whole: the valid row beside it is not written either", async () => {
    const d = await newDeal();
    const before = await footprint();
    refusedBy(
      await admin.client.from("offers").insert([
        { org_id: ORG, deal_id: d, amount: "1000.00" },
        { org_id: ORG, deal_id: d, amount: "NaN" },
      ]),
      "offers_amount_finite",
    );
    refusedBy(await agent.client.from("deals").insert([dealInsert("2000.00"), dealInsert("NaN")]), "deals_expected_value_finite");
    expect(await footprint()).toEqual(before);
  });

  it("deals.final_value is not a session's to write: the closed-deal guard (0118 / 0131) refuses it before any CHECK runs (unchanged), and close_deal refuses NaN itself (unchanged)", async () => {
    const d = await newDeal();
    const before = await footprint();
    for (const user of [admin, agent]) {
      const up = await user.client.from("deals").update({ final_value: "NaN" }).eq("id", d);
      expect(up.error?.code).toBe("P0001");
      expect(up.error?.message).toBe("Deal is open — its closing details are written only when it is marked won or lost");
      const ins = await user.client.from("deals").insert(dealInsert("1000.00", { final_value: "NaN" }));
      expect(ins.error?.code).toBe("P0001");
      expect(ins.error?.message).toBe("A new deal cannot carry closing details — they are written when it is marked won or lost");
    }
    const close = await admin.client.rpc("close_deal", { p_deal_id: d, p_outcome: "won", p_final_value: "NaN", p_override: true });
    expect(close.error?.message).toBe("Final value must be a positive amount.");
    expect(await footprint()).toEqual(before);
  });

  it("only the JSON string can carry NaN: a bare NaN token is refused by PostgREST as invalid JSON (PGRST102), and supabase-js sends a JS NaN as null (23502)", async () => {
    const d = await newDeal();
    const before = await footprint();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/offers`, {
      method: "POST",
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: `{"org_id":"${ORG}","deal_id":"${d}","amount":NaN}`,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("PGRST102");
    expect((await admin.client.from("offers").insert({ org_id: ORG, deal_id: d, amount: Number.NaN })).error?.code).toBe("23502");
    expect(await footprint()).toEqual(before);
  });

  it("a CSV bulk insert (text/csv, where NaN is a bare cell) is refused whole by the same CHECK; a valid CSV still lands", async () => {
    const d = await newDeal();
    const token = (await admin.client.auth.getSession()).data.session!.access_token;
    const post = (csv: string) =>
      fetch(`${SUPABASE_URL}/rest/v1/offers`, {
        method: "POST",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "text/csv", Prefer: "return=minimal" },
        body: csv,
      });
    const before = await footprint();
    const bad = await post(`org_id,deal_id,amount\n${ORG},${d},1000.00\n${ORG},${d},NaN`);
    expect(bad.status).toBe(400);
    const err = (await bad.json()) as { code: string; message: string };
    expect(err.code).toBe("23514");
    expect(err.message).toContain('"offers_amount_finite"');
    expect(await footprint()).toEqual(before);
    const good = await post(`org_id,deal_id,amount\n${ORG},${d},1000.00\n${ORG},${d},2000.5`);
    expect(good.status).toBe(201);
    const { rows } = await o.query<{ a: string }>("select amount::text as a from public.offers where deal_id = $1 order by amount", [d]);
    expect(rows.map((r) => r.a)).toEqual(["1000.00", "2000.50"]);
  });
});

// ---------------------------------------------------------------------------
describe("2. privileged writers — service_role (the importer's client) and postgres — bound by the same CHECKs", () => {
  it("service_role: offers.amount and deals.expected_value, by INSERT, PATCH and upsert", async () => {
    const d = await newDeal();
    const of = await newOffer(d);
    const before = await footprint();
    refusedBy(await svc.from("offers").insert({ org_id: ORG, deal_id: d, amount: "NaN" }), "offers_amount_finite");
    refusedBy(await svc.from("offers").update({ amount: "NaN" }).eq("id", of), "offers_amount_finite");
    refusedBy(await svc.from("offers").upsert({ id: of, org_id: ORG, deal_id: d, amount: "NaN" }, { onConflict: "id" }), "offers_amount_finite");
    refusedBy(await svc.from("deals").insert(dealInsert("NaN")), "deals_expected_value_finite");
    refusedBy(await svc.from("deals").update({ expected_value: "NaN" }).eq("id", d), "deals_expected_value_finite");
    refusedBy(await svc.from("deals").upsert({ id: d, ...dealInsert("NaN") }, { onConflict: "id" }), "deals_expected_value_finite");
    expect(await footprint()).toEqual(before);
  });

  it("service_role: deals.final_value — which the closed-deal guard does not bind — on an open deal, a won deal, a new deal and an upsert", async () => {
    const open = await newDeal();
    const won = await newDeal({ expected: "200000.00" });
    await newOffer(won, "195000.00", "accepted");
    expect((await admin.client.rpc("close_deal", { p_deal_id: won, p_outcome: "won" })).error).toBeNull();
    const before = await footprint();
    refusedBy(await svc.from("deals").update({ final_value: "NaN" }).eq("id", open), "deals_final_value_finite");
    refusedBy(await svc.from("deals").update({ final_value: "NaN" }).eq("id", won), "deals_final_value_finite");
    refusedBy(await svc.from("deals").insert(dealInsert("1000.00", { final_value: "NaN" })), "deals_final_value_finite");
    refusedBy(await svc.from("deals").upsert({ id: won, ...dealInsert("200000.00"), final_value: "NaN" }, { onConflict: "id" }), "deals_final_value_finite");
    expect(await footprint()).toEqual(before);
    expect((await stored("deals", won)).final_value).toBe("195000.00");
  });

  it("a SECURITY DEFINER writer is bound too: close_deal without its own NaN check is refused by deals_final_value_finite", async () => {
    const SIG = "public.close_deal(uuid, text, numeric, text, boolean)";
    const md5 = async () => (await o.query<{ m: string }>("select md5(prosrc) as m from pg_proc where oid = to_regprocedure($1)", [SIG])).rows[0]!.m;
    const before = await md5();
    const def = (await o.query<{ d: string }>("select pg_get_functiondef(to_regprocedure($1)) as d", [SIG])).rows[0]!.d;
    const needle = "if v_final is not null and (v_final = 'NaN'::numeric or v_final < 0) then";
    expect(def.split(needle).length - 1, "the mutation installs").toBe(1);
    const d = await newDeal({ expected: "50000.00" });
    await o.query("begin");
    try {
      await o.query(def.replace(needle, "if v_final is not null and (v_final < 0) then"));
      // `if exists`: at 0143 there is none, and the test then fails where the defect is
      await o.query("alter table public.offers drop constraint if exists offers_amount_finite");
      await o.query("insert into public.offers (org_id, deal_id, amount, status, decided_at) values ($1, $2, 'NaN', 'accepted', now())", [ORG, d]);
      await o.query("set local role authenticated");
      await o.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: agent.id, role: "authenticated", aal: "aal2" })]);
      await pgRefusedBy(o.query("select public.close_deal($1::uuid, 'won')", [d]), "deals_final_value_finite");
    } finally {
      await o.query("rollback");
    }
    // hygiene (the rollback restores both whatever happened): the deal is untouched, close_deal is back
    expect(await stored("deals", d)).toMatchObject({ status: "open", final_value: null });
    expect(await md5(), "close_deal is back as it was").toBe(before);
  });

  it("a restore's data load is bound too: restore.mjs's own insert, under session_replication_role = replica (no trigger fires), is refused", async () => {
    // the load statement is taken from restore.mjs's source, not retyped, so a
    // change to how the restore loads a table changes what this test runs
    const src = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "restore.mjs"), "utf-8").replace(/\r\n/g, "\n");
    expect(src).toContain("set local session_replication_role = replica;");
    expect(src).toContain("create temp table _load (j json) on commit drop;");
    const from = src.indexOf("out.push(`do $do$");
    const to = src.indexOf("end $do$;`);", from);
    expect(from, "restore.mjs still builds its per-table load as a do $do$ block").toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const restoreInsert = src.slice(from + "out.push(`".length, to + "end $do$;".length).split("$" + "{table}").join("offers");
    expect(restoreInsert).toContain("json_populate_recordset(null::public.offers, (select j from _load))");

    const d = await newDeal();
    const of = await newOffer(d);
    const exported = (await o.query<{ j: Record<string, unknown>[] }>("select json_agg(row_to_json(x)) as j from (select * from public.offers where id = $1) x", [of]))
      .rows[0]!.j;
    // a backup taken before 0144 could hold this row: PostgREST reads a stored NaN back as the string "NaN"
    const row = { ...exported[0]!, id: randomUUID(), amount: "NaN" };
    await o.query("begin");
    try {
      await o.query("set local session_replication_role = replica");
      await o.query("create temp table _load (j json) on commit drop");
      await o.query("insert into _load values ($1::json)", [JSON.stringify([row])]);
      await pgRefusedBy(o.query(restoreInsert), "offers_amount_finite");
    } finally {
      await o.query("rollback");
    }
    // the control: the same load of the row as exported lands
    await o.query("begin");
    try {
      await o.query("set local session_replication_role = replica");
      await o.query("create temp table _load (j json) on commit drop");
      await o.query("insert into _load values ($1::json)", [JSON.stringify([{ ...exported[0]!, id: randomUUID() }])]);
      await o.query(restoreInsert);
    } finally {
      await o.query("rollback");
    }
    await o.query("begin");
    try {
      await o.query("set local session_replication_role = replica");
      await pgRefusedBy(o.query("update public.deals set final_value = 'NaN' where id = $1", [d]), "deals_final_value_finite");
    } finally {
      await o.query("rollback");
    }
  });

  it("postgres: a direct write of each column is refused (23514 naming the check), nothing changes", async () => {
    const d = await newDeal();
    const of = await newOffer(d);
    const before = await footprint();
    await pgRefusedBy(o.query("update public.offers set amount = 'NaN' where id = $1", [of]), "offers_amount_finite");
    await pgRefusedBy(o.query("update public.deals set expected_value = 'NaN' where id = $1", [d]), "deals_expected_value_finite");
    await pgRefusedBy(o.query("update public.deals set final_value = 'NaN' where id = $1", [d]), "deals_final_value_finite");
    await pgRefusedBy(o.query("insert into public.offers (org_id, deal_id, amount) values ($1, $2, 'NaN')", [ORG, d]), "offers_amount_finite");
    expect(await footprint()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
describe("3. what was refused before stays refused", () => {
  it("±Infinity is refused by the numeric(14,2) type itself (22003) in all three columns, for a session and for service_role", async () => {
    const d = await newDeal();
    const of = await newOffer(d);
    const before = await footprint();
    for (const v of INFINITIES) {
      overflowed(await admin.client.from("offers").insert({ org_id: ORG, deal_id: d, amount: v }));
      overflowed(await agent.client.from("offers").update({ amount: v }).eq("id", of));
      overflowed(await admin.client.from("deals").insert(dealInsert(v)));
      overflowed(await svc.from("deals").update({ expected_value: v }).eq("id", d));
      overflowed(await svc.from("deals").update({ final_value: v }).eq("id", d));
    }
    expect(await footprint()).toEqual(before);
  });

  it("a negative amount is still refused by the 0076 / 0077 non-negative CHECKs", async () => {
    const d = await newDeal();
    const before = await footprint();
    refusedBy(await admin.client.from("offers").insert({ org_id: ORG, deal_id: d, amount: "-1" }), "offers_amount_non_negative");
    refusedBy(await agent.client.from("deals").update({ expected_value: "-0.01" }).eq("id", d), "deals_expected_value_non_negative");
    refusedBy(await svc.from("deals").update({ final_value: "-5" }).eq("id", d), "deals_final_value_non_negative");
    expect(await footprint()).toEqual(before);
  });

  it("overflow is still refused (22003): 10^12, and a value that rounds up to it", async () => {
    const d = await newDeal();
    const before = await footprint();
    overflowed(await admin.client.from("offers").insert({ org_id: ORG, deal_id: d, amount: "1000000000000" }));
    overflowed(await admin.client.from("deals").update({ expected_value: "999999999999.995" }).eq("id", d));
    overflowed(await svc.from("deals").update({ final_value: "1e13" }).eq("id", d));
    expect(await footprint()).toEqual(before);
  });

  it("the CHECKs' infinity arms hold on their own: copies of the tables with an unconstrained numeric column still refuse NaN and ±Infinity", async () => {
    await o.query("begin");
    try {
      await o.query("create temp table offers_copy (like public.offers including defaults including constraints) on commit drop");
      await o.query("create temp table deals_copy (like public.deals including defaults including constraints) on commit drop");
      await o.query("alter table offers_copy alter column amount type numeric");
      await o.query("alter table deals_copy alter column expected_value type numeric, alter column final_value type numeric");
      for (const v of ["NaN", "Infinity", "-Infinity"]) {
        await o.query("savepoint s");
        await pgRefusedBy(
          o.query("insert into offers_copy (id, org_id, deal_id, amount) values (gen_random_uuid(), $1, gen_random_uuid(), $2)", [ORG, v]),
          "offers_amount_finite",
        );
        await o.query("rollback to savepoint s");
        await pgRefusedBy(
          o.query("insert into deals_copy (id, org_id, stage_id, title, expected_value) values (gen_random_uuid(), $1, $2, 't', $3)", [ORG, openStage, v]),
          "deals_expected_value_finite",
        );
        await o.query("rollback to savepoint s");
        await pgRefusedBy(
          o.query("insert into deals_copy (id, org_id, stage_id, title, final_value) values (gen_random_uuid(), $1, $2, 't', $3)", [ORG, openStage, v]),
          "deals_final_value_finite",
        );
        await o.query("rollback to savepoint s");
      }
      // and an ordinary number is still welcome there
      await o.query("insert into offers_copy (id, org_id, deal_id, amount) values (gen_random_uuid(), $1, gen_random_uuid(), 1e15)", [ORG]);
    } finally {
      await o.query("rollback");
    }
  });
});

// ---------------------------------------------------------------------------
describe("4. what was valid stays valid", () => {
  it("decimals are rounded to cents as before, and the largest value the columns hold is accepted", async () => {
    const d = await newDeal();
    const r1 = await admin.client.from("offers").insert({ org_id: ORG, deal_id: d, amount: 1234.565 }).select("id").single();
    expect(r1.error).toBeNull();
    expect((await stored("offers", r1.data!.id as string)).amount).toBe("1234.57");
    const r2 = await admin.client.from("offers").insert({ org_id: ORG, deal_id: d, amount: "999999999999.99" }).select("id").single();
    expect(r2.error).toBeNull();
    expect((await stored("offers", r2.data!.id as string)).amount).toBe("999999999999.99");
    const r3 = await agent.client.from("deals").update({ expected_value: "0.005" }).eq("id", d);
    expect(r3.error).toBeNull();
    expect((await stored("deals", d)).expected_value).toBe("0.01");
  });

  it("an offer of 0, and a deal value of 0 or none, remain valid to the database (the app's 'more than 0' for offers stays the app's)", async () => {
    const d = await newDeal({ expected: null });
    expect((await stored("deals", d)).expected_value).toBeNull();
    const zeroOffer = await admin.client.from("offers").insert({ org_id: ORG, deal_id: d, amount: "0" }).select("id").single();
    expect(zeroOffer.error).toBeNull();
    expect((await stored("offers", zeroOffer.data!.id as string)).amount).toBe("0.00");
    const zero = await agent.client.from("deals").insert(dealInsert("0")).select("id, expected_value, final_value").single();
    expect(zero.error).toBeNull();
    expect(zero.data).toMatchObject({ expected_value: 0, final_value: null });
    const none = await agent.client.from("deals").insert(dealInsert(null)).select("expected_value").single();
    expect(none.error).toBeNull();
    expect(none.data!.expected_value).toBeNull();
    const back = await agent.client.from("deals").update({ expected_value: null }).eq("id", zero.data!.id as string);
    expect(back.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("5. closing a deal, and the totals built on these columns", () => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const d7 = new Date(now.getTime() - 7 * 864e5).toISOString();
  const d30 = new Date(now.getTime() - 30 * 864e5).toISOString();
  const from = new Date(now.getTime() - 864e5).toISOString();
  const to = new Date(now.getTime() + 864e5).toISOString();

  async function pipelineTotal(): Promise<unknown> {
    const r = await admin.client.rpc("admin_dashboard_stats", { p_month_start: monthStart, p_d7: d7, p_d30: d30 });
    expect(r.error).toBeNull();
    return (r.data as { open_pipeline: { total: unknown } }).open_pipeline.total;
  }
  async function wonMonthTotal(): Promise<unknown> {
    const r = await admin.client.rpc("admin_dashboard_stats", { p_month_start: monthStart, p_d7: d7, p_d30: d30 });
    expect(r.error).toBeNull();
    return (r.data as { won_month: { total: unknown } }).won_month.total;
  }
  async function openSum(): Promise<number> {
    const { rows } = await o.query<{ s: string }>(
      `select coalesce(sum(coalesce(expected_value, 0)), 0)::text as s from public.deals where org_id = $1 and status = 'open'`,
      [ORG],
    );
    return Number(rows[0]!.s);
  }
  async function agentWonValue(): Promise<unknown> {
    const r = await admin.client.rpc("report_agent_performance", { p_from: from, p_to: to });
    expect(r.error).toBeNull();
    return (r.data as Array<{ agent_id: string; won_value: unknown }>).find((x) => x.agent_id === agent.id)?.won_value;
  }
  async function agentWonSum(): Promise<number> {
    const { rows } = await o.query<{ s: string }>(
      `select coalesce(sum(coalesce(final_value, expected_value)), 0)::text as s from public.deals
        where org_id = $1 and agent_id = $2 and status = 'won' and won_at >= $3 and won_at < $4`,
      [ORG, agent.id, from, to],
    );
    return Number(rows[0]!.s);
  }

  it("a deal closes through close_deal as before: the final value from the accepted offer, or typed and rounded to cents; a lost close carries none", async () => {
    const d1 = await newDeal({ expected: "300000.00" });
    await newOffer(d1, "250000.50", "accepted");
    expect((await admin.client.rpc("close_deal", { p_deal_id: d1, p_outcome: "won" })).error).toBeNull();
    expect(await stored("deals", d1)).toMatchObject({ status: "won", final_value: "250000.50" });

    const d2 = await newDeal({ expected: "120000.00" });
    await newOffer(d2, "110000.00", "accepted");
    expect((await agent.client.rpc("close_deal", { p_deal_id: d2, p_outcome: "won", p_final_value: 115000.555 })).error).toBeNull();
    expect(await stored("deals", d2)).toMatchObject({ status: "won", final_value: "115000.56" });

    const d3 = await newDeal();
    expect((await agent.client.rpc("close_deal", { p_deal_id: d3, p_outcome: "lost", p_lost_reason: "Buyer withdrew" })).error).toBeNull();
    expect(await stored("deals", d3)).toMatchObject({ status: "lost", final_value: null });
  });

  it("the dashboard's open pipeline total is the exact sum of valid values, and a NaN write cannot turn it NaN", async () => {
    const t0 = await pipelineTotal();
    expect(typeof t0).toBe("number");
    expect(t0).toBe(await openSum());

    const d = await newDeal({ expected: "12345.67" });
    refusedBy(await svc.from("deals").update({ expected_value: "NaN" }).eq("id", d), "deals_expected_value_finite");
    refusedBy(await admin.client.from("deals").update({ expected_value: "NaN" }).eq("id", d), "deals_expected_value_finite");

    const t1 = await pipelineTotal();
    expect(typeof t1, `open_pipeline.total read ${JSON.stringify(t1)}`).toBe("number");
    expect(t1).toBe(await openSum());
    expect(t1 as number).toBeCloseTo((t0 as number) + 12345.67, 2);
    // and the per-stage figure for the stage holding the deal (every open deal here sits in it)
    const r = await admin.client.rpc("admin_dashboard_stats", { p_month_start: monthStart, p_d7: d7, p_d30: d30 });
    const stage = (r.data as { stages: Array<{ stage_id: string; total: unknown }> }).stages.find((s) => s.stage_id === openStage);
    expect(stage?.total).toBe(await openSum());
  });

  it("the dashboard's won-this-month total cannot turn NaN through a session's edit of a WON deal's expected value", async () => {
    // the closed-deal guard freezes a closed deal's closing details, not its
    // expected_value — an admin may still PATCH it after the win
    const d = await newDeal({ expected: "64000.00" });
    await newOffer(d, "63000.00", "accepted");
    expect((await admin.client.rpc("close_deal", { p_deal_id: d, p_outcome: "won" })).error).toBeNull();
    const w0 = await wonMonthTotal();
    expect(typeof w0).toBe("number");
    refusedBy(await admin.client.from("deals").update({ expected_value: "NaN" }).eq("id", d), "deals_expected_value_finite");
    const w1 = await wonMonthTotal();
    expect(typeof w1, `won_month.total read ${JSON.stringify(w1)}`).toBe("number");
    expect(w1).toBe(w0);
    expect((await stored("deals", d)).expected_value).toBe("64000.00");

    // Since 0140 won_month reads coalesce(final_value, expected_value, 0), so
    // the deal above (final value 63 000) no longer reads its estimate at all.
    // The won deal whose won figure IS its estimate is one closed with NO final
    // value — an admin override without an accepted offer — so the NaN path is
    // pinned on that one too.
    const n = await newDeal({ expected: "51000.00" });
    expect((await admin.client.rpc("close_deal", { p_deal_id: n, p_outcome: "won", p_override: true })).error).toBeNull();
    expect(await stored("deals", n)).toMatchObject({ status: "won", final_value: null, expected_value: "51000.00" });
    const w2 = await wonMonthTotal();
    expect(typeof w2).toBe("number");
    expect(w2 as number).toBeCloseTo((w1 as number) + 51000, 2);
    refusedBy(await admin.client.from("deals").update({ expected_value: "NaN" }).eq("id", n), "deals_expected_value_finite");
    const w3 = await wonMonthTotal();
    expect(typeof w3, `won_month.total read ${JSON.stringify(w3)}`).toBe("number");
    expect(w3).toBe(w2);
  });

  it("the agent report's won value comes from final_value, and a NaN write cannot turn it NaN", async () => {
    const d = await newDeal({ expected: "80000.00" });
    await newOffer(d, "75000.25", "accepted");
    expect((await admin.client.rpc("close_deal", { p_deal_id: d, p_outcome: "won" })).error).toBeNull();
    const w0 = await agentWonValue();
    expect(typeof w0).toBe("number");
    expect(w0).toBe(await agentWonSum());

    refusedBy(await svc.from("deals").update({ final_value: "NaN" }).eq("id", d), "deals_final_value_finite");

    const w1 = await agentWonValue();
    expect(typeof w1, `won_value read ${JSON.stringify(w1)}`).toBe("number");
    expect(w1).toBe(w0);
  });
});

// ---------------------------------------------------------------------------
describe("6. the migration", () => {
  /** Run `body` in a transaction on `o` that is always ROLLED BACK; collects the NOTICEs it raises. */
  async function rolledBack(body: (notices: string[]) => Promise<void>) {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => {
      if (m.message) notices.push(m.message);
    };
    o.on("notice", onNotice);
    await o.query("begin");
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
  const failure = (q: Promise<unknown>) =>
    q.then(
      () => null,
      (e: PgError) => e,
    );

  it("replays over the state before it: preflight and postflight pass, three validated CHECKs, the diagnostic as its last row", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0144_SQL);
      expect(await finiteChecks()).toBe(0);
      const row = lastRow(await o.query(readMigration0144()));
      expect(Object.keys(row)).toEqual(["migration", "offers_checked", "deals_checked"]);
      expect(row.migration).toBe("0144");
      expect(await finiteChecks()).toBe(3);
      expect(notices.some((m) => m.startsWith("0144: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0144: postflight passed"))).toBe(true);
    });
  });

  it("its shape: every abort precedes the first DDL, the lock precedes the counts, no CHECK is NOT VALID, no row is deleted or rewritten, no begin/commit", () => {
    const code = readMigration0144().replace(/--[^\n]*/g, "");
    const firstDdl = code.search(/\balter table\b/i);
    expect(firstDdl).toBeGreaterThan(0);
    const aborts = [...code.matchAll(/raise exception '0144 aborted/g)].map((m) => m.index!);
    expect(aborts).toHaveLength(2);
    for (const at of aborts) expect(at).toBeLessThan(firstDdl);
    const lock = code.indexOf("lock table public.deals, public.offers in access exclusive mode;");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(code.indexOf("select count(*) into n_offer"));
    expect(code).not.toMatch(/not\s+valid/i);
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
    // it never deletes, rewrites or truncates a row: the only statements that touch data are the counts
    expect(code).not.toMatch(/\b(delete\s+from|update\s+public\.|truncate)\b/i);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0144();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/^0144 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("refuses stored NaN rows, naming only the per-column counts; the header's query and the operator's script list exactly them", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0144_SQL);
      const secret = `ZZFIN ${TAG} do-not-print`;
      // distinct counts per column (2 / 1 / 2), so a count that reads the wrong column cannot pass
      const plantDeal = async (expected: string, final: string | null) =>
        (
          await o.query<{ id: string }>(
            `insert into public.deals (org_id, stage_id, title, agent_id, expected_value, final_value)
             values ($1, $2, $3, $4, $5, $6) returning id`,
            [ORG, openStage, secret, agent.id, expected, final],
          )
        ).rows[0]!.id;
      const plantOffer = async (dealId: string) =>
        (await o.query<{ id: string }>(`insert into public.offers (org_id, deal_id, amount) values ($1, $2, 'NaN') returning id`, [ORG, dealId])).rows[0]!.id;
      const dE = await plantDeal("NaN", null); // the expected value only
      const dF1 = await plantDeal("1000.00", "NaN"); // the final value only
      const dF2 = await plantDeal("2000.00", "NaN");
      const of1 = await plantOffer(dE);
      const of2 = await plantOffer(dF1);
      const planted = [`deals.expected_value:${dE}`, `deals.final_value:${dF1}`, `deals.final_value:${dF2}`, `offers.amount:${of1}`, `offers.amount:${of2}`].sort();

      await o.query("savepoint before_0144");
      const e = await failure(o.query(readMigration0144()));
      expect(e?.message).toBe(
        "0144 aborted: 2 offer amount(s), 1 deal expected value(s) and 2 deal final value(s) are NaN or infinite — nothing was changed. " +
          "List them with the read-only query in this file's header, correct each one, then apply again",
      );
      for (const leaked of [dE, dF1, dF2, of1, of2, secret, ORG]) expect(e!.message).not.toContain(leaked);
      await o.query("rollback to savepoint before_0144");
      // hygiene (the savepoint restores the catalogue and the rows whatever ran): the
      // proof that the file aborts BEFORE any DDL and never touches a row is the
      // exact preflight message above and the shape test's static checks
      expect(await finiteChecks()).toBe(0);
      expect((await stored("offers", of1)).amount).toBe("NaN");

      // the header's read-only query lists exactly them
      const listed = await o.query(
        `select 'offers.amount' as col, id, org_id from public.offers where amount in ('NaN', 'Infinity', '-Infinity')
         union all
         select 'deals.expected_value', id, org_id from public.deals where expected_value in ('NaN', 'Infinity', '-Infinity')
         union all
         select 'deals.final_value', id, org_id from public.deals where final_value in ('NaN', 'Infinity', '-Infinity')`,
      );
      expect(listed.rows.filter((r) => r.org_id === ORG).map((r) => `${r.col}:${r.id}`).sort()).toEqual(planted);
      // and so does the operator's read-only preflight script (its two SELECTs, without its own begin/rollback)
      const script = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "maintenance", "preflight-0144-finite-amounts.sql"), "utf-8")
        .replace(/\r\n/g, "\n");
      const body = script.slice(script.indexOf("begin transaction read only;") + "begin transaction read only;".length, script.lastIndexOf("rollback;"));
      const [counts, listedRows] = (await o.query(body)) as unknown as { rows: Record<string, unknown>[] }[];
      expect(counts!.rows[0]).toMatchObject({
        offer_amount_nan: "2",
        deal_expected_value_nan: "1",
        deal_final_value_nan: "2",
        offer_amount_infinite: "0",
        deal_expected_value_infinite: "0",
        deal_final_value_infinite: "0",
      });
      expect(listedRows!.rows.filter((r) => r.org_id === ORG).map((r) => `${r.col}:${r.id}`).sort()).toEqual(planted);
      for (const r of listedRows!.rows) expect(Object.keys(r)).toEqual(["col", "id", "org_id", "deal_status", "offer_status", "created_at"]);

      // each count refuses on its own: with no NaN offer left, and then with only final values left
      await o.query("delete from public.offers where id = any($1::uuid[])", [[of1, of2]]);
      await o.query("savepoint no_offers");
      expect((await failure(o.query(readMigration0144())))?.message).toMatch(
        /^0144 aborted: 0 offer amount\(s\), 1 deal expected value\(s\) and 2 deal final value\(s\) are NaN or infinite — nothing was changed\./,
      );
      await o.query("rollback to savepoint no_offers");
      await o.query("update public.deals set expected_value = 1 where id = $1", [dE]);
      await o.query("savepoint finals_only");
      expect((await failure(o.query(readMigration0144())))?.message).toMatch(
        /^0144 aborted: 0 offer amount\(s\), 0 deal expected value\(s\) and 2 deal final value\(s\) are NaN or infinite — nothing was changed\./,
      );
      await o.query("rollback to savepoint finals_only");
    });
  });

  it("a write in flight makes it wait at most lock_timeout, then abort (55P03), changing nothing", async () => {
    const d = await newDeal();
    await a.query("begin");
    await a.query("update public.offers set amount = amount where deal_id = $1", [d]);
    try {
      await rolledBack(async () => {
        const t0 = Date.now();
        const e = await failure(o.query(readMigration0144()));
        const waited = Date.now() - t0;
        expect(e?.code, e?.message).toBe("55P03");
        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(15_000);
      });
    } finally {
      await a.query("rollback");
    }
    expect(await finiteChecks()).toBe(3);
  });

  it("is replay-safe: run twice in one transaction, one validated copy of each CHECK", async () => {
    await rolledBack(async () => {
      await o.query(readMigration0144());
      await o.query(readMigration0144());
      const { rows } = await o.query<{ conname: string; c: number }>(
        `select conname, count(*)::int as c from pg_constraint where conname = any($1::text[]) and convalidated group by conname order by conname`,
        [FINITE_CHECKS_0144 as unknown as string[]],
      );
      expect(rows).toEqual([
        { conname: "deals_expected_value_finite", c: 1 },
        { conname: "deals_final_value_finite", c: 1 },
        { conname: "offers_amount_finite", c: 1 },
      ]);
    });
  });

  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "an offers CHECK that lets NaN through",
      (s) => s.replace("check (amount not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));", "check (amount >= 0);"),
      /^0144 postflight: offers_amount_finite on offers is not the validated CHECK/,
    ],
    [
      "an expected-value CHECK without its infinity arms",
      (s) =>
        s.replace(
          "or expected_value not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),",
          "or expected_value <> 'NaN'::numeric),",
        ),
      /^0144 postflight: deals_expected_value_finite on deals is not the validated CHECK/,
    ],
    [
      "a final-value CHECK left NOT VALID",
      (s) =>
        s.replace(
          "or final_value not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));",
          "or final_value not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)) not valid;",
        ),
      /^0144 postflight: deals_final_value_finite on deals is not the validated CHECK/,
    ],
    [
      "a non-negative CHECK lost on the way",
      (s) =>
        s.replace(
          "alter table public.offers\n  drop constraint if exists offers_amount_finite;",
          "alter table public.offers\n  drop constraint if exists offers_amount_finite,\n  drop constraint offers_amount_non_negative;",
        ),
      /^0144 postflight: offers_amount_non_negative on offers is not the validated CHECK/,
    ],
    [
      "a column whose nullability moved",
      (s) => s.replace("-- 2. Postflight", "alter table public.offers alter column amount drop not null;\n-- 2. Postflight"),
      /^0144 postflight: offers\.amount, deals\.expected_value or deals\.final_value is no longer numeric\(14,2\) with its nullability/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`the postflight refuses ${label}`, async () => {
      const sql = readMigration0144();
      const bad = mutate(sql);
      expect(bad, "the mutation installed").not.toBe(sql);
      await rolledBack(async () => {
        await o.query(REVERT_0144_SQL);
        await o.query("savepoint before_0144");
        const e = await failure(o.query(bad));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0144");
        expect(await finiteChecks()).toBe(0);
        const { rows } = await o.query<{ c: number }>(
          `select count(*)::int as c from pg_constraint where conname in ('offers_amount_non_negative', 'deals_expected_value_non_negative', 'deals_final_value_non_negative') and convalidated`,
        );
        expect(rows[0]!.c).toBe(3);
      });
    });
  }

  it("the rollback recipe leaves 0143's state: the three CHECKs gone, the non-negative ones in place — and NaN accepted again", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0144_SQL);
      expect(await finiteChecks()).toBe(0);
      const { rows } = await o.query<{ c: number }>(
        `select count(*)::int as c from pg_constraint where conname in ('offers_amount_non_negative', 'deals_expected_value_non_negative', 'deals_final_value_non_negative') and convalidated`,
      );
      expect(rows[0]!.c).toBe(3);
      const d = await newDeal();
      await o.query("update public.deals set expected_value = 'NaN' where id = $1", [d]);
      expect((await stored("deals", d)).expected_value).toBe("NaN");
    });
  });

  it("the restore pack's 0144 row passes now, and reads a dropped CHECK or one left NOT VALID as drift", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const start = "  select 'INTEGRITY: no deal or offer amount is NaN or infinite";
    const from = pack.indexOf(start);
    expect(from, "the pack carries the 0144 row").toBeGreaterThan(0);
    const row = `select * from (${pack.slice(from, pack.indexOf("\n  union all\n", from))}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now.actual).toBe(now.expected);
    await rolledBack(async () => {
      await o.query("alter table public.deals drop constraint deals_final_value_finite");
      expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
    });
    await rolledBack(async () => {
      await o.query("alter table public.offers drop constraint offers_amount_finite");
      await o.query(
        "alter table public.offers add constraint offers_amount_finite check (amount not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)) not valid",
      );
      expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
    });
  });

  it("the chain verifies for the organisation after everything above", async () => {
    const { rows } = await o.query("select ok, reason from public.verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
