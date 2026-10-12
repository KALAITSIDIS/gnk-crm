import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  ANON_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * The listing worklist scores every live listing from its photos and its
 * active mandate whatever the portfolio's size — through the REAL page server
 * component, against a REAL PostgREST behind the local Kong, with real aal2
 * sessions (T-worklist-id-lists).
 *
 * At d985029 `fetchQualityWorklist` read the photos and the active mandates
 * with every live listing's id written into the URL
 * (`.in("property_id", ids)`, twice), and the photo read was a single
 * unpaged request:
 *   1. past about 208 live listings (units included) the gateway answered 414
 *      and the page fell to its error boundary;
 *   2. past 1,000 photos in all, PostgREST's max_rows cut the photo read
 *      silently, and the listings whose photos were cut were scored as having
 *      none — chased for a cover and for photos they have.
 *
 * WHAT IT PINS (each case prints one `[evidence]` line), with PostgREST's
 * row cap lowered to 50 (CAP_ROWS) for this file so every read must page:
 *   1. with 230 live listings in all four live statuses, the "Cover photo",
 *      "At least 6 photos", "Active mandate" and "At least one unit"
 *      categories name exactly the listings that lack each (an SQL oracle) —
 *      for an admin and a listing manager (mandates through `mandates_safe`)
 *      — floor plans are not photos, expired mandates are not active, a sold
 *      listing's copy of a photo raises no shared-photo warning, a listing
 *      with more photos than the cap keeps its cover, and a project whose only
 *      unit is sold (and last of the rest) keeps it;
 *   2. the request does not grow with the listings: no id list, and the same
 *      requests as for an organisation with a handful;
 *   3. with 1,100 photos on 100 listings (a cover each, eleven photos each),
 *      no listing is chased for a cover or for photos.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const BIG = randomUUID();
const CAP = randomUUID();
const SMALL = randomUUID();
const ORGS = [BIG, CAP, SMALL];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `worklist-id-lists-${RUN}`;

/** Live listings in BIG — past the ~208 ids Kong took in one URL. */
const N_BIG = 230;
/** BIG: the first half carry six photos and a cover, the rest one photo and none. */
const N_PHOTOGRAPHED = 115;
/** CAP: listings × photos each = 1,100 photos, past PostgREST's 1,000 rows. */
const N_CAP = 100;
const PHOTOS_EACH = 11;
/** PostgREST's row cap for this file, set in the database and restored after. */
const CAP_ROWS = 50;
/** BIG: one listing with more photos than CAP_ROWS, its cover the last of them. */
const MANY_PHOTOS = 60;
/** BIG: sold rows besides the project's unit — more than CAP_ROWS, so the second read pages. */
const N_SOLD = 60;
/** The project's sold unit sorts after every other row (the reads order by id). */
const LAST_ID = `ffffffff-ffff-4fff-bfff-${Buffer.from(RUN).toString("hex").padStart(12, "0").slice(-12)}`;

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this page");
    return c;
  },
}));

import PropertyWorklistPage from "@/app/(app)/properties/worklist/page";
import { QualityWorklist } from "@/components/features/properties/quality-worklist";
import type { Worklist } from "@/lib/services/quality-worklist";

// ---------------------------------------------------------------------------
// A real session per user; every REST GET it sends is recorded
// ---------------------------------------------------------------------------
type Session = { client: SupabaseClient; gets: string[] };
const sessions = new Map<TestUser, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const gets: string[] = [];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
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
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  sessions.set(user, { client, gets });
  return { client, gets };
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

/** The worklist the page renders, or what it threw; and the GETs it sent. */
async function worklistOf(user: TestUser) {
  const { client, gets } = await session(user);
  gets.length = 0;
  let worklist: Worklist | null = null;
  let thrown: string | null = null;
  try {
    const root = (await ctx.als.run(client, () => PropertyWorklistPage())) as ReactNode;
    const el = [...walk(root)].find((e) => e.type === QualityWorklist);
    if (!el) throw new Error("the page rendered no worklist");
    worklist = el.props.worklist as Worklist;
  } catch (e) {
    thrown = e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e);
  }
  const decoded = gets.map((u) => decodeURIComponent(u));
  return { worklist, thrown, gets: decoded };
}

/** The references a category names, sorted ([] when the category is absent). */
const inCategory = (w: Worklist, key: string) =>
  (w.categories.find((c) => c.key === key)?.properties ?? []).map((p) => p.reference).sort();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let bigUser: TestUser;
let bigManager: TestUser;
let capUser: TestUser;
let smallUser: TestUser;
const userIds: string[] = [];

async function refs(sql: string, params: unknown[]): Promise<string[]> {
  const { rows } = await pg.query<{ v: string }>(sql, params);
  return rows.map((r) => r.v).sort();
}

/** PostgREST's row cap, set in the database and confirmed by a real read (as list-export-complete does). */
async function setServerCap(cap: number | null): Promise<void> {
  if (cap === null) await pg.query("alter role authenticator reset pgrst.db_max_rows");
  else await pg.query(`alter role authenticator set pgrst.db_max_rows = '${cap}'`);
  await pg.query("notify pgrst, 'reload config'");
  const want = cap ?? 1000;
  const sc = serviceClient();
  for (let i = 0; i < 50; i++) {
    const { data } = await sc.from("properties").select("id").eq("org_id", BIG).range(0, 999);
    // BIG holds fewer than 1,000 rows: uncapped, it answers all of them
    const all = Number((await pg.query<{ n: string }>("select count(*) as n from properties where org_id = $1", [BIG])).rows[0]!.n);
    if ((data?.length ?? -1) === Math.min(want, all)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`PostgREST did not take max_rows = ${want}`);
}

/** Listings of `org` that are live and not archived, as the worklist scores them. */
const LIVE = `p.status in ('draft','available','reserved','under_offer') and p.visibility <> 'archived'`;

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  // a cap left lowered by an interrupted run of this file
  await pg.query("alter role authenticator reset pgrst.db_max_rows");
  await pg.query("notify pgrst, 'reload config'");
  await ensureTestOrg(svc, BIG, `Worklist big ${RUN}`, SLUG);
  await ensureTestOrg(svc, CAP, `Worklist cap ${RUN}`, `${SLUG}-cap`);
  await ensureTestOrg(svc, SMALL, `Worklist small ${RUN}`, `${SLUG}-small`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  bigUser = await createTestUser(svc, `wl-big-${RUN}@test.local`, "admin", BIG);
  userIds.push(bigUser.id);
  bigManager = await createTestUser(svc, `wl-lm-${RUN}@test.local`, "listing_manager", BIG);
  userIds.push(bigManager.id);
  capUser = await createTestUser(svc, `wl-cap-${RUN}@test.local`, "admin", CAP);
  userIds.push(capUser.id);
  smallUser = await createTestUser(svc, `wl-small-${RUN}@test.local`, "admin", SMALL);
  userIds.push(smallUser.id);

  /** `n` listings; `cycle` walks them through the four live statuses (else all available). */
  const listings = (org: string, prefix: string, n: number, cycle = false) =>
    pg.query(
      `insert into properties (org_id, reference, property_type, status)
       select $1::uuid, format('%s%s-%s', $2::text, $3::text, lpad(g::text, 4, '0')), 'apartment',
              case when $5 then (array['draft','available','reserved','under_offer']::property_status[])[1 + g % 4]
                   else 'available'::property_status end
         from generate_series(1, $4::int) g`,
      [org, prefix, TAG, n, cycle],
    );
  /**
   * `per` photos on each listing matching `like`, inserted listing by listing;
   * the cover is each listing's LAST photo (so a read cut at its tail loses
   * covers too), every photo's hash its own (no shared-photo warnings).
   */
  const photos = (org: string, like: string, per: number) =>
    pg.query(
      `insert into property_media (org_id, property_id, kind, path_thumb, is_cover, sort_order, content_sha256)
       select $1::uuid, p.id, 'photo', format('t/%s/%s.jpg', p.id, s), s = $3::int, s,
              encode(sha256(convert_to(p.id::text || '-' || s, 'UTF8')), 'hex')
         from (select id, reference from properties where org_id = $1 and reference like $2 order by reference) p,
              generate_series(1, $3::int) s
        order by p.reference, s`,
      [org, like, per],
    );

  // BIG: 230 live listings; the first 115 with six photos and a cover, the
  // rest one photo and no cover; an active mandate on every other one
  await listings(BIG, "WB", N_BIG, true);
  await pg.query(
    `insert into property_media (org_id, property_id, kind, path_thumb, is_cover, sort_order, content_sha256)
     select $1::uuid, p.id, 'photo', format('t/%s/%s.jpg', p.id, s), (p.n <= $2 and s = 6), s,
            encode(sha256(convert_to(p.id::text || '-' || s, 'UTF8')), 'hex')
       from (select id, row_number() over (order by reference) as n from properties where org_id = $1) p,
            generate_series(1, 6) s
      where s = 1 or p.n <= $2
      order by p.n, s`,
    [BIG, N_PHOTOGRAPHED],
  );
  await pg.query(
    `insert into mandates (org_id, property_id, type, status)
     select $1::uuid, p.id, 'exclusive', 'active'
       from (select id, row_number() over (order by reference) as n from properties where org_id = $1) p
      where p.n % 2 = 0`,
    [BIG],
  );

  // …and what the reads must leave out, each where it would show:
  //  - five floor plans on each of five one-photo listings (counted as photos,
  //    they would clear "At least 6 photos");
  //  - an expired mandate on ten unmandated listings (counted, they would
  //    clear "Active mandate");
  //  - a SOLD listing whose photograph is also on WB…-0001 (read, it would
  //    raise a shared-photo warning on a live listing — the worklist reads the
  //    live listings' photos only, as before);
  //  - and the control: WB…-0003 and WB…-0005 share a photograph, both live.
  const nth = (n: number) => `WB${TAG}-${String(n).padStart(4, "0")}`;
  await pg.query(
    `insert into property_media (org_id, property_id, kind, path_thumb, sort_order)
     select $1::uuid, p.id, 'floor_plan', format('t/%s/plan-%s.jpg', p.id, s), 10 + s
       from properties p, generate_series(1, 5) s
      where p.org_id = $1 and p.reference = any($2::text[])`,
    [BIG, [200, 201, 202, 203, 204].map(nth)],
  );
  await pg.query(
    `insert into mandates (org_id, property_id, type, status)
     select $1::uuid, p.id, 'exclusive', 'expired' from properties p
      where p.org_id = $1 and p.reference = any($2::text[])`,
    [BIG, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19].map(nth)],
  );
  const hashOf = async (ref: string) =>
    (
      await pg.query<{ h: string }>(
        `select m.content_sha256 as h from property_media m join properties p on p.id = m.property_id
          where p.org_id = $1 and p.reference = $2 and m.sort_order = 1`,
        [BIG, ref],
      )
    ).rows[0]!.h;
  const { rows: sold } = await pg.query<{ id: string }>(
    `insert into properties (org_id, reference, property_type, status)
     values ($1, $2, 'apartment', 'sold') returning id`,
    [BIG, `WX${TAG}-0001`],
  );
  await pg.query(
    `insert into property_media (org_id, property_id, kind, path_thumb, sort_order, content_sha256)
     values ($1, $2, 'photo', 't/sold.jpg', 1, $3)`,
    [BIG, sold[0]!.id, await hashOf(nth(1))],
  );
  await pg.query(
    `insert into property_media (org_id, property_id, kind, path_thumb, sort_order, content_sha256)
     select $1, p.id, 'photo', 't/shared.jpg', 7, $3 from properties p where p.org_id = $1 and p.reference = $2`,
    [BIG, nth(5), await hashOf(nth(3))],
  );

  // a listing with more photos than the cap, its cover the LAST inserted: an
  // embedded array is capped too, so the cover must come first to be seen
  await listings(BIG, "WM", 1);
  await photos(BIG, `WM${TAG}-%`, MANY_PHOTOS);
  // a live project whose only unit is SOLD — in the second read, and last of it
  const { rows: project } = await pg.query<{ id: string }>(
    `insert into properties (org_id, reference, property_type, kind, status)
     values ($1, $2, 'apartment', 'project', 'available') returning id`,
    [BIG, `WP${TAG}-0001`],
  );
  await pg.query(
    `insert into properties (id, org_id, reference, property_type, kind, parent_id, status, asking_price)
     values ($1, $2, $3, 'apartment', 'unit', $4, 'sold', 250000)`,
    [LAST_ID, BIG, `WU${TAG}-0001`, project[0]!.id],
  );
  await pg.query(
    `insert into properties (org_id, reference, property_type, status)
     select $1::uuid, format('WS%s-%s', $2::text, lpad(g::text, 4, '0')), 'apartment', 'sold'
       from generate_series(1, $3::int) g`,
    [BIG, `X${TAG}`, N_SOLD],
  );

  // CAP: 100 live listings, eleven photos each (1,100 — past max_rows), cover last
  await listings(CAP, "WC", N_CAP);
  await photos(CAP, `WC${TAG}-%`, PHOTOS_EACH);

  // SMALL: five live listings, the same shapes in miniature (the URL control)
  await listings(SMALL, "WS", 5);
  await photos(SMALL, `WS${TAG}-%`, 6);
  await pg.query(
    `insert into mandates (org_id, property_id, type, status)
     select $1::uuid, id, 'exclusive', 'active' from properties where org_id = $1`,
    [SMALL],
  );
  await pg.query("analyze properties; analyze property_media; analyze mandates;");
  await setServerCap(CAP_ROWS);
}, 300_000);

afterAll(async () => {
  await setServerCap(null);
  await pg.query("delete from mandates where org_id = any($1::uuid[])", [ORGS]);
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
describe("the listing worklist scores every live listing, whatever the portfolio's size", () => {
  it(`${N_BIG} live listings: cover, photos and mandate name exactly the listings that lack them`, async () => {
    const lackCover = await refs(
      `select p.reference as v from properties p where p.org_id = $1 and ${LIVE}
         and not exists (select 1 from property_media m where m.property_id = p.id and m.kind = 'photo' and m.is_cover)`,
      [BIG],
    );
    const lackPhotos = await refs(
      `select p.reference as v from properties p where p.org_id = $1 and ${LIVE}
         and (select count(*) from property_media m where m.property_id = p.id and m.kind = 'photo') < 6`,
      [BIG],
    );
    const lackMandate = await refs(
      `select p.reference as v from properties p where p.org_id = $1 and ${LIVE}
         and not exists (select 1 from mandates m where m.property_id = p.id and m.status = 'active')`,
      [BIG],
    );
    expect(lackCover).toHaveLength(N_BIG - N_PHOTOGRAPHED + 1); // + the project, which has no photos
    expect(lackMandate).toHaveLength(N_BIG / 2 + 2); // + the many-photo listing and the project

    // containers with no unarchived unit, directly or through a phase
    const lackUnits = await refs(
      `select p.reference as v from properties p where p.org_id = $1 and ${LIVE} and p.kind in ('project','phase')
         and not exists (select 1 from properties u where u.kind = 'unit' and u.visibility <> 'archived'
                          and (u.parent_id = p.id or u.parent_id in (select ph.id from properties ph where ph.parent_id = p.id and ph.kind = 'phase')))`,
      [BIG],
    );
    // the fixture has what the cases assume
    expect(lackCover).toContain(`WP${TAG}-0001`);
    expect(lackCover).not.toContain(`WM${TAG}-0001`);
    expect(lackUnits).toEqual([]);
    expect(
      (await refs(`select distinct p.status::text as v from properties p where p.org_id = $1 and p.reference like 'WB%' and ${LIVE}`, [BIG])),
      "all four live statuses",
    ).toEqual(["available", "draft", "reserved", "under_offer"]);

    for (const [label, user] of [["an admin", bigUser], ["a listing manager", bigManager]] as const) {
      const { worklist, thrown, gets } = await worklistOf(user);
      const longest = Math.max(...gets.map((u) => u.length));
      console.log(
        `[evidence] ${label}, ${N_BIG} live listings (cap ${CAP_ROWS}): ${thrown ? `THREW ${thrown}` : `cover ${inCategory(worklist!, "cover").length}, photos6 ${inCategory(worklist!, "photos6").length}, mandate ${inCategory(worklist!, "mandate").length}, units ${inCategory(worklist!, "units").length}, total ${worklist!.total}`}; GETs ${gets.length}, longest ${longest} chars`,
      );
      expect(thrown, label).toBeNull();
      expect(inCategory(worklist!, "cover"), label).toEqual(lackCover);
      // floor plans are not photos, expired mandates are not active ones
      expect(inCategory(worklist!, "photos6"), label).toEqual(lackPhotos);
      expect(inCategory(worklist!, "mandate"), label).toEqual(lackMandate);
      // the project keeps its one sold unit (the last row of the second read)
      expect(inCategory(worklist!, "units"), label).toEqual(lackUnits);
      // the live listings' photos only: the sold listing's copy of …-0001's
      // photo raises nothing; the two live listings sharing one are both warned
      const shared = Object.fromEntries(worklist!.sharedPhotos.map((s) => [s.property.reference, s.withReferences]));
      const ref = (n: number) => `WB${TAG}-${String(n).padStart(4, "0")}`;
      expect(shared, label).toEqual({ [ref(3)]: [ref(5)], [ref(5)]: [ref(3)] });
    }
  }, 180_000);

  it("the request does not grow with the listings: no id list, the same URLs as for five listings", async () => {
    const big = await worklistOf(bigUser);
    const small = await worklistOf(smallUser);
    // the paged reads end with an empty read at offset = rows read (230 vs 5):
    // the offset is the only figure allowed to differ
    const shape = (u: string) => u.replace(/^.*\/rest\/v1\//, "").replace(/offset=\d+/, "offset=N");
    console.log(
      `[evidence] request URLs: ${big.gets.length} GETs for ${N_BIG} listings (longest ${Math.max(...big.gets.map((u) => u.length))}) vs ${small.gets.length} for 5 (longest ${Math.max(...small.gets.map((u) => u.length))})`,
    );
    expect(big.thrown).toBeNull();
    expect(small.thrown).toBeNull();
    for (const u of big.gets) expect(u, "no id list in the request").not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    // the same requests, character for character (how many pages each takes
    // depends on the rows, not on the request)
    expect([...new Set(big.gets.map(shape))].sort()).toEqual([...new Set(small.gets.map(shape))].sort());
    // and the small organisation's listings are fully scored (the URL control is not vacuous)
    expect(inCategory(small.worklist!, "cover")).toEqual([]);
    expect(inCategory(small.worklist!, "mandate")).toEqual([]);
  }, 120_000);

  it(`${N_CAP * PHOTOS_EACH} photos on ${N_CAP} listings (past PostgREST's 1,000 rows): no listing is chased for a cover or for photos it has`, async () => {
    const total = Number((await pg.query<{ n: string }>("select count(*) as n from property_media where org_id = $1", [CAP])).rows[0]!.n);
    expect(total).toBe(N_CAP * PHOTOS_EACH);
    const { worklist, thrown, gets } = await worklistOf(capUser);
    console.log(
      `[evidence] ${total} photos: ${thrown ? `THREW ${thrown}` : `chased for a cover ${inCategory(worklist!, "cover").length}, for photos ${inCategory(worklist!, "photos6").length}`}; GETs ${gets.length}`,
    );
    expect(thrown).toBeNull();
    expect(inCategory(worklist!, "cover"), "every listing has a cover").toEqual([]);
    expect(inCategory(worklist!, "photos6"), "every listing has eleven photos").toEqual([]);
    // every listing scored: each is in the mandate category (none has one)
    expect(inCategory(worklist!, "mandate")).toHaveLength(N_CAP);
  }, 120_000);
});
