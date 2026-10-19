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
 * The properties map page (F08) — through the REAL page, against a REAL
 * PostgREST, with a real aal2 session. The client half (WebGL, the style, the
 * watchdog) is in lib/services/property-map.test.ts and
 * tests/e2e/property-map.spec.ts; this file pins what the SERVER hands the map.
 *
 * WHAT IT PINS (each case prints one `[evidence]` line):
 *   1. A STORED area centre (`location_approx`, 0054) reaches the map as
 *      "approximate". Before F08 the page's select predated the column and
 *      never passed it, so resolvePosition — tested on its own, correct on its
 *      own — was handed `undefined` and drew the centre teal, "Exact
 *      location", contradicting 0054's header ("both readers are taught to
 *      respect it"). The precision every pin should have is asked of the
 *      DATABASE, not of the function under test.
 *   2. The page says what it could not place — "4 on the map · 1 without a
 *      location" — and the map is handed the same count: a row with no point
 *      and no area or district centre used to vanish without a word.
 *   3. The map is handed the list under the same filters (`listHref`), the
 *      way out of a map that cannot draw.
 *   4. Past PostgREST's 1,000-row cap every matching row is read, each once:
 *      1,005 placed listings are 1,005 pins and "1005 on the map". The read
 *      used to be one unpaged, unordered select — an arbitrary 1,000, and the
 *      new count line would have stated a confident wrong number.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `map-page-${RUN}`;
/** the placement fixtures' references start with this */
const PFX = `MAPF${TAG}`;
/** the 1,005 bulk listings' references start with this */
const BULK = `MAPN${TAG}`;
const N_BULK = 1_005;

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

import PropertiesMapPage from "@/app/(app)/properties/map/page";
import { PropertyMap } from "@/components/features/properties/map-view";

type Params = Record<string, string>;
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

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as Element).props.children);
  return "";
}

// ---------------------------------------------------------------------------
// A real session; every properties GET it sends is recorded
// ---------------------------------------------------------------------------
let session: { client: SupabaseClient; gets: string[] } | null = null;

async function sessionOf(user: TestUser) {
  if (session) return session;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const gets: string[] = [];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if ((init?.method ?? "GET").toUpperCase() === "GET" && /\/rest\/v1\/properties\?/.test(url)) gets.push(url);
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  session = { client, gets };
  return session;
}

type Pin = { id: string; precision: string; coordinates: [number, number] };
interface MapScreen {
  pins: Pin[];
  unplaced: unknown;
  listHref: unknown;
  /** the header's "N on the map · M without a location" */
  placement: string | null;
  /** the header's List button */
  headerListHref: string | null;
  /** the properties GETs the page sent, decoded */
  reads: URLSearchParams[];
}

async function mapScreen(user: TestUser, params: Params): Promise<MapScreen> {
  const { client, gets } = await sessionOf(user);
  gets.length = 0;
  const root = (await ctx.als.run(client, () =>
    PropertiesMapPage({ searchParams: Promise.resolve({ ...params }) }),
  )) as ReactNode;
  const els = [...walk(root)];
  const map = els.find((e) => e.type === PropertyMap);
  if (!map) throw new Error("the map page rendered no map");
  const placement = els.find((e) => e.props["data-testid"] === "property-map-placement");
  const listButton = els.find((e) => typeof e.props.href === "string" && textOf(e).trim() === "List");
  const data = map.props.data as {
    features: { geometry: { coordinates: [number, number] }; properties: { id: string; precision: string } }[];
  };
  return {
    pins: data.features.map((f) => ({
      id: f.properties.id,
      precision: f.properties.precision,
      coordinates: f.geometry.coordinates,
    })),
    unplaced: map.props.unplaced,
    listHref: map.props.listHref,
    placement: placement ? textOf(placement) : null,
    headerListHref: listButton ? String(listButton.props.href) : null,
    reads: gets.map((u) => new URL(u).searchParams),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
const userIds: string[] = [];

/** What the DATABASE says each matching row's pin should be: its point (a
 *  stored one first, then the area's centre, then the district's) and whether
 *  that point is approximate — or no pin at all. */
async function expectedPins(prefix: string): Promise<{
  placed: Map<string, { precision: string; lng: number; lat: number }>;
  unplaced: string[];
}> {
  const { rows } = await pg.query<{ id: string; precision: string | null; lng: number | null; lat: number | null }>(
    `select p.id::text as id,
            case when p.location is not null then case when p.location_approx then 'approximate' else 'exact' end
                 when a.centroid is not null or d.centroid is not null then 'approximate'
            end as precision,
            st_x(coalesce(p.location, a.centroid, d.centroid)::geometry) as lng,
            st_y(coalesce(p.location, a.centroid, d.centroid)::geometry) as lat
       from properties p
       left join areas a on a.id = p.area_id
       left join districts d on d.id = p.district_id
      where p.org_id = $1 and p.reference like $2 || '%'`,
    [ORG, prefix],
  );
  const placed = new Map<string, { precision: string; lng: number; lat: number }>();
  const unplaced: string[] = [];
  for (const r of rows) {
    if (r.precision === null) unplaced.push(r.id);
    else placed.set(r.id, { precision: r.precision, lng: Number(r.lng), lat: Number(r.lat) });
  }
  return { placed, unplaced };
}

const ids: Record<"exact" | "stored" | "area" | "district" | "nowhere", string> = {
  exact: "",
  stored: "",
  area: "",
  district: "",
  nowhere: "",
};

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  await ensureTestOrg(svc, ORG, `Map page ${RUN}`, SLUG);
  admin = await createTestUser(svc, `mp-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);

  // Paphos with a centre, an area in it with its own centre, and a district
  // with none — the three ways a row without a point can (or cannot) be placed
  const paphos = (
    await pg.query<{ id: string }>(
      `update districts set centroid = st_setsrid(st_makepoint(32.42, 34.77), 4326)::geography
        where org_id = $1 and code = 'PAF' returning id::text as id`,
      [ORG],
    )
  ).rows[0]!.id;
  const nowhere = (
    await pg.query<{ id: string }>(
      `insert into districts (org_id, code, name, sort_order) values ($1, 'NOC', '{"en":"No centre"}', 9)
       returning id::text as id`,
      [ORG],
    )
  ).rows[0]!.id;
  const area = (
    await pg.query<{ id: string }>(
      `insert into areas (org_id, district_id, name, centroid)
       values ($1, $2, '{"en":"Kissonerga"}', st_setsrid(st_makepoint(32.39, 34.82), 4326)::geography)
       returning id::text as id`,
      [ORG, paphos],
    )
  ).rows[0]!.id;

  const insert = async (
    suffix: string,
    cols: { district: string; area?: string; point?: [number, number]; approx?: boolean },
  ) =>
    (
      await pg.query<{ id: string }>(
        `insert into properties (org_id, reference, property_type, status, district_id, area_id,
                                 location, location_approx, asking_price, title)
         values ($1, $2, 'villa', 'available', $3, $4,
                 case when $5::float8 is null then null
                      else st_setsrid(st_makepoint($5::float8, $6::float8), 4326)::geography end,
                 $7, 250000, '{"en":"Map page villa"}')
         returning id::text as id`,
        [
          ORG,
          `${PFX}-${suffix}`,
          cols.district,
          cols.area ?? null,
          cols.point?.[0] ?? null,
          cols.point?.[1] ?? null,
          cols.approx ?? false,
        ],
      )
    ).rows[0]!.id;

  ids.exact = await insert("1-EXACT", { district: paphos, point: [32.4012, 34.7511] });
  // what "take the area centre" on the details form saves (0054)
  ids.stored = await insert("2-STORED", { district: paphos, area, point: [32.39, 34.82], approx: true });
  ids.area = await insert("3-AREA", { district: paphos, area });
  ids.district = await insert("4-DISTRICT", { district: paphos });
  ids.nowhere = await insert("5-NOWHERE", { district: nowhere });

  // 1,005 placed listings, each with its own point
  await pg.query(
    `insert into properties (org_id, reference, property_type, status, district_id, location)
     select $1::uuid, format('%s-%s', $2::text, lpad(g::text, 4, '0')), 'apartment', 'available', $3::uuid,
            st_setsrid(st_makepoint(32.3 + g * 0.0001, 34.7), 4326)::geography
       from generate_series(1, $4::int) g`,
    [ORG, BULK, paphos, N_BULK],
  );
}, 180_000);

afterAll(async () => {
  await pg.query("delete from properties where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "areas", "districts"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
}, 120_000);

describe("the map page hands the map what the database holds (F08)", () => {
  it("a stored area centre is approximate, an unflagged stored point exact, centroids approximate — as the database says", async () => {
    const want = await expectedPins(PFX);
    const screen = await mapScreen(admin, { q: PFX });
    const got = new Map(screen.pins.map((p) => [p.id, p]));
    console.log(
      `[evidence] pins ${screen.pins.map((p) => `${Object.entries(ids).find(([, v]) => v === p.id)?.[0]}=${p.precision}`).join(" ")}; ` +
        `database: ${[...want.placed].map(([id, w]) => `${Object.entries(ids).find(([, v]) => v === id)?.[0]}=${w.precision}`).join(" ")}`,
    );

    // the case F08 fixed, named on its own so a regression says which
    expect(want.placed.get(ids.stored)?.precision, "the fixture: a stored centre").toBe("approximate");
    expect(got.get(ids.stored)?.precision, "a stored area centre (location_approx) is NOT a surveyed point").toBe(
      "approximate",
    );
    expect(got.get(ids.exact)?.precision).toBe("exact");

    // and every pin, against the database
    expect(new Set(got.keys())).toEqual(new Set(want.placed.keys()));
    for (const [id, w] of want.placed) {
      const pin = got.get(id)!;
      expect(pin.precision, `precision of ${id}`).toBe(w.precision);
      expect(pin.coordinates[0], `lng of ${id}`).toBeCloseTo(w.lng, 9);
      expect(pin.coordinates[1], `lat of ${id}`).toBeCloseTo(w.lat, 9);
    }
    // the read asked for the column at all
    expect(screen.reads[0]?.get("select") ?? "").toMatch(/\blocation_approx\b/);
  });

  it("says how many it could not place, and hands the map the same count", async () => {
    const want = await expectedPins(PFX);
    const screen = await mapScreen(admin, { q: PFX });
    console.log(
      `[evidence] "${screen.placement}"; map.unplaced=${String(screen.unplaced)}; database: ${want.placed.size} placeable, ${want.unplaced.length} not`,
    );
    expect(want.unplaced).toEqual([ids.nowhere]);
    expect(screen.pins.map((p) => p.id)).not.toContain(ids.nowhere);
    expect(screen.placement).toBe(`${want.placed.size} on the map · ${want.unplaced.length} without a location`);
    expect(screen.placement).toBe("4 on the map · 1 without a location");
    expect(screen.unplaced).toBe(1);
  });

  it("hands the map the list under the same filters — the header's List link", async () => {
    const params = { q: PFX, transaction: "sale", type: "villa" };
    const screen = await mapScreen(admin, params);
    console.log(`[evidence] listHref=${String(screen.listHref)}; header List=${screen.headerListHref}`);
    expect(screen.listHref).toBe(`/properties?${new URLSearchParams(params)}`);
    expect(screen.headerListHref).toBe(screen.listHref);
    // the filters are applied, not just carried: the five villas match, four
    // of them can be placed
    expect(screen.pins).toHaveLength(4);
    expect(screen.unplaced).toBe(1);
  });

  it(`reads every matching row past PostgREST's 1,000 — ${N_BULK} placed listings are ${N_BULK} pins, each once`, async () => {
    const want = await expectedPins(BULK);
    const screen = await mapScreen(admin, { q: BULK });
    const pinIds = screen.pins.map((p) => p.id);
    const reads = screen.reads.map((r) => `order=${r.get("order")} offset=${r.get("offset")} limit=${r.get("limit")}`);
    console.log(
      `[evidence] ${pinIds.length} pins (${new Set(pinIds).size} distinct) for ${want.placed.size} matching rows; "${screen.placement}"; reads: ${reads.join(" | ")}`,
    );
    expect(want.placed.size).toBe(N_BULK);
    expect(pinIds).toHaveLength(N_BULK);
    expect(new Set(pinIds)).toEqual(new Set(want.placed.keys()));
    expect(screen.placement).toBe(`${N_BULK} on the map · 0 without a location`);
    // paged over a unique order, advancing by what arrived, until an empty page
    expect(screen.reads.map((r) => r.get("order"))).toEqual(Array(screen.reads.length).fill("reference.asc,id.asc"));
    expect(screen.reads.map((r) => r.get("offset"))).toEqual(["0", "1000", String(N_BULK)]);
  }, 120_000);
});
