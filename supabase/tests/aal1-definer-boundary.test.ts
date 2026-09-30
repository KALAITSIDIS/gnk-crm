import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TEST_PASSWORD,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * The second factor is mandatory (0059): every table carries a RESTRICTIVE
 * `require_aal2`, and every RPC since 0101 refuses an aal1 session. A SECURITY
 * DEFINER function or a definer view runs as its owner, so the tables' aal2
 * policy is not between it and the data — each must check `mfa_satisfied()`
 * itself (T-aal1-definer-boundary, migration 0127).
 *
 * At 0126 four did not:
 *   - `record_key_movement` — a password-only session moved keys and wrote
 *     key events into the chain;
 *   - `next_reference` — checked NOTHING: any signed-in session, second factor
 *     or not, advanced ANY organisation's reference counter;
 *   - `mandates_safe` — its WHERE mirrors `mandates_select` but not
 *     `require_aal2`, so aal1 read the organisation's mandates;
 *   - `org_mfa_status` — aal1 listed which colleagues have no second factor.
 * And the key tables could be written around the RPC altogether: a direct
 * `key_movements` INSERT, or a direct `property_keys` write of the status /
 * holder cache, with no event. `record_key_movement` also dropped a typed
 * holder whenever the staff id matched no active profile of the organisation.
 *
 * aal1 sessions are FRESH password-only sign-ins of users who DO have a
 * verified factor — the stolen-password shape (mfa-enforcement.test.ts).
 * Throwaway organisations, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN = Date.now().toString(36);

let svc: SupabaseClient;
let pg: Client;
let adminA: TestUser;
let lmA: TestUser;
let agentA: TestUser;
let adminB: TestUser;
let adminA1: SupabaseClient; // adminA, password only
let lmA1: SupabaseClient; // lmA, password only
let agentA1: SupabaseClient; // agentA, password only
const userIds: string[] = [];
let n = 0;

async function signInAal1(email: string): Promise<SupabaseClient> {
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  const { data } = await c.auth.getSession();
  const aal = JSON.parse(Buffer.from(data.session!.access_token.split(".")[1], "base64url").toString()).aal;
  if (aal !== "aal1") throw new Error(`expected an aal1 session for ${email}, got ${aal}`);
  return c;
}

async function one<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T> {
  const { rows } = await pg.query(sql, args);
  return rows[0] as T;
}
const count = async (sql: string, args: unknown[] = []) => (await one<{ c: number }>(sql, args)).c;

async function newProperty(org: string): Promise<string> {
  n += 1;
  const { data, error } = await svc
    .from("properties")
    .insert({ org_id: org, reference: `ZZAAL${RUN.slice(-4).toUpperCase()}${n}`, property_type: "apartment", status: "available" })
    .select("id")
    .single();
  if (error) throw new Error(`property fixture: ${error.message}`);
  return data.id as string;
}

async function newKey(org: string, extra: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  const property = await newProperty(org);
  const { data, error } = await svc
    .from("property_keys")
    .insert({ org_id: org, property_id: property, key_code: `ZZAAL-${RUN}-${n}`, ...extra })
    .select("id")
    .single();
  if (error) throw new Error(`key fixture: ${error.message}`);
  return data.id as string;
}

const keyRow = (id: string) =>
  one<{ status: string; current_holder_profile_id: string | null; current_holder_name: string | null; key_code: string; description: string | null }>(
    "select status::text, current_holder_profile_id, current_holder_name, key_code, description from property_keys where id = $1",
    [id],
  );
const movements = (key: string) => count("select count(*)::int as c from key_movements where key_id = $1", [key]);
const keyEvents = (key: string) =>
  count("select count(*)::int as c from events where entity_type = 'key' and entity_id = $1", [key]);

function move(c: SupabaseClient, key: string, action: string, holderId: string | null = null, holderName: string | null = null) {
  return c.rpc("record_key_movement", {
    p_key_id: key,
    p_action: action,
    p_holder_profile_id: holderId,
    p_holder_name: holderName,
  });
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG_A, `aal1 A ${RUN}`, `aal1-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `aal1 B ${RUN}`, `aal1-b-${RUN}`);
  [adminA, lmA, agentA, adminB] = await Promise.all([
    createTestUser(svc, `aal-admin-a-${RUN}@test.local`, "admin", ORG_A),
    createTestUser(svc, `aal-lm-a-${RUN}@test.local`, "listing_manager", ORG_A),
    createTestUser(svc, `aal-agent-a-${RUN}@test.local`, "agent", ORG_A),
    createTestUser(svc, `aal-admin-b-${RUN}@test.local`, "admin", ORG_B),
  ]);
  userIds.push(adminA.id, lmA.id, agentA.id, adminB.id);
  [adminA1, lmA1, agentA1] = await Promise.all([
    signInAal1(adminA.email),
    signInAal1(lmA.email),
    signInAal1(agentA.email),
  ]);
});

afterAll(async () => {
  const orgs = [ORG_A, ORG_B];
  await pg.query("delete from key_movements where org_id = any($1)", [orgs]);
  await pg.query("delete from property_keys where org_id = any($1)", [orgs]);
  await pg.query("delete from mandates where org_id = any($1)", [orgs]);
  await pg.query("delete from tasks where org_id = any($1)", [orgs]);
  await pg.query("delete from properties where org_id = any($1)", [orgs]);
  await pg.query("delete from reference_counters where org_id = any($1)", [orgs]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await pg.query("delete from profiles where org_id = any($1)", [orgs]);
  await pg.query("delete from events where org_id = any($1)", [orgs]);
  await pg.query("delete from events_chain_checkpoint where org_id = any($1)", [orgs]);
  await pg.query("delete from chain_checks where org_id = any($1)", [orgs]);
  await pg.query("delete from deal_stages where org_id = any($1)", [orgs]);
  await pg.query("delete from districts where org_id = any($1)", [orgs]);
  await pg.query("delete from organizations where id = any($1)", [orgs]);
  await pg.end();
});

describe("record_key_movement refuses a password-only session (2529)", () => {
  it.each([
    ["admin", () => adminA1],
    ["listing manager", () => lmA1],
    ["agent", () => agentA1],
  ])("an aal1 %s moves nothing and writes no event", async (_who, client) => {
    const key = await newKey(ORG_A);
    const r = await move(client(), key, "checkout", null, "Someone");
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
    expect(await keyRow(key)).toMatchObject({ status: "in_office", current_holder_name: null });
    expect(await movements(key)).toBe(0);
    expect(await keyEvents(key)).toBe(0);
  });

  it("the same users at aal2 still move keys, one movement and one event each", async () => {
    for (const u of [adminA, lmA, agentA]) {
      const key = await newKey(ORG_A);
      const r = await move(u.client, key, "checkout", null, "Front desk");
      expect(r.error, u.email).toBeNull();
      expect(await keyRow(key)).toMatchObject({ status: "checked_out", current_holder_name: "Front desk" });
      expect(await movements(key)).toBe(1);
      expect(await keyEvents(key)).toBe(1);
    }
  });
});

describe("a typed holder survives a staff id that matches no active profile of the organisation (2535)", () => {
  it.each([
    ["an id that matches no profile", () => randomUUID()],
    ["another organisation's active admin", () => adminB.id],
  ])("%s: the typed name is kept, the id is not", async (_label, id) => {
    const key = await newKey(ORG_A);
    const r = await move(adminA.client, key, "checkout", id(), "Typed Holder");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(await keyRow(key)).toMatchObject({
      status: "checked_out",
      current_holder_profile_id: null,
      current_holder_name: "Typed Holder",
    });
    const m = await one("select holder_profile_id, holder_name from key_movements where key_id = $1", [key]);
    expect(m).toEqual({ holder_profile_id: null, holder_name: "Typed Holder" });
  });

  it("an active same-organisation profile still wins over the typed name", async () => {
    const key = await newKey(ORG_A);
    const r = await move(adminA.client, key, "checkout", agentA.id, "Typed Holder");
    expect(r.error).toBeNull();
    const row = await keyRow(key);
    expect(row.current_holder_profile_id).toBe(agentA.id);
    expect(row.current_holder_name).toBe(`Test agent ${agentA.email}`);
  });
});

describe("the key tables cannot be written around the RPC (2540)", () => {
  it.each([
    ["admin", () => adminA],
    ["listing manager", () => lmA],
    ["agent", () => agentA],
  ])("a direct key_movements INSERT by an aal2 %s is refused", async (_who, u) => {
    const key = await newKey(ORG_A);
    const r = await u().client.from("key_movements").insert({
      org_id: ORG_A,
      key_id: key,
      action: "checkout",
      holder_name: "Forged",
      created_by: u().id,
    });
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
    expect(await movements(key)).toBe(0);
  });

  it.each([
    ["status", { status: "lost" }],
    ["the holder's name", { current_holder_name: "Forged" }],
    ["the holder's id", { current_holder_profile_id: randomUUID() }],
  ])("a direct property_keys UPDATE of %s by an aal2 admin or listing manager is refused", async (_what, patch) => {
    for (const u of [adminA, lmA]) {
      const key = await newKey(ORG_A);
      const r = await u.client.from("property_keys").update(patch).eq("id", key).select("id");
      expect(r.error?.code, `${u.email} ${JSON.stringify(r.error)}`).toBe("42501");
      expect(await keyRow(key)).toMatchObject({ status: "in_office", current_holder_name: null, current_holder_profile_id: null });
    }
  });

  it("editing a key's code and description still works, and a checked-out key's holder survives the edit", async () => {
    const key = await newKey(ORG_A);
    expect((await move(lmA.client, key, "checkout", null, "Kept Holder")).error).toBeNull();
    const r = await lmA.client
      .from("property_keys")
      .update({ key_code: `ZZAAL-EDIT-${RUN}`, description: "back door" })
      .eq("id", key)
      .select("id");
    expect(r.error).toBeNull();
    expect(r.data).toHaveLength(1);
    expect(await keyRow(key)).toMatchObject({
      key_code: `ZZAAL-EDIT-${RUN}`,
      description: "back door",
      status: "checked_out",
      current_holder_name: "Kept Holder",
    });
  });

  it("a key cannot be born out of the office or with a holder; a plain registration still works", async () => {
    const property = await newProperty(ORG_A);
    for (const extra of [
      { status: "checked_out", current_holder_name: "Forged" },
      { status: "lost" },
      { current_holder_name: "Forged" },
    ]) {
      const r = await adminA.client
        .from("property_keys")
        .insert({ org_id: ORG_A, property_id: property, key_code: `ZZAAL-BORN-${RUN}-${JSON.stringify(extra).length}`, ...extra })
        .select("id");
      expect(r.error?.code, JSON.stringify(extra)).toBe("42501");
    }
    const ok = await adminA.client
      .from("property_keys")
      .insert({ org_id: ORG_A, property_id: property, key_code: `ZZAAL-BORN-${RUN}-ok`, description: "front" })
      .select("id")
      .single();
    expect(ok.error).toBeNull();
    expect(await keyRow(ok.data!.id as string)).toMatchObject({ status: "in_office", current_holder_name: null });
  });
});

describe("next_reference is bound to the caller's second factor and organisation", () => {
  const counter = (org: string, code: string) =>
    one<{ v: number | null }>("select max(last_value)::int as v from reference_counters where org_id = $1 and district_code = $2", [org, code]).then((r) => r.v);

  it("a password-only session cannot draw a reference, for its own organisation or another", async () => {
    for (const [org, code] of [[ORG_A, "PAF"], [ORG_B, "PAF"]] as const) {
      const before = await counter(org, code);
      const r = await agentA1.rpc("next_reference", { p_org: org, p_district_code: code });
      expect(r.error?.code, `${org === ORG_A ? "own" : "other"} org: ${JSON.stringify(r.error)}`).toBe("42501");
      expect(await counter(org, code)).toBe(before);
    }
  });

  it("an aal2 session cannot draw ANOTHER organisation's reference, or invent a counter for an unknown one", async () => {
    for (const org of [ORG_B, randomUUID()]) {
      const r = await adminA.client.rpc("next_reference", { p_org: org, p_district_code: `Z${n}` });
      expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
      expect(await count("select count(*)::int as c from reference_counters where org_id = $1", [org])).toBe(0);
    }
  });

  it("an aal2 session draws its own organisation's references in sequence; the service role (the importer) any organisation's", async () => {
    const a = await agentA.client.rpc("next_reference", { p_org: ORG_A, p_district_code: "LIM" });
    const b = await agentA.client.rpc("next_reference", { p_org: ORG_A, p_district_code: "LIM" });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(Number(String(b.data).slice(3))).toBe(Number(String(a.data).slice(3)) + 1);
    const s = await svc.rpc("next_reference", { p_org: ORG_B, p_district_code: "LIM" });
    expect(s.error).toBeNull();
    expect(s.data).toBe("LIM0001");
  });
});

describe("mandates_safe and org_mfa_status answer only a second-factor session", () => {
  let mandate: string;
  beforeAll(async () => {
    const property = await newProperty(ORG_A);
    const { data, error } = await svc
      .from("mandates")
      .insert({ org_id: ORG_A, property_id: property, type: "open", status: "active", commission_pct: 2.5, created_by: adminA.id })
      .select("id")
      .single();
    if (error) throw new Error(`mandate fixture: ${error.message}`);
    mandate = data.id as string;
  });

  it("an aal1 admin or listing manager reads no mandate through the view", async () => {
    for (const c of [adminA1, lmA1]) {
      const r = await c.from("mandates_safe").select("id, commission_pct").eq("id", mandate);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([]);
    }
  });

  it("at aal2 the view is unchanged: the admin sees the commission, the listing manager sees it masked", async () => {
    const asAdmin = await adminA.client.from("mandates_safe").select("id, commission_pct").eq("id", mandate);
    const asLm = await lmA.client.from("mandates_safe").select("id, commission_pct").eq("id", mandate);
    expect(asAdmin.data).toEqual([{ id: mandate, commission_pct: 2.5 }]);
    expect(asLm.data).toEqual([{ id: mandate, commission_pct: null }]);
  });

  it("org_mfa_status tells an aal1 admin nothing, and an aal2 admin every colleague", async () => {
    const aal1 = await adminA1.rpc("org_mfa_status");
    expect(aal1.error).toBeNull();
    expect(aal1.data).toEqual([]);
    const aal2 = await adminA.client.rpc("org_mfa_status");
    expect(aal2.error).toBeNull();
    expect((aal2.data as { profile_id: string }[]).map((r) => r.profile_id).sort()).toEqual(
      [adminA.id, lmA.id, agentA.id].sort(),
    );
  });
});

/**
 * The catalogue: the NEXT definer function or view must not arrive without
 * the check. Every SECURITY DEFINER function in `public` that `authenticated`
 * may execute, and every view without `security_invoker` it may select, must
 * call `mfa_satisfied()` (comments stripped — a comment is not a check) or be
 * listed here with the reason it need not.
 */
const EXEMPT_FUNCTIONS: Record<string, string> = {
  "current_org_id()": "identity helper every policy calls; returns only the caller's own organisation",
  "current_role_gnk()": "identity helper every policy calls; returns only the caller's own role",
  "mfa_satisfied()": "the check itself",
  "rls_bare_auth_calls()": "catalogue lint (0032 / 0100): policy names only, granted to authenticated on purpose and pinned by verify-restore",
  "note_portal_pull(p_token_sha256 text, p_ua text, p_count integer)": "anon surface: portal feed telemetry (0100 / verify-restore anon=true)",
  "note_public_listing_hit(p_ip_hash text, p_limit integer)": "anon surface: public listing rate limit",
  "note_share_link_miss(p_ip_hash text, p_limit integer)": "anon surface: share-link rate limit",
  "portal_connection_by_token(p_portal text, p_token_sha256 text)": "anon surface: the portal feed, authorised by its token",
  "portal_supplement(p_token_sha256 text)": "anon surface: the portal feed, authorised by its token",
  "public_listings(p_org_slug text, p_limit integer, p_offset integer, p_reference text)": "anon surface: the public listing feed",
  "public_listings_etag(p_org_slug text)": "anon surface: the public listing feed",
  "resolve_share_link(p_token_sha256 text)": "anon surface: a share link, authorised by its token",
  "share_link_over_budget(p_ip_hash text, p_limit integer)": "anon surface: share-link rate limit",
  "st_estimatedextent(text, text)": "PostGIS-owned; revoke is a no-op (0100)",
  "st_estimatedextent(text, text, text)": "PostGIS-owned; revoke is a no-op (0100)",
  "st_estimatedextent(text, text, text, boolean)": "PostGIS-owned; revoke is a no-op (0100)",
};
const EXEMPT_VIEWS: Record<string, string> = {
  geography_columns: "PostGIS catalogue view",
  geometry_columns: "PostGIS catalogue view",
};

describe("every definer surface a signed-in session reaches checks the second factor", () => {
  it("functions", async () => {
    const { rows } = await pg.query<{ sig: string; checks: boolean }>(
      `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
              regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') ~ 'mfa_satisfied\\s*\\(' as checks
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.prosecdef
          and p.prokind = 'f'
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`,
    );
    const unguarded = rows.filter((r) => !r.checks && !(r.sig in EXEMPT_FUNCTIONS)).map((r) => r.sig);
    expect(unguarded, "a definer function authenticated can call skips mfa_satisfied()").toEqual([]);
    const stale = Object.keys(EXEMPT_FUNCTIONS).filter((sig) => !rows.some((r) => r.sig === sig));
    expect(stale, "an exemption names a function that no longer exists or is no longer reachable").toEqual([]);
  });

  it("views", async () => {
    const { rows } = await pg.query<{ name: string; checks: boolean }>(
      `select c.relname as name, pg_get_viewdef(c.oid) ~ 'mfa_satisfied\\(' as checks
         from pg_class c
        where c.relnamespace = 'public'::regnamespace
          and c.relkind in ('v', 'm')
          and not coalesce(array_to_string(c.reloptions, ',') ~ 'security_invoker=(true|on)', false)
          and has_table_privilege('authenticated', c.oid, 'select')
        order by 1`,
    );
    const unguarded = rows.filter((r) => !r.checks && !(r.name in EXEMPT_VIEWS)).map((r) => r.name);
    expect(unguarded, "a definer view authenticated can read skips mfa_satisfied()").toEqual([]);
    const stale = Object.keys(EXEMPT_VIEWS).filter((v) => !rows.some((r) => r.name === v));
    expect(stale).toEqual([]);
  });
});
