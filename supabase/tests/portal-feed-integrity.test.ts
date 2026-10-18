/**
 * 0150 / 0151 — portal feed integrity (portal integrations audit 2026-10-18;
 * the portal half of ANON-1; DECISIONS T-portal-feed-integrity).
 *
 *   1. The token, not its digest: portal_feed_connection / portal_feed_supplement
 *      answer the URL's token and nothing else — the stored sha256 (what every
 *      export, dump and member's read holds) opens nothing, and a connection
 *      written the 0097 way (the column = sha256(token)) still answers its
 *      token, so no existing feed URL changes.
 *   2. Telemetry is the route's: record_portal_pull is service_role only; it
 *      records every outcome, a failure never overwrites the last good count,
 *      and the history folds a repeated answer into one run and keeps 50.
 *      A session may not write the pull columns at all.
 *   3. The export revision: sync_portal_export keeps a listing's date while
 *      its rendering is unchanged, moves it when the rendering changes,
 *      forgets a listing that left, and is service_role only.
 *   4. After 0151 no digest-taking function remains, and the catalogue holds
 *      no anon-callable reader of the token column that skips the hash.
 *   5. The migrations: 0150 replays over 0149's state and over itself; its
 *      preflight refuses a 0097 body it was not written against; each
 *      rollback restores the state before it (0097's bodies by md5).
 *
 * At 0149 this file is RED where the defect lives: the four functions do not
 * exist, the digest-taking ones do, and a session may write the pull columns.
 */
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORG_A,
  ORG_B,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";
import { REVERT_0150_SQL, readMigration0150 } from "./revert-0150";
import { BODY_MD5_0097, REVERT_0151_SQL, readMigration0151 } from "./revert-0151";

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const svc = serviceClient();
const anon = anonClient();
const run = Date.now().toString(36);
/** this file's own connection — portals.test.ts owns ORG_A's jamesedition */
const PORTAL = "aplaceinthesun";
const ref = (tag: string) => `ZZPFI-${tag}${run}`.slice(0, 20);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let pg: Client;
let adminA: TestUser;
let agentA: TestUser;
let adminB: TestUser;
let token = "";
let digest = "";
let propertyId = "";

const RECORD_ARGS = (over: Partial<Record<string, unknown>> = {}) => ({
  p_token: token,
  p_ua: "JamesEdition Feed Crawler 1.0",
  p_outcome: "served",
  p_served: 3,
  p_selected: 3,
  p_excluded: 0,
  p_reason: null,
  p_detail: {},
  ...over,
});

const connectionRow = async () => {
  const { data, error } = await svc
    .from("portal_connections")
    .select("id, last_pulled_at, last_pulled_ua, last_pull_count, last_pull_outcome, last_success_at, last_error_at, last_error_reason")
    .eq("org_id", ORG_A)
    .eq("portal", PORTAL)
    .single();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown> & { id: string };
};

beforeAll(async () => {
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");
  adminA = await createTestUser(svc, `pfi-adm-${run}@example.invalid`, "admin", ORG_A, { enrolFactor: true });
  agentA = await createTestUser(svc, `pfi-agt-${run}@example.invalid`, "agent", ORG_A, { enrolFactor: true });
  adminB = await createTestUser(svc, `pfi-admb-${run}@example.invalid`, "admin", ORG_B, { enrolFactor: true });

  // the connection exactly as 0097's app writes it: the column = sha256(token)
  token = randomBytes(32).toString("hex");
  digest = sha(token);
  // This file owns ORG_A's aplaceinthesun. A run killed before afterAll would
  // leave its selection and property behind, and portal_listings has no key to
  // the connection — so clear the selections too, or selected_count reads 2.
  await svc.from("portal_listings").delete().eq("org_id", ORG_A).eq("portal", PORTAL);
  await svc.from("properties").delete().eq("org_id", ORG_A).like("reference", "ZZPFI-%");
  await svc.from("portal_connections").delete().eq("org_id", ORG_A).eq("portal", PORTAL);
  const { error } = await svc
    .from("portal_connections")
    .insert({ org_id: ORG_A, portal: PORTAL, enabled: true, feed_token_sha256: digest, settings: { email: "pfi@example.invalid" } });
  if (error) throw new Error(error.message);

  const { data: p, error: pErr } = await svc
    .from("properties")
    .insert({
      org_id: ORG_A,
      reference: ref("P"),
      property_type: "villa",
      status: "available",
      visibility: "public",
      asking_price: 650000,
      currency: "EUR",
      public_description: { en: "Test villa" },
      location: "SRID=4326;POINT(32.38 34.88)",
      location_approx: false,
    })
    .select("id")
    .single();
  if (pErr) throw new Error(pErr.message);
  propertyId = p.id as string;
  const { error: sErr } = await svc
    .from("portal_listings")
    .insert({ org_id: ORG_A, property_id: propertyId, portal: PORTAL, selected_by: adminA.id });
  if (sErr) throw new Error(sErr.message);
});

afterAll(async () => {
  await svc.from("portal_listings").delete().eq("property_id", propertyId);
  await svc.from("properties").delete().eq("id", propertyId);
  // the connection's history and export state cascade with it
  await svc.from("portal_connections").delete().eq("org_id", ORG_A).eq("portal", PORTAL);
  await pg.end();
});

describe("1. the readers answer the token, never the stored digest", () => {
  it("portal_feed_connection answers the URL's token — a connection written the 0097 way keeps its URL", async () => {
    const r = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: token });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([
      { org_slug: "test-org-a", enabled: true, settings: { email: "pfi@example.invalid" }, selected_count: 1 },
    ]);
  });

  it("selected_count is the supplement's own count, counted independently — and 0 while disabled", async () => {
    const supplement = await anon.rpc("portal_feed_supplement", { p_token: token });
    const lookup = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: token });
    expect(lookup.data?.[0]?.selected_count).toBe((supplement.data ?? []).length);
    await svc.from("properties").update({ status: "sold" }).eq("id", propertyId);
    try {
      const sold = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: token });
      expect(sold.data?.[0]?.selected_count).toBe(0);
    } finally {
      await svc.from("properties").update({ status: "available" }).eq("id", propertyId);
    }
    await svc.from("portal_connections").update({ enabled: false }).eq("org_id", ORG_A).eq("portal", PORTAL);
    try {
      const off = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: token });
      expect(off.data?.[0]).toMatchObject({ enabled: false, selected_count: 0 });
    } finally {
      await svc.from("portal_connections").update({ enabled: true }).eq("org_id", ORG_A).eq("portal", PORTAL);
    }
  });

  it("the stored value opens nothing: a copy of the column is not a token", async () => {
    const stored = (await svc.from("portal_connections").select("feed_token_sha256").eq("org_id", ORG_A).eq("portal", PORTAL).single()).data
      ?.feed_token_sha256 as string;
    expect(stored).toBe(digest);
    const c = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: stored });
    expect(c.error).toBeNull();
    expect(c.data).toEqual([]);
    const s = await anon.rpc("portal_feed_supplement", { p_token: stored });
    expect(s.error).toBeNull();
    expect(s.data).toEqual([]);
  });

  it("an agent who reads the column through RLS still holds no credential", async () => {
    const read = await agentA.client.from("portal_connections").select("feed_token_sha256").eq("portal", PORTAL);
    expect(read.error).toBeNull();
    const value = (read.data ?? [])[0]?.feed_token_sha256 as string;
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    const s = await anon.rpc("portal_feed_supplement", { p_token: value });
    expect(s.data).toEqual([]);
  });

  it("portal_feed_supplement returns the selected public listing with its exact point for the token", async () => {
    const s = await anon.rpc("portal_feed_supplement", { p_token: token });
    expect(s.error).toBeNull();
    const row = (s.data ?? []).find((r: { reference: string }) => r.reference === ref("P"));
    expect(row).toBeDefined();
    expect(row.lat).toBeCloseTo(34.88, 5);
    expect(row.lng).toBeCloseTo(32.38, 5);
    expect(row.images).toEqual([]);
  });

  it("a malformed token or the wrong portal answers nothing, without an error", async () => {
    for (const bad of ["", "nothex", token.toUpperCase(), `${token}0`, "' or 1=1 --"]) {
      const c = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: bad });
      expect(c.error, bad).toBeNull();
      expect(c.data, bad).toEqual([]);
    }
    const other = await anon.rpc("portal_feed_connection", { p_portal: "jamesedition", p_token: token });
    expect(other.data).toEqual([]);
  });

  it("only anon and the service role may call the readers; a signed-in session may not", async () => {
    const asAdmin = await adminA.client.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: token });
    expect(asAdmin.error?.code).toBe("42501");
    const asSvc = await svc.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: token });
    expect(asSvc.error).toBeNull();
    expect(asSvc.data).toHaveLength(1);
  });

  it("SQL hashes a token exactly as the application does (hashPortalToken)", async () => {
    const t = "0123456789abcdef".repeat(4);
    const { rows } = await pg.query<{ h: string }>(`select encode(pg_catalog.sha256(convert_to($1, 'UTF8')), 'hex') as h`, [t]);
    expect(rows[0].h).toBe(sha(t));
    expect(rows[0].h).toBe("a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e");
  });
});

describe("2. the pull record is the route's", () => {
  it("anon and a signed-in admin are refused record_portal_pull; the service role records", async () => {
    const a = await anon.rpc("record_portal_pull", RECORD_ARGS());
    expect(a.error?.code).toBe("42501");
    const s = await adminA.client.rpc("record_portal_pull", RECORD_ARGS());
    expect(s.error?.code).toBe("42501");
    const ok = await svc.rpc("record_portal_pull", RECORD_ARGS({ p_served: 3 }));
    expect(ok.error).toBeNull();
    const c = await connectionRow();
    expect(c).toMatchObject({ last_pulled_ua: "JamesEdition Feed Crawler 1.0", last_pull_count: 3, last_pull_outcome: "served" });
    expect(c.last_success_at).not.toBeNull();
  });

  it("a session may not write the pull columns over PostgREST (0150's column grants), but may still toggle", async () => {
    const forge = await adminA.client
      .from("portal_connections")
      .update({ last_pulled_ua: "forged", last_pull_count: 999 })
      .eq("portal", PORTAL)
      .select("id");
    expect(forge.error?.code).toBe("42501");
    const toggle = await adminA.client.from("portal_connections").update({ enabled: true }).eq("portal", PORTAL).select("id");
    expect(toggle.error).toBeNull();
    expect(toggle.data).toHaveLength(1);
    const c = await connectionRow();
    expect(c.last_pulled_ua).not.toBe("forged");
  });

  it("a failure records its reason and keeps the last good count and success time", async () => {
    await svc.rpc("record_portal_pull", RECORD_ARGS({ p_served: 4, p_selected: 4 }));
    const before = await connectionRow();
    const r = await svc.rpc(
      "record_portal_pull",
      RECORD_ARGS({ p_outcome: "failed", p_served: null, p_selected: null, p_excluded: null, p_reason: "supplement_failed" }),
    );
    expect(r.error).toBeNull();
    const after = await connectionRow();
    expect(after).toMatchObject({ last_pull_outcome: "failed", last_error_reason: "supplement_failed", last_pull_count: 4 });
    expect(after.last_success_at).toBe(before.last_success_at);
    expect(after.last_error_at).not.toBeNull();
  });

  it("a disabled answer is a success with 0 served; a served pull keeps its exclusions by reason", async () => {
    await svc.rpc("record_portal_pull", RECORD_ARGS({ p_outcome: "disabled", p_served: 0, p_selected: null, p_excluded: null }));
    expect(await connectionRow()).toMatchObject({ last_pull_outcome: "disabled", last_pull_count: 0 });
    const r = await svc.rpc(
      "record_portal_pull",
      RECORD_ARGS({ p_served: 0, p_selected: 2, p_excluded: 2, p_detail: { too_few_photos: 2, revisions: "none" } }),
    );
    expect(r.error).toBeNull();
    const { id } = await connectionRow();
    const last = await pg.query(
      `select outcome, served, selected, excluded, detail from public.portal_pull_log where connection_id = $1 order by last_at desc, id desc limit 1`,
      [id],
    );
    expect(last.rows[0]).toEqual({ outcome: "served", served: 0, selected: 2, excluded: 2, detail: { too_few_photos: 2, revisions: "none" } });
  });

  it("refuses what the route never sends: an unknown outcome, a reason that is not a code, a negative count, a large detail", async () => {
    for (const over of [
      { p_outcome: "published" },
      { p_outcome: "withheld" },
      { p_outcome: "failed", p_reason: "Not A Code" },
      { p_served: -1 },
      { p_detail: { blob: "x".repeat(5000) } },
      { p_detail: [] },
    ]) {
      const r = await svc.rpc("record_portal_pull", RECORD_ARGS(over));
      expect(r.error?.code, JSON.stringify(over)).toBe("22023");
    }
  });

  it("an unknown token records nothing, without an error", async () => {
    const before = await connectionRow();
    const r = await svc.rpc("record_portal_pull", RECORD_ARGS({ p_token: "e".repeat(64), p_ua: "stranger" }));
    expect(r.error).toBeNull();
    expect((await connectionRow()).last_pulled_ua).toBe(before.last_pulled_ua);
  });

  it("history: a repeated answer folds into one run; a different answer starts a new one; 50 runs are kept", async () => {
    const { id } = await connectionRow();
    await pg.query(`delete from public.portal_pull_log where connection_id = $1`, [id]);
    await svc.rpc("record_portal_pull", RECORD_ARGS({ p_served: 7, p_selected: 7 }));
    await svc.rpc("record_portal_pull", RECORD_ARGS({ p_served: 7, p_selected: 7 }));
    let log = await pg.query(`select outcome, served, hits from public.portal_pull_log where connection_id = $1 order by last_at desc, id desc`, [id]);
    expect(log.rows).toEqual([{ outcome: "served", served: 7, hits: 2 }]);
    await svc.rpc("record_portal_pull", RECORD_ARGS({ p_served: 6, p_selected: 7, p_excluded: 1 }));
    log = await pg.query(`select served, hits from public.portal_pull_log where connection_id = $1 order by last_at desc, id desc`, [id]);
    expect(log.rows).toEqual([{ served: 6, hits: 1 }, { served: 7, hits: 2 }]);
    for (let i = 0; i < 55; i++) {
      await svc.rpc("record_portal_pull", RECORD_ARGS({ p_served: 100 + i, p_selected: 100 + i }));
    }
    const count = await pg.query(`select count(*)::int as n, max(served) as top from public.portal_pull_log where connection_id = $1`, [id]);
    expect(count.rows[0]).toEqual({ n: 50, top: 154 });
  });

  it("the history is the org admin's to read: not an agent's, not another org's", async () => {
    const own = await adminA.client.from("portal_pull_log").select("outcome").limit(1);
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBe(1);
    const agent = await agentA.client.from("portal_pull_log").select("outcome");
    expect(agent.error).toBeNull();
    expect(agent.data).toEqual([]);
    const other = await adminB.client.from("portal_pull_log").select("outcome");
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
    const write = await adminA.client.from("portal_pull_log").insert({ org_id: ORG_A, connection_id: (await connectionRow()).id, outcome: "served" });
    expect(write.error?.code).toBe("42501");
  });
});

describe("3. the export revision", () => {
  const row = (reference: string, content: string) => ({ reference, sha256: sha(content) });
  const sync = (rows: unknown, t = token) => svc.rpc("sync_portal_export", { p_token: t, p_rows: rows as never });
  /** the answer is ONE object {reference: changed_at} — a table would be capped at max_rows */
  const at = (data: unknown, reference: string) => (data as Record<string, string> | null)?.[reference];

  it("is service_role only", async () => {
    const a = await anon.rpc("sync_portal_export", { p_token: token, p_rows: [] });
    expect(a.error?.code).toBe("42501");
    const s = await adminA.client.rpc("sync_portal_export", { p_token: token, p_rows: [] });
    expect(s.error?.code).toBe("42501");
  });

  it("answers 1,200 listings in one object — more than PostgREST's max_rows would let a table carry", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => row(`ZZPFI-M${i}`, `m${i}`));
    const r = await sync(many);
    expect(r.error).toBeNull();
    expect(Object.keys(r.data as object)).toHaveLength(1200);
    await sync([]);
  });

  it("an unchanged rendering keeps its date; a changed one moves it; a listing that left is forgotten", async () => {
    const first = await sync([row("ZZPFI-A", "a1"), row("ZZPFI-B", "b1")]);
    expect(first.error).toBeNull();
    const a1 = at(first.data, "ZZPFI-A");
    const b1 = at(first.data, "ZZPFI-B");
    expect(a1).toBeDefined();
    await new Promise((r) => setTimeout(r, 25));

    const second = await sync([row("ZZPFI-A", "a1"), row("ZZPFI-B", "b2")]);
    expect(at(second.data, "ZZPFI-A")).toBe(a1);
    expect(Date.parse(at(second.data, "ZZPFI-B")!)).toBeGreaterThan(Date.parse(b1!));

    const third = await sync([row("ZZPFI-A", "a1")]);
    expect(at(third.data, "ZZPFI-B")).toBeUndefined();
    expect(at(third.data, "ZZPFI-A")).toBe(a1);
  });

  it("a reference longer than 40 characters syncs — a unit's reference has no length limit", async () => {
    const long = `ZZPFI-${"Seafront Residence B".replace(/ /g, "")}-Penthouse12A-${run}`;
    expect(long.length).toBeGreaterThan(40);
    const r = await sync([row(long, "x")]);
    expect(r.error).toBeNull();
    expect(at(r.data, long)).toBeDefined();
    await sync([]);
  });

  it("serving the empty document of a DISABLED connection forgets its revisions; a late record after re-enabling does not", async () => {
    await sync([row("ZZPFI-D", "d1")]);
    const { id } = await connectionRow();
    await svc.from("portal_connections").update({ enabled: false }).eq("org_id", ORG_A).eq("portal", PORTAL);
    try {
      await svc.rpc("record_portal_pull", RECORD_ARGS({ p_outcome: "disabled", p_served: 0, p_selected: null, p_excluded: null }));
      const gone = await pg.query(`select count(*)::int as n from public.portal_export_state where connection_id = $1`, [id]);
      expect(gone.rows[0].n).toBe(0);
    } finally {
      await svc.from("portal_connections").update({ enabled: true }).eq("org_id", ORG_A).eq("portal", PORTAL);
    }
    // re-enabled and synced again; a 'disabled' record arriving late must not wipe it
    await sync([row("ZZPFI-D", "d1")]);
    await svc.rpc("record_portal_pull", RECORD_ARGS({ p_outcome: "disabled", p_served: 0, p_selected: null, p_excluded: null }));
    const kept = await pg.query(`select count(*)::int as n from public.portal_export_state where connection_id = $1`, [id]);
    expect(kept.rows[0].n).toBe(1);
    await sync([]);
  });

  it("a pull record does not move a listing's date", async () => {
    const before = await sync([row("ZZPFI-A", "a1")]);
    await svc.rpc("record_portal_pull", RECORD_ARGS({ p_served: 1, p_selected: 1 }));
    const after = await sync([row("ZZPFI-A", "a1")]);
    expect(at(after.data, "ZZPFI-A")).toBe(at(before.data, "ZZPFI-A"));
  });

  it("refuses rows that are not {reference, sha256}, or a reference twice", async () => {
    for (const bad of [{}, [{ reference: "X" }], [{ reference: "X", sha256: "nothex" }], [row("X", "1"), row("X", "2")], [{ reference: "", sha256: sha("1") }]]) {
      const r = await sync(bad);
      expect(r.error?.code, JSON.stringify(bad)).toBe("22023");
    }
  });

  it("a disabled connection or a wrong token writes nothing and answers nothing", async () => {
    const wrong = await sync([row("ZZPFI-Z", "z")], "d".repeat(64));
    expect(wrong.error).toBeNull();
    expect(wrong.data).toEqual({});
    await svc.from("portal_connections").update({ enabled: false }).eq("org_id", ORG_A).eq("portal", PORTAL);
    try {
      const off = await sync([row("ZZPFI-Z", "z")]);
      expect(off.data).toEqual({});
      const { rows } = await pg.query(`select count(*)::int as n from public.portal_export_state where reference = 'ZZPFI-Z'`);
      expect(rows[0].n).toBe(0);
    } finally {
      await svc.from("portal_connections").update({ enabled: true }).eq("org_id", ORG_A).eq("portal", PORTAL);
    }
  });

  it("nobody but the service role reads the export state", async () => {
    const a = await adminA.client.from("portal_export_state").select("reference");
    expect(a.error?.code).toBe("42501");
  });
});

describe("4. after 0151, nothing accepts the stored value", () => {
  it("0097's three digest-taking functions are gone", async () => {
    const { rows } = await pg.query(
      `select to_regprocedure('public.portal_connection_by_token(text, text)') as a,
              to_regprocedure('public.portal_supplement(text)') as b,
              to_regprocedure('public.note_portal_pull(text, text, integer)') as c`,
    );
    expect(rows[0]).toEqual({ a: null, b: null, c: null });
  });

  it("no anon-callable function reads feed_token_sha256 without hashing its argument", async () => {
    const { rows } = await pg.query(
      `select p.oid::regprocedure::text as fn
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and has_function_privilege('anon', p.oid, 'execute')
          and position('feed_token_sha256' in p.prosrc) > 0
          and position('pg_catalog.sha256(convert_to(' in p.prosrc) = 0`,
    );
    expect(rows).toEqual([]);
  });
});

describe("5. the migrations", () => {
  const inRolledBack = async (fn: () => Promise<void>) => {
    await pg.query("begin");
    try {
      await fn();
    } finally {
      await pg.query("rollback");
    }
  };

  it("0150 replays over 0149's state (revert 0151, revert 0150, apply 0150) and over itself, and 0151 then applies", async () => {
    await inRolledBack(async () => {
      await pg.query(REVERT_0151_SQL);
      await pg.query(REVERT_0150_SQL);
      const gone = await pg.query(`select to_regprocedure('public.portal_feed_connection(text, text)') as f`);
      expect(gone.rows[0].f).toBeNull();
      await pg.query(readMigration0150());
      await pg.query(readMigration0150()); // a replay leaves it as it was
      const fk = await pg.query(
        `select count(*)::int as n from pg_constraint where conname in ('portal_pull_log_connection_fkey', 'portal_export_state_connection_fkey')`,
      );
      expect(fk.rows[0].n).toBe(2);
      await pg.query(readMigration0151());
      const after = await pg.query(`select to_regprocedure('public.portal_supplement(text)') as s`);
      expect(after.rows[0].s).toBeNull();
    });
  });

  it("between the two, the deployed application's 0097 calls still answer (expand is additive)", async () => {
    await inRolledBack(async () => {
      await pg.query(REVERT_0151_SQL);
      await pg.query("set local role anon");
      const old = await pg.query(`select org_slug from public.portal_connection_by_token($1, $2)`, [PORTAL, digest]);
      expect(old.rows).toEqual([{ org_slug: "test-org-a" }]);
      const fresh = await pg.query(`select org_slug from public.portal_feed_connection($1, $2)`, [PORTAL, token]);
      expect(fresh.rows).toEqual([{ org_slug: "test-org-a" }]);
    });
  });

  it("0151's rollback restores 0097's three bodies byte for byte, with anon EXECUTE", async () => {
    await inRolledBack(async () => {
      await pg.query(REVERT_0151_SQL);
      const { rows } = await pg.query<{ fn: string; md5: string; anon: boolean }>(
        `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
                md5(replace(p.prosrc, chr(13), '')) as md5,
                has_function_privilege('anon', p.oid, 'execute') as anon
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and p.proname in ('portal_connection_by_token', 'portal_supplement', 'note_portal_pull')`,
      );
      const byFn = Object.fromEntries(rows.map((r) => [r.fn.replace(/p_\w+ /g, "").replace(/ /g, ""), r]));
      for (const [fn, md5] of Object.entries(BODY_MD5_0097)) {
        expect(byFn[fn]?.md5, fn).toBe(md5);
        expect(byFn[fn]?.anon, fn).toBe(true);
      }
    });
  });

  it("0150's preflight refuses a 0097 body it was not written against", async () => {
    await inRolledBack(async () => {
      await pg.query(REVERT_0151_SQL);
      await pg.query(REVERT_0150_SQL);
      await pg.query(`create or replace function public.portal_supplement(p_token_sha256 text)
        returns table (reference text, lat double precision, lng double precision, location_approx boolean, images jsonb)
        language sql stable security definer set search_path = public as $$ select null::text, null::float8, null::float8, false, '[]'::jsonb $$`);
      await expect(pg.query(readMigration0150())).rejects.toThrow(/0150 aborted: public\.portal_supplement\(text\) is not 0097's body/);
    });
  });

  it("0151 refuses to run before 0150", async () => {
    await inRolledBack(async () => {
      await pg.query(REVERT_0151_SQL);
      await pg.query(REVERT_0150_SQL);
      await expect(pg.query(readMigration0151())).rejects.toThrow(/0151 aborted: 0150's functions are not all there/);
    });
  });

  it("0150's rollback puts 0095's grants back and keeps the token column untouched", async () => {
    await inRolledBack(async () => {
      await pg.query(REVERT_0151_SQL);
      await pg.query(REVERT_0150_SQL);
      const { rows } = await pg.query(
        `select has_table_privilege('authenticated', 'public.portal_connections', 'update') as upd,
                (select feed_token_sha256 from public.portal_connections where org_id = $1 and portal = $2) as stored`,
        [ORG_A, PORTAL],
      );
      expect(rows[0]).toEqual({ upd: true, stored: digest });
    });
  });
});
