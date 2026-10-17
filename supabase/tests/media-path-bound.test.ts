import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Client } from "pg";
import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import {
  ANON_KEY,
  SERVICE_ROLE_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";
import { CHECK_0148, REVERT_0148_SQL, readMigration0148 } from "./revert-0148";

/**
 * 0148 + T-media-path-bound: a property_media row names only objects under its
 * own property, and the two service-role readers of those names — the photo
 * delete (deleteMediaBulk) and the property page's signer — trust nothing
 * else (audit 2026-10-17 MEDIA-1, RLS-3).
 *
 *   1. a session's own writes through PostgREST — INSERT, PATCH, a batch, a
 *      move to another listing — naming another record's object (a signed
 *      mandate), another listing's prefix, a '..' path, an encoded or
 *      backslashed '..', or no prefix at all, in any of the five columns:
 *      refused by the CHECK (23514 naming it) for an admin, a listing manager
 *      and the assigned agent (who may insert, not update), nothing written;
 *   2. privileged writers — service_role, postgres, a restore's load — are
 *      bound by the same CHECK;
 *   3. what every writer produces stays valid; characters outside the set
 *      are refused;
 *   4. the readers, through the REAL action and the REAL page against the
 *      real stack (PostgREST, RLS, Storage, the events chain):
 *      - MEDIA-1 as found: a listing manager aims a photo's original at a
 *        signed mandate and deletes the photo — the mandate survives;
 *      - a row written before 0148 (planted with the CHECK lifted) naming
 *        foreign objects: the delete removes only its own;
 *      - two rows of one listing naming one object: deleting one keeps the
 *        object the other still shows;
 *      - the survivors cannot be read: nothing is removed, and it is reported;
 *      - the page signs only its own listing's floor plans: a row naming a
 *        KYC scan, raw or behind an encoded or backslashed '..', gets no URL —
 *        and the platform behaviour that makes the character rule necessary;
 *   5. the migration: its shape, the one-transaction guard, replay over the
 *      state before it, the preflight refusing stored rows (ids only, no
 *      path, no partial DDL) and the header's query listing exactly them, a
 *      bounded lock wait, replay safety, postflight mutants, the rollback, the
 *      restore pack's row.
 *
 * At 0147 with the unchanged code this file is RED where the defect lives:
 * every refused write in sections 1 and 2 was accepted, section 4's foreign
 * objects were removed or signed, and section 5's restore-pack row did not
 * exist; the controls and section 3's valid shapes passed. A THROWAWAY
 * ORGANISATION, deleted at the end as postgres, objects and events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const COLUMNS = ["storage_path_original", "path_thumb", "path_card", "path_full", "path_jpeg"] as const;
type Column = (typeof COLUMNS)[number];

// ---------------------------------------------------------------------------
// Harness: which session the action and the page get; steerable session
// fetches; the service role's storage traffic, bodies included.
// ---------------------------------------------------------------------------
const h = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    als: new AsyncLocalStorage<unknown>(),
    /** every storage DELETE the service role sent: the bucket and the names in its body */
    removals: [] as { bucket: string; names: string[] }[],
    sentry: [] as string[],
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound()");
  },
  redirect: (to: string) => {
    throw new Error(`redirect(${to})`);
  },
}));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (m: string) => void h.sentry.push(m),
  captureException: () => {},
}));
vi.mock("@/lib/services/site-revalidate", () => ({ notifySiteIfPublic: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = h.als.getStore();
    if (!c) throw new Error("test harness: no session bound");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const helpers = await import("./helpers");
  const { createClient: make } = await import("@supabase/supabase-js");
  return {
    createAdminClient: () =>
      make(helpers.SUPABASE_URL, helpers.SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const method = (init?.method ?? "GET").toUpperCase();
            const m = /\/storage\/v1\/object\/([^/?]+)\/?$/.exec(url);
            if (method === "DELETE" && m && typeof init?.body === "string") {
              h.removals.push({ bucket: m[1]!, names: (JSON.parse(init.body) as { prefixes: string[] }).prefixes });
            }
            return fetch(input, init);
          },
        },
      }),
  };
});

import { deleteMediaBulk } from "@/lib/actions/media";
import PropertyDetailPage from "@/app/(app)/properties/[id]/page";
import { MediaTab } from "@/components/features/properties/media-tab";
import { isOwnMediaPath } from "@/lib/services/media-path";

type Step = "pass" | "fail500" | "hollow";
let sessionRule: ((method: string, url: string) => Step) | null = null;

async function sessionOf(user: TestUser): Promise<SupabaseClient> {
  const { data } = await user.client.auth.getSession();
  if (!data.session) throw new Error(`no session for ${user.email}`);
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const step = sessionRule?.((init?.method ?? "GET").toUpperCase(), decodeURIComponent(url)) ?? "pass";
        if (step === "fail500") {
          return new Response(JSON.stringify({ code: "XX000", message: "injected failure", details: null, hint: null }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        if (step === "hollow") return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
        return fetch(input, init);
      },
    },
  });
  const { error } = await c.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  return c;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let o: Client; // postgres: fixtures, observation, the migration replays, cleanup
let a: Client; // a second session holding a lock
let svc: SupabaseClient;
let admin: TestUser, manager: TestUser, agent: TestUser;
const userIds: string[] = [];
let P1: string; // assigned to `agent`
let P2: string; // another listing of the same organisation
const propertyIds: string[] = [];

/** Another record's object: a signed mandate PDF and a retained KYC scan (documents bucket). */
const MANDATE = `${ORG}/mandates/${RUN}-signed-mandate.pdf`;
const KYC = `${ORG}/contacts/${RUN}/passport-scan.pdf`;
const MANDATE_BYTES = `%PDF-1.4 signed mandate ${RUN}`;
const KYC_BYTES = `%PDF-1.4 passport scan ${RUN}`;
/** Another listing's live photograph (media bucket); set once P2 exists. */
let P2_PHOTO = "";

type PgError = Error & { code?: string; constraint?: string };
type Write = { error: PostgrestError | null; data?: unknown };

function refused(res: Write, label: string) {
  expect(res.error, `${label}: must be refused by ${CHECK_0148}; it was accepted`).not.toBeNull();
  expect(res.error!.code, res.error!.message).toBe("23514");
  expect(res.error!.message).toContain(`"${CHECK_0148}"`);
}
async function pgRefused(q: Promise<unknown>, label: string) {
  const e = await q.then(
    () => null,
    (err: PgError) => err,
  );
  expect(e, `${label}: must be refused by ${CHECK_0148}; it was accepted`).not.toBeNull();
  expect(e!.code, e!.message).toBe("23514");
  expect(e!.constraint).toBe(CHECK_0148);
}

async function newProperty(assignee: string | null): Promise<string> {
  const ref = `MP${TAG}${Math.floor(Math.random() * 1e6)}`.slice(0, 20);
  const { rows } = await o.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type, assigned_agent_id) values ($1, $2, 'apartment', $3) returning id",
    [ORG, ref, assignee],
  );
  propertyIds.push(rows[0]!.id);
  return rows[0]!.id;
}

/** The five names the upload action gives one attempt of listing `p`. */
function ownPaths(p: string, id = randomUUID()): Record<Column, string> {
  return {
    storage_path_original: `properties/${p}/original/${id}.jpg`,
    path_thumb: `properties/${p}/${id}_thumb.webp`,
    path_card: `properties/${p}/${id}_card.webp`,
    path_full: `properties/${p}/${id}_full.webp`,
    path_jpeg: `properties/${p}/${id}_jpeg.jpg`,
  };
}

/** Names a row of listing `p` must never hold. */
function foreignPaths(p: string): [string, string][] {
  return [
    ["another record's object (a signed mandate)", MANDATE],
    ["another listing's prefix", P2_PHOTO],
    ["a '..' path", `properties/${p}/../../${MANDATE}`],
    ["an encoded '..' (%2e%2e)", `properties/${p}/%2e%2e/%2e%2e/${MANDATE}`],
    ["an encoded '..' (.%2E)", `properties/${p}/.%2E/.%2E/${MANDATE}`],
    ["a backslashed '..'", `properties/${p}/..\\..\\${MANDATE}`],
    ["no property prefix (the old fixtures' shape)", `t/${RUN}_full.webp`],
  ];
}

async function insertRow(p: string, cols: Partial<Record<Column, string | null>>, kind = "photo", sort = 0): Promise<string> {
  const { rows } = await o.query<{ id: string }>(
    `insert into property_media (org_id, property_id, kind, storage_path_original, path_thumb, path_card, path_full, path_jpeg, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [ORG, p, kind, cols.storage_path_original ?? null, cols.path_thumb ?? null, cols.path_card ?? null, cols.path_full ?? null, cols.path_jpeg ?? null, sort],
  );
  return rows[0]!.id;
}
async function rowOf(id: string) {
  return (await o.query("select * from property_media where id = $1", [id])).rows[0] as Record<string, unknown> | undefined;
}
async function put(bucket: "media" | "documents", name: string, body: string, type = "application/octet-stream") {
  const { error } = await svc.storage.from(bucket).upload(name, new Blob([Buffer.from(body)], { type }), { upsert: true, contentType: type });
  if (error) throw new Error(`upload ${bucket}/${name}: ${error.message}`);
}
async function exists(bucket: string, name: string): Promise<boolean> {
  const { rows } = await o.query("select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, name]);
  return rows.length === 1;
}
async function checkIsLive(): Promise<string | null> {
  const { rows } = await o.query<{ def: string }>(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.property_media'::regclass and conname = $1",
    [CHECK_0148],
  );
  return rows[0]?.def ?? null;
}

/**
 * Rows WRITTEN BEFORE 0148: the CHECK is lifted, the rows are planted as
 * postgres, and the CHECK comes back NOT VALID — the state between 0148's ADD
 * and its VALIDATE, which binds every new write while the planted rows stand.
 * In `finally` the planted rows go and the CHECK is validated again. At 0147
 * (no CHECK) the rows are simply planted. Test files run one at a time
 * (vitest.rls.config.mts), so nothing else writes meanwhile.
 */
async function withLegacyRows<T>(plant: () => Promise<string[]>, body: (ids: string[]) => Promise<T>): Promise<T> {
  const def = await checkIsLive();
  if (def) await o.query(`alter table property_media drop constraint ${CHECK_0148}`);
  let ids: string[] = [];
  try {
    ids = await plant();
    if (def) await o.query(`alter table property_media add constraint ${CHECK_0148} ${def} not valid`);
    return await body(ids);
  } finally {
    await o.query("delete from property_media where id = any($1::uuid[])", [ids]);
    if (def) {
      if (!(await checkIsLive())) await o.query(`alter table property_media add constraint ${CHECK_0148} ${def} not valid`);
      await o.query(`alter table property_media validate constraint ${CHECK_0148}`);
    }
  }
}

async function act(user: TestUser, propertyId: string, ids: string[]) {
  const client = await sessionOf(user);
  try {
    return { result: await h.als.run(client, () => deleteMediaBulk(propertyId, ids)), thrown: null as string | null };
  } catch (e) {
    return { result: null, thrown: e instanceof Error ? e.message : String(e) };
  }
}

type Element = ReactElement<Record<string, unknown>>;
function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  yield* walk(el.props.children);
}
/** The media items the property page hands its Media tab, as `user` sees the page. */
async function pageMedia(user: TestUser, id: string) {
  const client = await sessionOf(user);
  const root = (await h.als.run(client, () =>
    PropertyDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
  )) as ReactNode;
  const tab = [...walk(root)].find((e) => e.type === MediaTab);
  if (!tab) throw new Error("the page rendered no Media tab");
  return tab.props.items as { id: string; path_card: string | null; card_url: string | null }[];
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  a = new Client({ connectionString: DB_URL });
  await Promise.all([o.connect(), a.connect()]);
  // the property page builds a service-role client too (createAdminClient — mocked above, on these)
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= SERVICE_ROLE_KEY;
  await ensureTestOrg(svc, ORG, `Media paths ${RUN}`, `media-paths-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `mp-admin-${RUN}@test.local`, "admin", ORG);
  manager = await createTestUser(svc, `mp-lm-${RUN}@test.local`, "listing_manager", ORG);
  agent = await createTestUser(svc, `mp-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(admin.id, manager.id, agent.id);
  P1 = await newProperty(agent.id);
  P2 = await newProperty(null);
  P2_PHOTO = `properties/${P2}/${RUN}_card.webp`;
  await put("documents", MANDATE, MANDATE_BYTES, "application/pdf");
  await put("documents", KYC, KYC_BYTES, "application/pdf");
  await put("media", P2_PHOTO, `webp ${RUN}`, "image/webp");
}, 180_000);

afterEach(async () => {
  sessionRule = null;
  h.removals = [];
  h.sentry = [];
  await a.query("rollback").catch(() => undefined);
});

afterAll(async () => {
  if (!o) return;
  await o.query("rollback").catch(() => undefined);
  // storage refuses SQL deletes: list as postgres, remove through the API
  const { rows: leftover } = await o.query<{ bucket_id: string; name: string }>(
    "select bucket_id, name from storage.objects where name like $1 or name like any ($2::text[])",
    [`${ORG}/%`, propertyIds.map((p) => `properties/${p}/%`)],
  );
  for (const bucket of ["media", "documents"]) {
    const names = leftover.filter((x) => x.bucket_id === bucket).map((x) => x.name);
    if (names.length) await svc.storage.from(bucket).remove(names);
  }
  await o.query("delete from property_media where org_id = $1", [ORG]);
  await o.query("delete from properties where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await o.query("delete from profiles where org_id = $1", [ORG]);
  await o.query("delete from events where org_id = $1", [ORG]);
  await o.query("delete from events_chain_checkpoint where org_id = $1", [ORG]);
  await o.query("delete from chain_checks where org_id = $1", [ORG]);
  await o.query("delete from deal_stages where org_id = $1", [ORG]);
  await o.query("delete from districts where org_id = $1", [ORG]);
  await o.query("delete from organizations where id = $1", [ORG]);
  await Promise.all([o.end(), a.end()]);
}, 120_000);

// ---------------------------------------------------------------------------
describe("1. a session's own writes through PostgREST", () => {
  const roles = () =>
    [
      ["admin", admin],
      ["listing manager", manager],
      ["assigned agent", agent],
    ] as [string, TestUser][];

  it("controls: an admin, a listing manager and the assigned agent may INSERT a row naming its own listing's objects, in all five columns", async () => {
    for (const [who, user] of roles()) {
      const paths = ownPaths(P1);
      const res = await user.client
        .from("property_media")
        .insert({ org_id: ORG, property_id: P1, kind: "photo", ...paths })
        .select("id")
        .single();
      expect(res.error, `${who}: ${res.error?.message}`).toBeNull();
      expect(await rowOf((res.data as { id: string }).id)).toMatchObject(paths);
    }
  });

  it("an INSERT naming any foreign object, in any of the five columns, is refused for all three roles — nothing written", async () => {
    for (const [who, user] of roles()) {
      for (const [label, path] of foreignPaths(P1)) {
        for (const col of COLUMNS) {
          const id = randomUUID();
          const res = await user.client.from("property_media").insert({ id, org_id: ORG, property_id: P1, kind: "photo", [col]: path });
          refused(res, `${who} INSERT ${col} = ${label}`);
          expect(await rowOf(id)).toBeUndefined();
        }
      }
    }
  });

  it("a PATCH by an admin or a listing manager aiming any column at a foreign object is refused — the row unchanged", async () => {
    for (const [who, user] of [["admin", admin], ["listing manager", manager]] as [string, TestUser][]) {
      const paths = ownPaths(P1);
      const id = await insertRow(P1, paths);
      for (const [label, path] of foreignPaths(P1)) {
        for (const col of COLUMNS) {
          const res = await user.client.from("property_media").update({ [col]: path }).eq("id", id).select("id");
          refused(res, `${who} PATCH ${col} = ${label}`);
        }
      }
      expect(await rowOf(id)).toMatchObject(paths);
    }
  });

  it("the assigned agent cannot PATCH at all — RLS (no UPDATE policy for an agent) answers 0 rows, which is not the CHECK's refusal", async () => {
    const paths = ownPaths(P1);
    const id = await insertRow(P1, paths);
    const res = await agent.client.from("property_media").update({ storage_path_original: MANDATE }).eq("id", id).select("id");
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
    expect(await rowOf(id)).toMatchObject(paths);
  });

  it("a row cannot be moved to another listing with its old paths; moved with the new listing's paths, it can", async () => {
    const paths = ownPaths(P1);
    const id = await insertRow(P1, paths);
    refused(await manager.client.from("property_media").update({ property_id: P2 }).eq("id", id).select("id"), "move with P1's paths");
    expect(await rowOf(id)).toMatchObject({ property_id: P1, ...paths });
    const moved = ownPaths(P2);
    const ok = await manager.client.from("property_media").update({ property_id: P2, ...moved }).eq("id", id).select("id");
    expect(ok.error, ok.error?.message).toBeNull();
    expect(await rowOf(id)).toMatchObject({ property_id: P2, ...moved });
  });

  it("a batch with one foreign path is refused whole: the valid row beside it is not written either", async () => {
    const good = randomUUID();
    const bad = randomUUID();
    const res = await admin.client.from("property_media").insert([
      { id: good, org_id: ORG, property_id: P1, kind: "photo", ...ownPaths(P1) },
      { id: bad, org_id: ORG, property_id: P1, kind: "photo", ...ownPaths(P1), path_full: MANDATE },
    ]);
    refused(res, "batch");
    expect(await rowOf(good)).toBeUndefined();
    expect(await rowOf(bad)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("2. privileged writers are bound by the same CHECK", () => {
  it("service_role (the importer's and the application's admin client): INSERT and PATCH of each column", async () => {
    const id = await insertRow(P1, ownPaths(P1));
    for (const col of COLUMNS) {
      refused(await svc.from("property_media").insert({ org_id: ORG, property_id: P1, kind: "photo", [col]: MANDATE }), `service_role INSERT ${col}`);
      refused(await svc.from("property_media").update({ [col]: P2_PHOTO }).eq("id", id), `service_role PATCH ${col}`);
    }
  });

  it("postgres: a direct INSERT and UPDATE of each column", async () => {
    const id = await insertRow(P1, ownPaths(P1));
    for (const col of COLUMNS) {
      await pgRefused(insertRow(P1, { [col]: KYC }), `postgres INSERT ${col}`);
      await pgRefused(o.query(`update property_media set ${col} = $2 where id = $1`, [id, `properties/${P1}/%2e%2e/${KYC}`]), `postgres UPDATE ${col}`);
    }
  });

  it("a restore's data load, under session_replication_role = replica (no trigger fires), is refused too", async () => {
    await o.query("begin");
    try {
      await o.query("set local session_replication_role = replica");
      await pgRefused(insertRow(P1, { path_card: MANDATE }), "replica INSERT");
    } finally {
      await o.query("rollback");
    }
  });
});

// ---------------------------------------------------------------------------
describe("3. what every writer produces stays valid; anything else is refused", () => {
  it("the upload action's and importer's names (every original extension), backfill-jpeg's derived name, and a row with no path at all", async () => {
    const id = randomUUID();
    for (const ext of ["jpg", "png", "webp"]) {
      await insertRow(P1, { ...ownPaths(P1, id), storage_path_original: `properties/${P1}/original/${id}.${ext}` });
    }
    // scripts/media/backfill-jpeg.mts: path_full with `_full.webp` -> `_jpeg.jpg`
    const full = `properties/${P1}/${id}_full.webp`;
    await insertRow(P1, { path_full: full, path_jpeg: full.replace(/_full\.webp$/, "_jpeg.jpg") });
    // a video / virtual-tour link names no object
    const { rows } = await o.query<{ id: string }>(
      "insert into property_media (org_id, property_id, kind, external_url) values ($1, $2, 'video', 'https://example.test/v') returning id",
      [ORG, P1],
    );
    expect(rows).toHaveLength(1);
  });

  it("characters outside letters, digits, '.', '_', '-' and '/' are refused, and so is the bare prefix", async () => {
    for (const tail of [
      "a b.webp",
      "a%20b.webp",
      "café.webp",
      "ａ.webp", // FULLWIDTH LATIN SMALL LETTER A
      "a?b.webp",
      "a#b.webp",
      "a\\b.webp",
      "a\nb.webp",
      "",
    ]) {
      await pgRefused(insertRow(P1, { path_thumb: `properties/${P1}/${tail}` }), JSON.stringify(tail));
    }
    // and the prefix must be THIS listing's, spelt as stored (lower case)
    await pgRefused(insertRow(P1, { path_thumb: `properties/${P1.toUpperCase()}/x_thumb.webp` }), "upper-case prefix");
    await pgRefused(insertRow(P1, { path_thumb: `properties/${P1}x/x_thumb.webp` }), "a longer segment");
  });

  it("the application's copy of the rule (isOwnMediaPath) agrees with the INSTALLED CHECK on every path above", async () => {
    const cases = [
      ...Object.values(ownPaths(P1)),
      ...foreignPaths(P1).map(([, p]) => p),
      `properties/${P1}/a b.webp`,
      `properties/${P1}/café.webp`,
      `properties/${P1}/`,
      `properties/${P1.toUpperCase()}/x_thumb.webp`,
      // inside the prefix whatever a URL parser makes of them
      `properties/${P1}/./x_thumb.webp`,
      `properties/${P1}//x_thumb.webp`,
      `properties/${P1}/x/`,
    ];
    for (const path of cases) {
      // the row as postgres, in a rolled-back transaction: what the constraint itself answers
      let accepted: boolean;
      await o.query("begin");
      try {
        await insertRow(P1, { path_thumb: path });
        accepted = true;
      } catch (e) {
        expect((e as PgError).constraint, `${path}: ${(e as Error).message}`).toBe(CHECK_0148);
        accepted = false;
      } finally {
        await o.query("rollback");
      }
      expect(isOwnMediaPath(P1, path), path).toBe(accepted);
    }
  });
});

// ---------------------------------------------------------------------------
describe("4. the readers: the photo delete (service role) and the page's signer", () => {
  it("MEDIA-1 as found: a listing manager aims a photo's original at a signed mandate and deletes the photo — the PATCH is refused and the mandate survives", async () => {
    const paths = ownPaths(P1);
    const id = await insertRow(P1, paths);
    await put("documents", paths.storage_path_original, "jpeg original");
    await put("media", paths.path_card, "webp card");

    const patch = await manager.client.from("property_media").update({ storage_path_original: MANDATE }).eq("id", id).select("id");
    const { result, thrown } = await act(manager, P1, [id]);
    expect(thrown).toBeNull();
    expect(result).toEqual({ error: null, deleted: 1 });
    // the consequence first, then the refusal that prevents it
    expect(await exists("documents", MANDATE), "the signed mandate's object").toBe(true);
    refused(patch, "LM PATCH");
    // control: the photo's own objects are still removed
    expect(await exists("documents", paths.storage_path_original)).toBe(false);
    expect(await exists("media", paths.path_card)).toBe(false);
  });

  it("a row written before 0148 naming foreign objects: the delete removes only its own, and never sends a foreign name", async () => {
    const own = ownPaths(P1);
    await put("media", own.path_thumb, "own thumb");
    await withLegacyRows(
      async () => [
        await insertRow(P1, {
          storage_path_original: MANDATE,
          path_thumb: own.path_thumb,
          path_card: P2_PHOTO,
          path_full: `properties/${P1}/%2e%2e/%2e%2e/${KYC}`,
          path_jpeg: `properties/${P1}/../../${KYC}`,
        }),
      ],
      async ([id]) => {
        const { result, thrown } = await act(admin, P1, [id!]);
        expect(thrown).toBeNull();
        expect(result).toEqual({ error: null, deleted: 1 });
        expect(await exists("documents", MANDATE), "the signed mandate").toBe(true);
        expect(await exists("media", P2_PHOTO), "another listing's photograph").toBe(true);
        expect(await exists("documents", KYC), "the KYC scan").toBe(true);
        expect(await exists("media", own.path_thumb), "the row's own thumbnail is removed").toBe(false);
        const sent = h.removals.flatMap((r) => r.names);
        expect(sent).toContain(own.path_thumb);
        for (const name of sent) expect(isOwnMediaPath(P1, name), `removal sent ${name}`).toBe(true);
      },
    );
  });

  it("two rows of one listing naming one object: deleting one keeps the object the other still shows", async () => {
    const A = ownPaths(P1);
    const B = ownPaths(P1);
    const idA = await insertRow(P1, A, "photo", 1);
    const idB = await insertRow(P1, B, "photo", 2);
    await put("media", A.path_card, "A's card");
    await put("media", B.path_thumb, "B's thumb");
    // own prefix, so the CHECK admits it: the case only the application can see
    const res = await manager.client.from("property_media").update({ path_card: A.path_card }).eq("id", idB).select("id");
    expect(res.error, res.error?.message).toBeNull();

    const { result } = await act(manager, P1, [idB]);
    expect(result).toEqual({ error: null, deleted: 1 });
    expect(await exists("media", A.path_card), "A's card, which A still shows").toBe(true);
    expect(await exists("media", B.path_thumb), "B's own thumbnail is removed").toBe(false);
    expect(await rowOf(idA)).toMatchObject(A);
  });

  it("a listing with more rows than PostgREST's 1,000-row cap: a survivor past the first page still keeps its object", async () => {
    const P3 = await newProperty(null);
    const shared = `properties/${P3}/${RUN}-shared_card.webp`;
    await put("media", shared, "shared card");
    // 1,000 other rows first, then the survivor with the largest id there is,
    // so it sorts last and arrives only on the second page
    await o.query(
      `insert into property_media (org_id, property_id, kind, path_thumb, sort_order)
       select $1, $2, 'photo', format('properties/%s/filler-%s_thumb.webp', $2::uuid, g), g from generate_series(1, 1000) g`,
      [ORG, P3],
    );
    await o.query(
      `insert into property_media (id, org_id, property_id, kind, path_card, sort_order)
       values ('ffffffff-ffff-4fff-bfff-ffffffffffff', $1, $2, 'photo', $3, 2000)`,
      [ORG, P3, shared],
    );
    const gone = await insertRow(P3, { path_card: shared }, "photo", 2001);
    try {
      const { result } = await act(manager, P3, [gone]);
      expect(result).toEqual({ error: null, deleted: 1 });
      expect(await exists("media", shared), "the object the 1,001st row still shows").toBe(true);
    } finally {
      await o.query("delete from property_media where property_id = $1", [P3]);
    }
  });

  for (const step of ["fail500", "hollow"] as const) {
    it(`the survivors cannot be read (${step}): no object is removed, the photo is still deleted with its event, and the failure is reported`, async () => {
      const paths = ownPaths(P1);
      const id = await insertRow(P1, paths);
      await put("media", paths.path_thumb, "thumb");
      await put("documents", paths.storage_path_original, "original");
      // the survivors read: the only GET of property_media naming the originals
      sessionRule = (method, url) =>
        method === "GET" && /\/rest\/v1\/property_media\?/.test(url) && url.includes("storage_path_original") ? step : "pass";

      const { result, thrown } = await act(admin, P1, [id]);
      expect(thrown).toBeNull();
      expect(result).toEqual({ error: null, deleted: 1 });
      expect(await rowOf(id)).toBeUndefined();
      expect(await exists("media", paths.path_thumb)).toBe(true);
      expect(await exists("documents", paths.storage_path_original)).toBe(true);
      expect(h.removals).toEqual([]);
      expect(h.sentry).toContain("[media delete] survivor read failed — no files removed");
      const { rows } = await o.query(
        "select payload from events where entity_id = $1 and event_type = 'media_deleted' and payload->>'media_id' = $2",
        [P1, id],
      );
      expect(rows).toHaveLength(1);
    });
  }

  it("the platform behaviour the character rule exists for: a URL parser reads %2e%2e as '..' and '\\' as '/', so such a path signs ANOTHER object", async () => {
    for (const p of [`properties/${P1}/%2e%2e/%2e%2e/${KYC}`, `properties/${P1}/.%2E/%2e./${KYC}`, `properties/${P1}/..\\..\\${KYC}`]) {
      const { data, error } = await svc.storage.from("documents").createSignedUrl(p, 60);
      expect(error, `${p}: ${error?.message}`).toBeNull();
      const res = await fetch(data!.signedUrl);
      expect(await res.text(), p).toBe(KYC_BYTES);
    }
  });

  it("the page signs only its own listing's floor plans: a row naming a KYC scan — raw, behind an encoded or a backslashed '..' — gets no URL", async () => {
    const ownCard = `properties/${P1}/${randomUUID()}_card.webp`;
    await put("documents", ownCard, "own floor plan card", "image/webp");
    const planted: Record<string, string> = {
      raw: KYC,
      encoded: `properties/${P1}/%2e%2e/%2e%2e/${KYC}`,
      backslashed: `properties/${P1}/..\\..\\${KYC}`,
    };
    // valid to the CHECK (own prefix), so planted the way it can be today: the
    // assigned agent's own INSERT of a floor plan whose card is a photograph's
    // EXIF original — never signed either
    const original = `properties/${P1}/original/${randomUUID()}.jpg`;
    await put("documents", original, "jpeg with exif", "image/jpeg");
    const viaAgent = await agent.client
      .from("property_media")
      .insert({ org_id: ORG, property_id: P1, kind: "floor_plan", path_card: original, sort_order: 20 })
      .select("id")
      .single();
    expect(viaAgent.error, viaAgent.error?.message).toBeNull();
    await withLegacyRows(
      async () => [
        await insertRow(P1, { path_card: ownCard }, "floor_plan", 10),
        ...(await Promise.all(Object.values(planted).map((p, i) => insertRow(P1, { path_card: p }, "floor_plan", 11 + i)))),
      ],
      async ([ownId, ...plantedIds]) => {
        // any member of the organisation can open the listing
        const items = await pageMedia(agent, P1);
        const byId = new Map(items.map((m) => [m.id, m]));
        for (const [i, id] of plantedIds.entries()) {
          expect(byId.get(id!)?.card_url, `${Object.keys(planted)[i]}: signed`).toBeNull();
        }
        expect(byId.get((viaAgent.data as { id: string }).id)?.card_url, "a photograph's original: signed").toBeNull();
        // control: the listing's own floor plan is signed, and serves its own bytes
        const own = byId.get(ownId!);
        expect(own?.card_url).toMatch(/\/storage\/v1\/object\/sign\/documents\//);
        expect(await (await fetch(own!.card_url!)).text()).toBe("own floor plan card");
      },
    );
  });
});

// ---------------------------------------------------------------------------
describe("5. the migration", () => {
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
  const validated = async () =>
    (
      await o.query<{ c: number }>(
        "select count(*)::int as c from pg_constraint where conrelid = 'public.property_media'::regclass and conname = $1 and contype = 'c' and convalidated",
        [CHECK_0148],
      )
    ).rows[0]!.c;

  it("replays over the state before it: preflight and postflight pass, one validated CHECK, the diagnostic as its last row", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0148_SQL);
      expect(await validated()).toBe(0);
      const row = lastRow(await o.query(readMigration0148()));
      expect(Object.keys(row)).toEqual(["migration", "property_media_checked"]);
      expect(row.migration).toBe("0148");
      expect(await validated()).toBe(1);
      expect(notices.some((m) => m.startsWith("0148: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0148: postflight passed"))).toBe(true);
    });
  });

  it("its shape: every abort precedes the first DDL, the lock precedes the count, NOT VALID is validated by the next statement, no row is written, no begin/commit", () => {
    const code = readMigration0148().replace(/--[^\n]*/g, "");
    const firstDdl = code.search(/\balter table\b/i);
    expect(firstDdl).toBeGreaterThan(0);
    const aborts = [...code.matchAll(/raise exception '0148 aborted/g)].map((m) => m.index!);
    expect(aborts).toHaveLength(3);
    for (const at of aborts) expect(at).toBeLessThan(firstDdl);
    const lock = code.indexOf("lock table public.property_media in access exclusive mode;");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(code.indexOf("select count(*), string_agg(id::text"));
    expect(code).toMatch(/\) not valid;\s*alter table public\.property_media\s+validate constraint property_media_paths_own_property;/);
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(code).not.toMatch(/\b(delete\s+from|update\s+public\.|insert\s+into|truncate)\b/i);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0148();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/^0148 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("refuses stored rows naming another path, by id only (never a path); the header's query lists exactly them", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0148_SQL);
      // one per shape, in different columns, plus a row moved to another listing with its old paths
      const bad = [
        await insertRow(P1, { storage_path_original: MANDATE }),
        await insertRow(P1, { ...ownPaths(P1), path_card: P2_PHOTO }),
        await insertRow(P1, { path_jpeg: `properties/${P1}/%2e%2e/${KYC}` }),
        await insertRow(P2, ownPaths(P1)),
      ].sort();
      await insertRow(P1, ownPaths(P1)); // control: never listed

      // the header's read-only query (copied out of the file, comment markers stripped)
      const sql = readMigration0148();
      const header = sql.slice(sql.indexOf("--   select m.id, m.org_id"), sql.indexOf("--    order by m.id;") + "--    order by m.id;".length);
      const listed = (await o.query<{ id: string; org_id: string }>(header.replace(/^--/gm, ""))).rows;
      expect(listed.filter((r) => r.org_id === ORG).map((r) => r.id)).toEqual(bad);
      // a stack carrying another file's leftovers lists those too: the refusal names what the query lists
      const ids = listed.map((r) => r.id);

      await o.query("savepoint before_0148");
      const e = await failure(o.query(readMigration0148()));
      expect(e?.message).toBe(
        `0148 aborted: ${ids.length} property_media row(s) name a path outside properties/<their property>/ ` +
          `(ids${ids.length > 20 ? ", the first 20" : ""}: ${ids.slice(0, 20).join(", ")}) — nothing was changed. ` +
          "List them with the read-only query in this file's header, decide each one, then apply again",
      );
      for (const leaked of [MANDATE, KYC, P2_PHOTO, ORG, RUN]) expect(e!.message).not.toContain(leaked);
      await o.query("rollback to savepoint before_0148");
      expect(await validated()).toBe(0);
    });
  });

  it("over twenty such rows, it names the count and the first twenty ids", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0148_SQL);
      const { rows } = await o.query<{ id: string }>(
        `insert into property_media (org_id, property_id, kind, path_thumb)
         select $1, $2, 'photo', 't/' || g || '.jpg' from generate_series(1, 21) g returning id`,
        [ORG, P1],
      );
      const mine = rows.map((r) => r.id);
      await o.query("savepoint before_0148");
      const e = await failure(o.query(readMigration0148()));
      // another file's leftovers on this stack would be counted too: at least these 21
      const m = /^0148 aborted: (\d+) property_media row\(s\) name a path outside properties\/<their property>\/ \(ids, the first 20: ([^)]*)\)/.exec(
        e?.message ?? "",
      );
      expect(m, e?.message ?? "(it applied)").not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(21);
      const ids = m![2]!.split(", ");
      expect(ids).toHaveLength(20);
      expect([...ids].sort()).toEqual(ids); // in id order
      if (Number(m![1]) === 21) expect(ids).toEqual([...mine].sort().slice(0, 20));
      await o.query("rollback to savepoint before_0148");
    });
  });

  it("a write in flight makes it wait at most lock_timeout, then abort (55P03), changing nothing", async () => {
    const id = await insertRow(P1, ownPaths(P1));
    await a.query("begin");
    await a.query("update property_media set sort_order = sort_order where id = $1", [id]);
    try {
      await rolledBack(async () => {
        const t0 = Date.now();
        const e = await failure(o.query(readMigration0148()));
        const waited = Date.now() - t0;
        expect(e?.code, e?.message).toBe("55P03");
        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(15_000);
      });
    } finally {
      await a.query("rollback");
    }
  });

  it("is replay-safe: run twice in one transaction, one validated copy of the CHECK", async () => {
    await rolledBack(async () => {
      await o.query(readMigration0148());
      await o.query(readMigration0148());
      expect(await validated()).toBe(1);
    });
  });

  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "a CHECK without its path_jpeg arm",
      (s) =>
        s.replace(
          /\n    and \(path_jpeg is null\n          or \(starts_with\(path_jpeg, 'properties\/' \|\| property_id::text \|\| '\/'\)\n              and path_jpeg ~ '[^']+'\n              and strpos\(path_jpeg, '\.\.'\) = 0\)\)/,
          "",
        ),
      /^0148 postflight: property_media_paths_own_property is not the validated CHECK this file writes/,
    ],
    [
      "a CHECK without the character rule (the audit's drop-in)",
      (s) => s.replace("and path_card ~ '^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'\n", ""),
      /^0148 postflight: property_media_paths_own_property is not the validated CHECK this file writes/,
    ],
    [
      "a CHECK left NOT VALID",
      (s) => s.replace("alter table public.property_media\n  validate constraint property_media_paths_own_property;", ""),
      /^0148 postflight: property_media_paths_own_property is not the validated CHECK this file writes \(missing or NOT VALID\)/,
    ],
    [
      "a second CHECK on the table",
      (s) =>
        s.replace(
          "-- 2. Postflight",
          "alter table public.property_media add constraint property_media_extra check (sort_order > -1);\n-- 2. Postflight",
        ),
      /^0148 postflight: the CHECKs on property_media are property_media_content_sha256_check, property_media_extra, property_media_paths_own_property/,
    ],
    [
      "a property_id made optional (the CHECK would pass a row with none)",
      (s) => s.replace("-- 2. Postflight", "alter table public.property_media alter column property_id drop not null;\n-- 2. Postflight"),
      /^0148 postflight: property_media's path columns or property_id changed/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`the postflight refuses ${label}`, async () => {
      const sql = readMigration0148();
      const bad = mutate(sql);
      expect(bad, "the mutation installed").not.toBe(sql);
      await rolledBack(async () => {
        await o.query(REVERT_0148_SQL);
        await o.query("savepoint before_0148");
        const e = await failure(o.query(bad));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0148");
        expect(await validated()).toBe(0);
      });
    });
  }

  it("the rollback recipe leaves 0147's state: the CHECK gone, 0088's digest CHECK in place — and a foreign path accepted again", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0148_SQL);
      expect(await validated()).toBe(0);
      const { rows } = await o.query<{ c: number }>(
        "select count(*)::int as c from pg_constraint where conrelid = 'public.property_media'::regclass and conname = 'property_media_content_sha256_check' and convalidated",
      );
      expect(rows[0]!.c).toBe(1);
      const id = await insertRow(P1, { storage_path_original: MANDATE });
      expect(await rowOf(id)).toMatchObject({ storage_path_original: MANDATE });
    });
  });

  it("the restore pack's 0148 row passes now, and reads a dropped, NOT VALID or weakened CHECK as drift", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const start = "  select 'SECURITY: every property_media path is under its own property";
    const from = pack.indexOf(start);
    expect(from, "the pack carries the 0148 row").toBeGreaterThan(0);
    const row = `select * from (${pack.slice(from, pack.indexOf("\n  union all\n", from))}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now.actual).toBe(now.expected);
    const def = (await checkIsLive())!;
    await rolledBack(async () => {
      await o.query(`alter table property_media drop constraint ${CHECK_0148}`);
      expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
    });
    await rolledBack(async () => {
      await o.query(`alter table property_media drop constraint ${CHECK_0148}`);
      await o.query(`alter table property_media add constraint ${CHECK_0148} ${def} not valid`);
      expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
    });
    await rolledBack(async () => {
      await o.query(`alter table property_media drop constraint ${CHECK_0148}`);
      await o.query(`alter table property_media add constraint ${CHECK_0148} ${def.replace(/ AND \(strpos\(path_full, '\.\.'::text\) = 0\)/, "")}`);
      expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
    });
  });

  it("the chain verifies for the organisation after everything above", async () => {
    const { rows } = await o.query("select ok, reason from public.verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
