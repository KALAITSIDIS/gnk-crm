import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { FUNCTION_0152, REVERT_0152_SQL, TRIGGER_0152, readMigration0152 } from "./revert-0152";

/**
 * 0152 + F02: storage room has ONE value — the 'storage_room' key in
 * properties.features — and properties.has_storage is its mirror, derived by
 * the database on every write and kept only for the public feed's shape.
 *
 *   1. every writer gets the one value: postgres, the service role (the
 *      importer's position) and a signed-in session (the project → unit
 *      features sync's PATCH) — an INSERT with or without has_storage, an
 *      UPDATE of has_storage alone, an UPDATE of features alone; and the
 *      application's copy of the rule (hasStorageRoom) agrees with the
 *      INSTALLED trigger;
 *   2. the public feed (public_listings, as anon) says what the feature says;
 *   3. the Details save, through the REAL action against the real stack
 *      (PostgREST, RLS, the events chain), as an admin: ticking the Features
 *      box stores both, and the `updated` event records both moving; a stale
 *      form posting has_storage=on with no feature stores false, and posting
 *      it again writes nothing;
 *   4. the migration: replay over the state before it (NULLs backfilled,
 *      every other row untouched), its shape, the one-transaction guard, the
 *      conflict report (the preflight refuses rows whose two values disagree,
 *      by reference, overwrites nothing, and the header's query lists exactly
 *      them), a bounded lock wait, replay safety, postflight mutants, the
 *      rollback, the restore pack's row.
 *
 * Without 0152 a has_storage written on its own is simply kept — the
 * rollback test in section 4 shows it on the state before the file, and the
 * conflict report plants exactly such rows. A THROWAWAY ORGANISATION,
 * deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `storage-room-${RUN}`;

// ---------------------------------------------------------------------------
// Harness: the action gets the session queued for it; nothing below the
// action is stubbed but the Next.js request plumbing.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/services/site-revalidate", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySiteAfter: vi.fn(),
  notifySiteIfPublic: vi.fn(async () => {}),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = state.queue.shift();
    if (!c) throw new Error("test harness: no client queued for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});

import { updatePropertySection } from "@/lib/actions/properties";
import { STORAGE_FEATURE, hasStorageRoom } from "@/lib/constants/features";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let o: Client; // postgres: fixtures, observation, the migration replays, cleanup
let a: Client; // a second session holding a lock
let svc: SupabaseClient;
let admin: TestUser;
const userIds: string[] = [];

type PgError = Error & { code?: string };
type Pair = { has_storage: boolean | null; features: (string | null)[] };

let seq = 0;
/** A reference of letters and digits only, so JavaScript and Postgres sort it alike. */
const ref = (kind = "S") => `ST${TAG}${kind}${String(++seq).padStart(3, "0")}`;

/** A property of ORG as postgres; `has_storage` omitted means the column is not named at all. */
async function insertProperty(cols: {
  features?: (string | null)[];
  has_storage?: boolean | null;
  visibility?: string;
  status?: string;
  updated_at?: string;
  reference?: string;
}): Promise<{ id: string; reference: string }> {
  const reference = cols.reference ?? ref();
  const names = ["org_id", "reference", "property_type", "features"];
  const values: unknown[] = [ORG, reference, "apartment", cols.features ?? []];
  for (const k of ["has_storage", "visibility", "status", "updated_at"] as const) {
    if (k in cols) {
      names.push(k);
      values.push(cols[k]);
    }
  }
  const { rows } = await o.query<{ id: string }>(
    `insert into properties (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    values,
  );
  return { id: rows[0]!.id, reference };
}
async function pairOf(id: string): Promise<Pair & { updated_at: string }> {
  const { rows } = await o.query("select has_storage, features, updated_at::text from properties where id = $1", [id]);
  return rows[0] as Pair & { updated_at: string };
}
const failure = (q: Promise<unknown>) =>
  q.then(
    () => null,
    (e: PgError) => e,
  );

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  a = new Client({ connectionString: DB_URL });
  await Promise.all([o.connect(), a.connect()]);
  await ensureTestOrg(svc, ORG, `Storage room ${RUN}`, SLUG);
  admin = await createTestUser(svc, `st-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
}, 300_000);

afterEach(async () => {
  state.queue = [];
  await a.query("rollback").catch(() => undefined);
});

afterAll(async () => {
  if (!o) return;
  await o.query("rollback").catch(() => undefined);
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

/** Every features list section 1 writes — no NULL element, so the app's rule can be asked too. */
const LISTS: string[][] = [[], ["storage_room"], ["sea_view", "storage_room", "garden"], ["sea_view"], ["storage"]];

// ---------------------------------------------------------------------------
// 1. every writer
// ---------------------------------------------------------------------------
describe("1. every writer gets the one value", () => {
  it("postgres INSERT: has_storage is the feature's, whatever was sent — and a row that names no has_storage stores the derived value, never NULL", async () => {
    const cases: [string, Parameters<typeof insertProperty>[0], boolean][] = [
      ["feature, has_storage false", { features: ["storage_room"], has_storage: false }, true],
      ["no feature, has_storage true", { features: [], has_storage: true }, false],
      ["feature among others, has_storage not named (the importer / wizard shape)", { features: ["sea_view", "storage_room"] }, true],
      ["no feature, has_storage not named", { features: ["garden"] }, false],
      ["feature, has_storage NULL", { features: ["storage_room"], has_storage: null }, true],
      ["a NULL element and no feature (= any is NULL there)", { features: [null, "garden"], has_storage: true }, false],
      ["a NULL element beside the feature", { features: [null, "storage_room"], has_storage: false }, true],
    ];
    for (const [label, cols, want] of cases) {
      const { id } = await insertProperty(cols);
      expect((await pairOf(id)).has_storage, label).toBe(want);
    }
  });

  it("postgres UPDATE: has_storage written on its own is replaced; a features change carries it along; a write naming neither leaves the pair in step", async () => {
    const { id } = await insertProperty({ features: [] });
    await o.query("update properties set has_storage = true where id = $1", [id]);
    expect(await pairOf(id)).toMatchObject({ has_storage: false, features: [] });
    await o.query("update properties set features = array['storage_room'] where id = $1", [id]);
    expect(await pairOf(id)).toMatchObject({ has_storage: true, features: ["storage_room"] });
    await o.query("update properties set has_storage = false where id = $1", [id]);
    expect(await pairOf(id)).toMatchObject({ has_storage: true });
    await o.query("update properties set has_storage = null where id = $1", [id]);
    expect((await pairOf(id)).has_storage, "never NULL again").toBe(true);
    await o.query("update properties set features = array_remove(features, 'storage_room'), has_storage = true where id = $1", [id]);
    expect(await pairOf(id)).toMatchObject({ has_storage: false, features: [] });
    await o.query("update properties set bedrooms = 3 where id = $1", [id]);
    expect(await pairOf(id)).toMatchObject({ has_storage: false, features: [] });
  });

  it("the service role through PostgREST (the importer's position): an INSERT without has_storage, a PATCH of has_storage alone", async () => {
    const reference = ref("I");
    const { data: inserted, error } = await svc
      .from("properties")
      .insert({ org_id: ORG, reference, property_type: "apartment", features: ["storage_room"] })
      .select("id, has_storage")
      .single();
    expect(error).toBeNull();
    expect(inserted!.has_storage).toBe(true);
    const { data: patched, error: patchErr } = await svc
      .from("properties")
      .update({ has_storage: false })
      .eq("id", inserted!.id)
      .select("has_storage, features");
    expect(patchErr).toBeNull();
    expect(patched).toEqual([{ has_storage: true, features: ["storage_room"] }]);
  });

  it("a signed-in session through PostgREST: the project → unit sync's PATCH of features alone, and a PATCH of has_storage alone", async () => {
    const { id } = await insertProperty({ features: ["sea_view"] });
    const session = admin.client;
    const { data: synced, error } = await session
      .from("properties")
      .update({ features: ["sea_view", "storage_room"] })
      .eq("id", id)
      .select("has_storage");
    expect(error).toBeNull();
    expect(synced).toEqual([{ has_storage: true }]);
    const { data: alone, error: aloneErr } = await session
      .from("properties")
      .update({ has_storage: false })
      .eq("id", id)
      .select("has_storage, features");
    expect(aloneErr).toBeNull();
    expect(alone).toEqual([{ has_storage: true, features: ["sea_view", "storage_room"] }]);
  });

  it("the application's copy of the rule (hasStorageRoom) agrees with the INSTALLED trigger on every list", async () => {
    expect(STORAGE_FEATURE).toBe("storage_room");
    for (const features of LISTS) {
      const { id } = await insertProperty({ features, has_storage: !hasStorageRoom(features) });
      expect((await pairOf(id)).has_storage, JSON.stringify(features)).toBe(hasStorageRoom(features));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. the public feed
// ---------------------------------------------------------------------------
describe("2. the public feed says what the feature says", () => {
  it("public_listings (as anon) returns has_storage equal to the feature, both ways", async () => {
    const anon = anonClient();
    const { id, reference } = await insertProperty({
      features: ["storage_room"],
      has_storage: false,
      visibility: "public",
      status: "available",
    });
    const read = async () => {
      const { data, error } = await anon.rpc("public_listings", { p_org_slug: SLUG, p_limit: 1, p_offset: 0, p_reference: reference });
      expect(error).toBeNull();
      expect(data, "the listing is on the feed").toHaveLength(1);
      return data![0] as { has_storage: boolean | null; features: string[] };
    };
    expect(await read()).toMatchObject({ has_storage: true, features: ["storage_room"] });
    await o.query("update properties set features = '{}', has_storage = true where id = $1", [id]);
    expect(await read()).toMatchObject({ has_storage: false, features: [] });
  });
});

// ---------------------------------------------------------------------------
// 3. the Details save, through the real action
// ---------------------------------------------------------------------------
describe("3. the Details save (the real action, as an admin)", () => {
  async function save(id: string, extra: Record<string, string | string[]>) {
    // the row's updated_at exactly as the page renders it (PostgREST's spelling)
    const { data: rendered, error } = await admin.client.from("properties").select("updated_at").eq("id", id).single();
    if (error) throw new Error(`read updated_at: ${error.message}`);
    const updated_at = rendered.updated_at as string;
    const fd = new FormData();
    const fields: Record<string, string | string[]> = {
      property_id: id,
      section: "details",
      expected_updated_at: updated_at,
      status: "available",
      visibility: "private",
      transaction_type: "sale",
      vat_status: "unknown",
      ...extra,
    };
    for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
    state.queue.push(admin.client);
    return updatePropertySection({ error: null, savedAt: null }, fd);
  }
  const updatedEvents = async (id: string) =>
    (
      await o.query<{ payload: { section: string; changed: Record<string, unknown> } }>(
        "select payload from events where org_id = $1 and entity_id = $2 and event_type = 'updated' order by id",
        [ORG, id],
      )
    ).rows.map((r) => r.payload);

  it("ticking the Features box stores the feature AND the mirror, and the `updated` event records both moving", async () => {
    const { id } = await insertProperty({ features: [], visibility: "private", status: "available" });
    const res = await save(id, { features: [STORAGE_FEATURE] });
    expect(res.error).toBeNull();
    expect(res.notice ?? null).toBeNull();
    expect(await pairOf(id)).toMatchObject({ has_storage: true, features: ["storage_room"] });
    const events = await updatedEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.section).toBe("details");
    expect(events[0]!.changed.features).toEqual({ from: [], to: ["storage_room"] });
    expect(events[0]!.changed.has_storage).toEqual({ from: false, to: true });
  });

  it("a stale form posting has_storage=on with no feature stores false — and posting it again writes nothing", async () => {
    const { id } = await insertProperty({ features: ["storage_room"], visibility: "private", status: "available" });
    const first = await save(id, { has_storage: "on" });
    expect(first.error).toBeNull();
    expect(await pairOf(id)).toMatchObject({ has_storage: false, features: [] });
    const events = await updatedEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.changed.features).toEqual({ from: ["storage_room"], to: [] });
    expect(events[0]!.changed.has_storage).toEqual({ from: true, to: false });

    const again = await save(id, { has_storage: "on" });
    expect(again.error).toBeNull();
    expect(await pairOf(id)).toMatchObject({ has_storage: false, features: [] });
    expect(await updatedEvents(id), "nothing moved, so nothing is recorded").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. the migration
// ---------------------------------------------------------------------------
describe("4. the migration", () => {
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
  const installed = async () =>
    (
      await o.query<{ trg: number; fn: number }>(
        `select (select count(*)::int from pg_trigger where tgrelid = 'public.properties'::regclass and tgname = $1) as trg,
                (select count(*)::int from pg_proc where oid = to_regprocedure($2)) as fn`,
        [TRIGGER_0152, FUNCTION_0152],
      )
    ).rows[0]!;
  /** The predicate the preflight refuses — the rows recording a storage room two ways, by reference. */
  const conflicts = async () =>
    (
      await o.query<{ reference: string }>(
        `select reference from properties
          where has_storage is not null and has_storage is distinct from coalesce('storage_room' = any(features), false)
          order by reference`,
      )
    ).rows.map((r) => r.reference);
  const OLD = "2026-01-01 00:00:00+00";

  it("replays over the state before it: NULLs backfilled from their features, every other row untouched, the summary as its last row", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0152_SQL);
      expect(await installed()).toEqual({ trg: 0, fn: 0 });
      const nullWith = await insertProperty({ features: ["storage_room"], has_storage: null, updated_at: OLD });
      const nullWithout = await insertProperty({ features: [], has_storage: null, updated_at: OLD });
      const inStepTrue = await insertProperty({ features: ["storage_room"], has_storage: true, updated_at: OLD });
      const inStepFalse = await insertProperty({ features: ["garden"], has_storage: false, updated_at: OLD });
      const nulls = Number((await o.query("select count(*) from properties where has_storage is null")).rows[0].count);
      expect(nulls).toBeGreaterThanOrEqual(2);

      const row = lastRow(await o.query(readMigration0152()));
      expect(Object.keys(row)).toEqual(["migration", "null_rows_backfilled", "with_storage_room", "properties_checked"]);
      expect(row.migration).toBe("0152");
      expect(row.null_rows_backfilled).toBe(nulls);
      expect(await installed()).toEqual({ trg: 1, fn: 1 });
      expect(notices.some((m) => m.startsWith("0152: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0152: postflight passed"))).toBe(true);

      expect((await pairOf(nullWith.id)).has_storage).toBe(true);
      expect((await pairOf(nullWithout.id)).has_storage).toBe(false);
      // the backfilled rows moved (the feed's validator must see them); the rest did not
      expect((await pairOf(nullWith.id)).updated_at).not.toBe((await pairOf(inStepTrue.id)).updated_at);
      for (const r of [inStepTrue, inStepFalse]) {
        const { rows } = await o.query("select updated_at = $2::timestamptz as same from properties where id = $1", [r.id, OLD]);
        expect(rows[0].same, `${r.reference} untouched`).toBe(true);
      }
      expect(await pairOf(inStepTrue.id)).toMatchObject({ has_storage: true, features: ["storage_room"] });
      expect(await pairOf(inStepFalse.id)).toMatchObject({ has_storage: false, features: ["garden"] });
      // and the rule binds from here on
      await o.query("update properties set has_storage = true where id = $1", [inStepFalse.id]);
      expect((await pairOf(inStepFalse.id)).has_storage).toBe(false);
    });
  });

  it("its shape: every abort precedes the first write, the lock precedes the count, no begin/commit, events never written", () => {
    const code = readMigration0152().replace(/--[^\n]*/g, "");
    const firstWrite = code.search(/\bupdate public\.properties\b/i);
    expect(firstWrite).toBeGreaterThan(0);
    expect(firstWrite).toBeLessThan(code.search(/\bcreate or replace function\b/i));
    const aborts = [...code.matchAll(/raise exception '0152 aborted/g)].map((m) => m.index!);
    expect(aborts).toHaveLength(6);
    for (const at of aborts) expect(at).toBeLessThan(firstWrite);
    const lock = code.indexOf("lock table public.properties in share row exclusive mode;");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(code.indexOf("select count(*), string_agg(c.reference"));
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(code).not.toMatch(/\b(delete\s+from|insert\s+into|truncate)\b/i);
    expect(code).not.toMatch(/\bevents\b/i);
    // one backfill, of NULLs only — a conflicting row is never written
    expect([...code.matchAll(/\bupdate public\.properties\b/gi)]).toHaveLength(3); // the backfill + the postflight's two undone probes
    expect(code).toMatch(/update public\.properties\s+set has_storage = coalesce\('storage_room' = any\(features\), false\)\s+where has_storage is null;/);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0152();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/^0152 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("THE CONFLICT REPORT: rows whose two values disagree stop the file, by reference — nothing is overwritten, not even the NULLs; the header's query lists exactly them", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0152_SQL);
      const columnOnly = await insertProperty({ features: ["sea_view"], has_storage: true, updated_at: OLD }); // PAF0004's shape
      const featureOnly = await insertProperty({ features: ["storage_room"], has_storage: false, updated_at: OLD });
      const nullRow = await insertProperty({ features: ["storage_room"], has_storage: null, updated_at: OLD });
      const control = await insertProperty({ features: ["storage_room"], has_storage: true, updated_at: OLD });

      // the header's read-only query (copied out of the file, comment markers stripped)
      const sql = readMigration0152();
      const header = sql.slice(sql.indexOf("--   select p.org_id, p.id, p.reference"), sql.indexOf("--    order by p.org_id, p.reference;") + "--    order by p.org_id, p.reference;".length);
      const listed = (await o.query<{ org_id: string; id: string; reference: string; has_storage: boolean; storage_feature: boolean }>(header.replace(/^--/gm, ""))).rows;
      expect(listed.filter((r) => r.org_id === ORG).map((r) => r.id).sort()).toEqual([columnOnly.id, featureOnly.id].sort());
      expect(listed.find((r) => r.id === columnOnly.id)).toMatchObject({ has_storage: true, storage_feature: false });
      expect(listed.find((r) => r.id === featureOnly.id)).toMatchObject({ has_storage: false, storage_feature: true });
      // a stack carrying another file's leftovers lists those too: the refusal names what the predicate holds
      const refs = await conflicts();
      expect(refs).toEqual(expect.arrayContaining([columnOnly.reference, featureOnly.reference]));
      expect(refs).toHaveLength(listed.length);

      await o.query("savepoint before_0152");
      const e = await failure(o.query(readMigration0152()));
      expect(e?.message).toBe(
        `0152 aborted: ${refs.length} property row(s) record a storage room two ways — has_storage disagrees with the Storage room feature ` +
          `(references${refs.length > 20 ? ", the first 20" : ""}: ${refs.slice(0, 20).join(", ")}) — nothing was changed. ` +
          "Settle each on its Details tab (the read-only query in this file's header lists them with when each side was last set), then apply again",
      );
      for (const leaked of [ORG, columnOnly.id, featureOnly.id, "sea_view"]) expect(e!.message).not.toContain(leaked);
      await o.query("rollback to savepoint before_0152");
      expect(await installed()).toEqual({ trg: 0, fn: 0 });
      // nothing written: both sides of each conflict, the NULL, the control, their updated_at
      expect(await pairOf(columnOnly.id)).toMatchObject({ has_storage: true, features: ["sea_view"] });
      expect(await pairOf(featureOnly.id)).toMatchObject({ has_storage: false, features: ["storage_room"] });
      expect((await pairOf(nullRow.id)).has_storage).toBeNull();
      expect(await pairOf(control.id)).toMatchObject({ has_storage: true });
      const { rows } = await o.query("select count(*)::int as c from properties where id = any($1::uuid[]) and updated_at = $2::timestamptz", [
        [columnOnly.id, featureOnly.id, nullRow.id, control.id],
        OLD,
      ]);
      expect(rows[0].c).toBe(4);

      // settled (as a Details save in the new release does: both from the feature) — it applies
      await o.query("update properties set has_storage = false where id = $1", [columnOnly.id]);
      await o.query("update properties set has_storage = true where id = $1", [featureOnly.id]);
      expect(await conflicts()).toEqual(refs.filter((r) => r !== columnOnly.reference && r !== featureOnly.reference));
      if ((await conflicts()).length === 0) {
        expect(lastRow(await o.query(readMigration0152())).migration).toBe("0152");
        expect((await pairOf(nullRow.id)).has_storage).toBe(true);
      }
    });
  });

  it("over twenty such rows, it names the count and the first twenty references, in order", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0152_SQL);
      const mine: string[] = [];
      for (let i = 0; i < 21; i += 1) mine.push((await insertProperty({ features: [], has_storage: true, reference: ref("C") })).reference);
      await o.query("savepoint before_0152");
      const e = await failure(o.query(readMigration0152()));
      const m = /^0152 aborted: (\d+) property row\(s\) record a storage room two ways — has_storage disagrees with the Storage room feature \(references, the first 20: ([^)]*)\)/.exec(
        e?.message ?? "",
      );
      expect(m, e?.message ?? "(it applied)").not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(21);
      const named = m![2]!.split(", ");
      expect(named).toHaveLength(20);
      await o.query("rollback to savepoint before_0152");
      const all = await conflicts();
      expect(all).toHaveLength(Number(m![1]));
      expect(named).toEqual(all.slice(0, 20));
      if (all.length === 21) expect(named).toEqual([...mine].sort().slice(0, 20));
    });
  });

  it("a write in flight makes it wait at most lock_timeout, then abort (55P03), changing nothing", async () => {
    const { id } = await insertProperty({ features: [] });
    await a.query("begin");
    await a.query("update properties set bedrooms = 2 where id = $1", [id]);
    try {
      await rolledBack(async () => {
        const t0 = Date.now();
        const e = await failure(o.query(readMigration0152()));
        const waited = Date.now() - t0;
        expect(e?.code, e?.message).toBe("55P03");
        // it waited (not NOWAIT) and gave up within the bound. The floor is
        // loose: measured 4.2 s for a 5 s lock_timeout on this machine under
        // load — the database's timer runs in the Docker VM, this clock outside
        expect(waited).toBeGreaterThanOrEqual(3_000);
        expect(waited).toBeLessThan(15_000);
      });
    } finally {
      await a.query("rollback");
    }
  });

  it("is replay-safe: run twice in one transaction, one trigger, the body this file writes", async () => {
    await rolledBack(async () => {
      await o.query(readMigration0152());
      await o.query(readMigration0152());
      expect(await installed()).toEqual({ trg: 1, fn: 1 });
      const { rows } = await o.query("select md5(replace(prosrc, chr(13), '')) as md5 from pg_proc where oid = to_regprocedure($1)", [FUNCTION_0152]);
      expect(readMigration0152()).toContain(rows[0].md5);
    });
  });

  it("refuses to replace a function of the same name it did not write, and a trigger of the same name calling something else", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0152_SQL);
      await o.query("savepoint s");
      await o.query(
        "create function public.trg_property_storage_from_features() returns trigger language plpgsql as $$ begin return new; end $$",
      );
      const e1 = await failure(o.query(readMigration0152()));
      expect(e1?.message).toMatch(/^0152 aborted: public\.trg_property_storage_from_features\(\) exists with a body this file did not write \(md5 [0-9a-f]{32}\)/);
      await o.query("rollback to savepoint s");
      await o.query(
        "create trigger properties_storage_from_features before update on public.properties for each row execute function public.set_updated_at()",
      );
      const e2 = await failure(o.query(readMigration0152()));
      expect(e2?.message).toBe("0152 aborted: a trigger properties_storage_from_features exists that does not call this file's function — nothing was changed");
      await o.query("rollback to savepoint s");
      await o.query("create trigger properties_zz_other before update on public.properties for each row execute function public.set_updated_at()");
      const e3 = await failure(o.query(readMigration0152()));
      expect(e3?.message).toMatch(/^0152 aborted: the triggers on properties are not the expected set \(.*properties_zz_other.*\) — nothing was changed$/);
      await o.query("rollback to savepoint s");
    });
  });

  /** The digest of the trigger body as a mutated file writes it (prosrc is the text between the $$ quotes). */
  const bodyDigest = (sql: string) => {
    const at = sql.indexOf("create or replace function public.trg_property_storage_from_features()");
    const open = sql.indexOf("$$", at);
    const close = sql.indexOf("$$", open + 2);
    return createHash("md5").update(sql.slice(open + 2, close)).digest("hex");
  };
  const KEEPS = "new.has_storage := coalesce(new.has_storage, 'storage_room' = any(new.features), false);";
  const DERIVES = "new.has_storage := coalesce('storage_room' = any(new.features), false);";

  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "a trigger that does not fire on an UPDATE of has_storage alone",
      (s) => s.replace("before insert or update of features, has_storage on public.properties", "before insert or update of features on public.properties"),
      /^0152 postflight: properties_storage_from_features is not the one enabled BEFORE INSERT OR UPDATE OF features, has_storage row trigger/,
    ],
    [
      "an AFTER trigger (it cannot set the row)",
      (s) => s.replace("  before insert or update of features, has_storage on public.properties", "  after insert or update of features, has_storage on public.properties"),
      /^0152 postflight: properties_storage_from_features is not the one enabled BEFORE INSERT OR UPDATE OF features, has_storage row trigger/,
    ],
    [
      "a disabled trigger",
      (s) => s.replace("-- 3. Postflight", "alter table public.properties disable trigger properties_storage_from_features;\n-- 3. Postflight"),
      /^0152 postflight: properties_storage_from_features is not the one enabled BEFORE INSERT OR UPDATE OF features, has_storage row trigger/,
    ],
    [
      "a body that keeps a written has_storage",
      (s) => s.replace(DERIVES, KEEPS),
      /^0152 postflight: public\.trg_property_storage_from_features\(\) is not the invoker trigger function this file writes/,
    ],
    [
      "a body that keeps a written has_storage, with the file's digests moved to match it (the behaviour probe)",
      (s) => {
        const bad = s.replace(DERIVES, KEEPS);
        return bad.replaceAll(bodyDigest(s), bodyDigest(bad));
      },
      /^0152 postflight: a has_storage written on its own was kept \(property [0-9a-f-]{36}\)$/,
    ],
    [
      "a trigger body any API role may call",
      (s) => s.replace("revoke execute on function public.trg_property_storage_from_features() from public, anon, authenticated, service_role;\n", ""),
      /^0152 postflight: public\.trg_property_storage_from_features\(\) is executable by an API role$/,
    ],
    [
      "no backfill (a NULL left behind)",
      (s) => s.replace("   where has_storage is null;", "   where false;"),
      /^0152 postflight: \d+ property row\(s\) hold a has_storage that is not their feature's$/,
    ],
    [
      "another BEFORE trigger on the table",
      (s) =>
        s.replace(
          "-- 3. Postflight",
          "create trigger properties_zz_other before update on public.properties for each row execute function public.set_updated_at();\n-- 3. Postflight",
        ),
      /^0152 postflight: the triggers on properties are .*properties_zz_other/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`the postflight refuses ${label}`, async () => {
      const sql = readMigration0152();
      const bad = mutate(sql);
      expect(bad, "the mutation installed").not.toBe(sql);
      await rolledBack(async () => {
        await o.query(REVERT_0152_SQL);
        await insertProperty({ features: ["storage_room"], has_storage: null }); // a NULL the backfill must reach
        await o.query("savepoint before_0152");
        const e = await failure(o.query(bad));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0152");
        expect(await installed()).toEqual({ trg: 0, fn: 0 });
      });
    });
  }

  it("the rollback recipe leaves 0151's state: trigger, body and comment gone — and has_storage written on its own is kept again", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0152_SQL);
      expect(await installed()).toEqual({ trg: 0, fn: 0 });
      const { rows } = await o.query(
        "select col_description('public.properties'::regclass, (select attnum from pg_attribute where attrelid = 'public.properties'::regclass and attname = 'has_storage')) as c",
      );
      expect(rows[0].c).toBeNull();
      const { id } = await insertProperty({ features: [], has_storage: true });
      expect((await pairOf(id)).has_storage).toBe(true);
    });
  });

  it("the restore pack's 0152 row passes now, and reads a lost, disabled or weakened rule — or a row out of step — as drift", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const start = "  select 'INTEGRITY: storage room has one value";
    const from = pack.indexOf(start);
    expect(from, "the pack carries the 0152 row").toBeGreaterThan(0);
    const row = `select * from (${pack.slice(from, pack.indexOf("\n  union all\n", from))}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now.expected).toBe("true 0");
    expect(now.actual).toBe(now.expected);
    const actual = async () => (await o.query<{ actual: string }>(row)).rows[0]!.actual;
    await rolledBack(async () => {
      await o.query("alter table properties disable trigger properties_storage_from_features");
      expect(await actual()).toBe("false 0");
    });
    await rolledBack(async () => {
      await o.query(REVERT_0152_SQL);
      expect(await actual()).toBe("false 0");
    });
    await rolledBack(async () => {
      await o.query(`create or replace function public.trg_property_storage_from_features() returns trigger language plpgsql
        set search_path = public, pg_temp as $$
        begin
          if new.has_storage is null then
            new.has_storage := coalesce('storage_room' = any(new.features), false);
          end if;
          return new;
        end $$`);
      expect(await actual()).toBe("false 0");
    });
    await rolledBack(async () => {
      await o.query(
        "create or replace trigger properties_storage_from_features before insert or update of features on public.properties for each row execute function public.trg_property_storage_from_features()",
      );
      expect(await actual()).toBe("false 0");
    });
    await rolledBack(async () => {
      // a restore's data load: replica mode fires no trigger
      await o.query("set local session_replication_role = replica");
      await insertProperty({ features: [], has_storage: true });
      await insertProperty({ features: ["storage_room"], has_storage: null });
      await o.query("set local session_replication_role = origin");
      expect(await actual()).toBe("true 2");
    });
  });

  it("the chain verifies for the organisation after everything above", async () => {
    const { rows } = await o.query("select ok, reason from public.verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
