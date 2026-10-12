import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  ANON_KEY,
  SERVICE_ROLE_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * "This photograph is also on …" — the property page's warning and the score a
 * photo action recomputes — names every other listing carrying one of the
 * listing's photographs, whatever the listing's photo count or the number of
 * listings sharing them: through the REAL property page and the REAL
 * set-cover action, against a REAL PostgREST behind the local Kong, with a
 * real aal2 session (T-shared-photo-references).
 *
 * At 2cbd490 `fetchSharedPhotoReferences` wrote every hashed photo's
 * content_sha256 of the listing into one URL (`.in("content_sha256", …)`,
 * ~67 bytes each), then every sharing listing's id into a second
 * (`.in("id", ids)`), each unpaged. Past about 122 hashes or about 210 sharing
 * listings the gateway answered 414: the property page fell to its error
 * boundary, and set-cover / delete-photo — which recompute the score after
 * their write has committed — THREW with the cover already changed.
 *
 * WHAT IT PINS (each case prints one `[evidence]` line):
 *   1. a listing with 130 hashed photographs, 215 others each sharing one: the
 *      page renders and its warning names all 215 (sorted), and never another
 *      organisation's listing;
 *   2. setting a cover on that listing answers success, the cover is set and
 *      the stored score is recomputed — no throw after the committed write;
 *   3. no request carries more than a bounded slice of the hashes, and none an
 *      id list;
 *   4. with PostgREST's row cap lowered to 50, the answer is still all 215 —
 *      each slice's read pages. (Only here: the page's and the score's own
 *      photo reads are unpaged, so a lowered cap would hide the 414 above by
 *      handing them 50 photographs.)
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER = randomUUID();
const ORGS = [ORG, OTHER];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `shared-photo-references-${RUN}`;

/** The listing's hashed photographs — past the ~122 hashes Kong took in one URL. */
const N_PHOTOS = 130;
/** Listings sharing one of them — past the ~210 ids Kong took in one URL. */
const N_SHARERS = 215;
/** PostgREST's row cap for this file, set in the database and restored after. */
const CAP_ROWS = 50;

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
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
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this page");
    return c;
  },
}));

import PropertyDetailPage from "@/app/(app)/properties/[id]/page";
import { setMediaCover } from "@/lib/actions/media";
import { QualityScoreRing } from "@/components/features/shared/quality-score-ring";
import { fetchSharedPhotoReferences } from "@/lib/services/shared-photos";
import { recomputeQualityScore } from "@/lib/services/quality-score";

// ---------------------------------------------------------------------------
let client: SupabaseClient;
const gets: string[] = [];

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

type Warning = { key: string; references: string[] };

/** The page's shared-photo warning (null when none), or what it threw; and the GETs it sent. */
async function pageWarning(id: string) {
  gets.length = 0;
  try {
    const root = (await ctx.als.run(client, () =>
      PropertyDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
    )) as ReactNode;
    const ring = [...walk(root)].find((e) => e.type === QualityScoreRing);
    if (!ring) throw new Error("the page rendered no quality ring");
    const w = (ring.props.warnings as Warning[]).find((x) => x.key === "shared_photo") ?? null;
    return { refs: w?.references ?? null, thrown: null as string | null, gets: [...gets] };
  } catch (e) {
    return { refs: null, thrown: e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e), gets: [...gets] };
  }
}

/** The GETs that asked which listings share a photograph. */
const sharedReads = (urls: string[]) =>
  urls.map((u) => decodeURIComponent(u)).filter((u) => /\/rest\/v1\/property_media\?.*content_sha256=in\./.test(u));

// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let outsider: TestUser;
const userIds: string[] = [];
let listingId = "";
let coverCandidate = "";
let expectedRefs: string[] = [];

/** PostgREST's row cap, set in the database and confirmed by a real read. */
async function setServerCap(cap: number | null): Promise<void> {
  if (cap === null) await pg.query("alter role authenticator reset pgrst.db_max_rows");
  else await pg.query(`alter role authenticator set pgrst.db_max_rows = '${cap}'`);
  await pg.query("notify pgrst, 'reload config'");
  const want = cap ?? 1000;
  const all = Number((await pg.query<{ n: string }>("select count(*) as n from properties where org_id = $1", [ORG])).rows[0]!.n);
  for (let i = 0; i < 50; i++) {
    const { data } = await serviceClient().from("properties").select("id").eq("org_id", ORG).range(0, 999);
    if ((data?.length ?? -1) === Math.min(want, all)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`PostgREST did not take max_rows = ${want}`);
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  // a cap left lowered by an interrupted run of this file
  await pg.query("alter role authenticator reset pgrst.db_max_rows");
  await pg.query("notify pgrst, 'reload config'");
  // the property page also builds a service-role client (createAdminClient)
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= SERVICE_ROLE_KEY;

  await ensureTestOrg(svc, ORG, `Shared photos ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER, `Shared photos other ${RUN}`, `${SLUG}-other`);
  admin = await createTestUser(svc, `spr-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  outsider = await createTestUser(svc, `spr-other-${RUN}@test.local`, "admin", OTHER);
  userIds.push(outsider.id);

  const s = (await admin.client.auth.getSession()).data.session!;
  client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if ((init?.method ?? "GET").toUpperCase() === "GET" && url.includes("/rest/v1/")) gets.push(url);
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession: ${error.message}`);

  // the listing: 130 photographs, each its own hash, none a cover yet
  const { rows: l } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type, status) values ($1, $2, 'apartment', 'available') returning id",
    [ORG, `SA${TAG}-0001`],
  );
  listingId = l[0]!.id;
  // photograph g's hash is sha256("<RUN>-<g>"); the sharers below reuse them
  await pg.query(
    `insert into property_media (org_id, property_id, kind, path_thumb, sort_order, content_sha256)
     select $1::uuid, $2::uuid, 'photo', format('t/%s.jpg', g), g,
            encode(sha256(convert_to($4::text || '-' || g, 'UTF8')), 'hex')
       from generate_series(1, $3::int) g`,
    [ORG, listingId, N_PHOTOS, RUN],
  );
  coverCandidate = (await pg.query<{ id: string }>("select id from property_media where property_id = $1 order by sort_order limit 1", [listingId])).rows[0]!.id;
  // 215 listings, each carrying ONE of those photographs (spread over all 130)
  await pg.query(
    `insert into properties (org_id, reference, property_type, status)
     select $1::uuid, format('SS%s-%s', $2::text, lpad(g::text, 4, '0')), 'apartment', 'available'
       from generate_series(1, $3::int) g`,
    [ORG, TAG, N_SHARERS],
  );
  await pg.query(
    `insert into property_media (org_id, property_id, kind, path_thumb, sort_order, content_sha256)
     select $1::uuid, p.id, 'photo', 't/s.jpg', 1, encode(sha256(convert_to($2::text || '-' || (1 + (p.n - 1) % $3::int), 'UTF8')), 'hex')
       from (select id, row_number() over (order by reference) as n from properties where org_id = $1 and reference like 'SS%') p`,
    [ORG, RUN, N_PHOTOS],
  );
  // one sharing listing carries a second of them, from another slice of the
  // hashes: named once
  await pg.query(
    `insert into property_media (org_id, property_id, kind, path_thumb, sort_order, content_sha256)
     select $1::uuid, id, 'photo', 't/s2.jpg', 2, encode(sha256(convert_to($2::text || '-' || $3::int, 'UTF8')), 'hex')
       from properties where org_id = $1 and reference = $4`,
    [ORG, RUN, N_PHOTOS - 5, `SS${TAG}-0001`],
  );
  // another organisation's listing carrying the same photograph: never named
  const { rows: o } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type, status) values ($1, $2, 'apartment', 'available') returning id",
    [OTHER, `SX${TAG}-0001`],
  );
  await pg.query(
    `insert into property_media (org_id, property_id, kind, path_thumb, sort_order, content_sha256)
     values ($1, $2, 'photo', 't/x.jpg', 1, encode(sha256(convert_to($3::text || '-1', 'UTF8')), 'hex'))`,
    [OTHER, o[0]!.id, RUN],
  );

  expectedRefs = (
    await pg.query<{ reference: string }>(
      `select distinct p.reference from property_media m2
         join property_media m1 on m1.content_sha256 = m2.content_sha256 and m1.property_id = $1
         join properties p on p.id = m2.property_id
        where m2.property_id <> $1 and m2.org_id = $2
        order by p.reference`,
      [listingId, ORG],
    )
  ).rows.map((r) => r.reference);
  await pg.query("analyze properties; analyze property_media;");
}, 300_000);

afterAll(async () => {
  await setServerCap(null);
  await pg.query("delete from property_media where org_id = any($1::uuid[])", [ORGS]);
  await pg.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await pg.end();
}, 300_000);

// ---------------------------------------------------------------------------
describe("the shared-photograph warning names every sharing listing", () => {
  it(`a listing with ${N_PHOTOS} photographs, ${N_SHARERS} listings sharing them: the page names all of them`, async () => {
    expect(expectedRefs).toHaveLength(N_SHARERS);
    const out = await pageWarning(listingId);
    const reads = sharedReads(out.gets);
    console.log(
      `[evidence] page: ${out.thrown ? `THREW ${out.thrown}` : `warning names ${out.refs?.length ?? 0}`}; shared-photo GETs ${reads.length}, longest ${Math.max(0, ...reads.map((u) => u.length))} chars`,
    );
    expect(out.thrown).toBeNull();
    expect(out.refs).toEqual(expectedRefs);
    expect(out.refs).not.toContain(`SX${TAG}-0001`);
  }, 120_000);

  it("setting a cover answers success, sets it, and recomputes the score with the warning — no throw after the write", async () => {
    let result: { error: string | null } | null = null;
    let thrown: string | null = null;
    try {
      result = await ctx.als.run(client, () => setMediaCover(listingId, coverCandidate));
    } catch (e) {
      thrown = e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e);
    }
    const cover = (await pg.query<{ is_cover: boolean }>("select is_cover from property_media where id = $1", [coverCandidate])).rows[0]!.is_cover;
    const score = (await pg.query<{ quality_score: number }>("select quality_score from properties where id = $1", [listingId])).rows[0]!.quality_score;
    // the score the listing has now, computed without writing it
    const fresh = thrown ? null : await ctx.als.run(client, () => recomputeQualityScore(client as never, listingId, { persist: false }));
    console.log(`[evidence] set cover: ${thrown ? `THREW ${thrown}` : JSON.stringify(result)}; cover set ${cover}; stored score ${score}, fresh ${fresh?.score ?? "-"}`);
    expect(thrown, "the action answers, never throws after its write").toBeNull();
    expect(result).toEqual({ error: null });
    expect(cover).toBe(true);
    // quality_score is NOT NULL DEFAULT 0 and nothing else writes it here: the
    // cover (5) and six-plus photos (10) make the recomputed score at least 15
    expect(score, "the score was recomputed and stored after the write").toBeGreaterThan(0);
    expect(score).toBe(fresh!.score);
  }, 120_000);

  it("no request carries more than a bounded slice of the hashes, and none an id list", async () => {
    const out = await pageWarning(listingId);
    const urls = out.gets.map((u) => decodeURIComponent(u));
    const reads = sharedReads(out.gets);
    const hashesPer = reads.map((u) => (/content_sha256=in\.\(([^)]*)\)/.exec(u)?.[1] ?? "").split(",").filter(Boolean).length);
    console.log(`[evidence] request sizes: ${reads.length} shared-photo reads, hashes per read ${hashesPer.join("/")}; longest GET ${Math.max(...urls.map((u) => u.length))} chars`);
    expect(out.thrown).toBeNull();
    expect(Math.max(...hashesPer), "a bounded slice of the hashes per request").toBeLessThanOrEqual(50);
    // each slice is asked twice (its rows, then the empty page that ends it):
    // count the DISTINCT hashes asked about
    const asked = new Set(reads.flatMap((u) => (/content_sha256=in\.\(([^)]*)\)/.exec(u)?.[1] ?? "").split(",").filter(Boolean)));
    expect(asked.size, "every hash asked about").toBe(N_PHOTOS);
    for (const u of urls) expect(u, "no id list").not.toMatch(/(?:^|[?&])id=in\./);
    expect(Math.max(...urls.map((u) => u.length)), "every request well under the gateway's 8 KB").toBeLessThan(6000);
  }, 120_000);

  it(`under a row cap of ${CAP_ROWS}, every sharing listing is still named: each slice's read pages`, async () => {
    const hashes = (
      await pg.query<{ h: string }>("select content_sha256 as h from property_media where property_id = $1 order by sort_order", [listingId])
    ).rows.map((r) => r.h);
    expect(hashes).toHaveLength(N_PHOTOS);
    await setServerCap(CAP_ROWS);
    try {
      gets.length = 0;
      let refs: string[] | null = null;
      let thrown: string | null = null;
      try {
        refs = await fetchSharedPhotoReferences(client as never, listingId, ORG, hashes);
      } catch (e) {
        thrown = e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e);
      }
      console.log(`[evidence] cap ${CAP_ROWS}: ${thrown ? `THREW ${thrown}` : `names ${refs!.length}`}; GETs ${gets.length}`);
      expect(thrown).toBeNull();
      expect(refs).toEqual(expectedRefs);
    } finally {
      await setServerCap(null);
    }
  }, 120_000);
});
