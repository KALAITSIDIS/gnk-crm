import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
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
 * The properties list as a self-describing saved view (A03) — land filters,
 * sorts, the view's name — through the REAL list page, its generateMetadata,
 * the map page and the CSV export route, against a REAL PostgREST, with real
 * aal2 sessions.
 *
 * At 66a4f09 the list had no plot or density filter (the columns existed and
 * the land panel filled them), one fixed order (created_at desc, id), a header
 * that said only "N properties", one document title for every page of the
 * app, and a Beds filter that crashed the list and the map past int4.
 *
 * WHAT IT PINS (each case prints one `[evidence]` line):
 *   1. "Paphos land, plot 1,500–6,000 m², density ≥ 90%, largest plot first"
 *      lists exactly the database's matching set in the database's order —
 *      a listing with no plot or no density recorded is NOT in it, nor is a
 *      withdrawn one or another organisation's; the request carries the three
 *      bounds and orders `plot_area_sqm.desc.nullslast,id.asc`;
 *   2. the page names the view under its heading and in its document title,
 *      with the district's own name; the map names it the same way;
 *   3. the map's pins and the CSV's rows are that same set (the CSV in the
 *      list's order), and the export's audit line records the three bounds as
 *      numbers and no sort;
 *   4. every sort, walked page by page over records that tie on the sort key
 *      and have unknown values, shows each record exactly once in the
 *      database's `order by <col> <dir> nulls last, id`; the request says so;
 *      the CSV of each sort has the walk's order;
 *   5. the default (no `sort`) still sends exactly `created_at.desc,id.asc`;
 *   6. a price sort under "Rent" orders by the monthly rent — and the Price
 *      column SHOWS the monthly rent, a sale_or_rent row's too, so the
 *      figures on screen are in the order the list claims (A03 review);
 *   7. the table's sortable headers carry the links and `aria-sort` the URL
 *      implies; a land list makes "Plot m²" sortable;
 *   8. a Beds value past int4 no longer throws the list or the map: it is no
 *      filter at all (it was 400 22003 → the error boundary).
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const ORGS = [ORG, OTHER_ORG];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `list-views-${RUN}`;
const PAGE_SIZE = 25;

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

import PropertiesPage, { generateMetadata as listMetadata } from "@/app/(app)/properties/page";
import PropertiesMapPage, { generateMetadata as mapMetadata } from "@/app/(app)/properties/map/page";
import { GET as propertiesExport } from "@/app/(app)/properties/export/route";
import { priceCell, PropertiesTable, type PropertyRow } from "@/components/features/properties/list";
import { PropertyMap } from "@/components/features/properties/map-view";
import type { ColumnSort } from "@/lib/queries/properties-list";
import { PROPERTY_SORTS, type PropertySort } from "@/lib/validators/properties";

type Params = Record<string, string>;

// ---------------------------------------------------------------------------
// A real session per user; every REST request it sends is recorded
// ---------------------------------------------------------------------------
type Session = { client: SupabaseClient; requests: { method: string; url: string }[] };
const sessions = new Map<TestUser, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const requests: Session["requests"] = [];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/rest/v1/")) requests.push({ method: (init?.method ?? "GET").toUpperCase(), url });
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  const out = { client, requests };
  sessions.set(user, out);
  return out;
}

// ---------------------------------------------------------------------------
// Reading what a page returned — its element tree, no rendering
// ---------------------------------------------------------------------------
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

const HEADER = /^(\d+) (?:archived )?(?:listings & developments|listing or development)(?: · |$)/;

interface ListScreen {
  ids: string[];
  total: number;
  pageCount: number;
  description: string | null;
  sorts: Partial<Record<string, ColumnSort>>;
  land: boolean;
  /** the table's price context: the monthly rent under "Rent" */
  rent: boolean;
  /** the rows the table was handed */
  rows: PropertyRow[];
  /** the list read's `order` parameter */
  order: string | null;
  /** the list read's query, decoded */
  listQuery: URLSearchParams | null;
}

async function listPage(user: TestUser, params: Params): Promise<ListScreen> {
  const { client, requests } = await session(user);
  requests.length = 0;
  const root = (await ctx.als.run(client, () =>
    PropertiesPage({ searchParams: Promise.resolve({ view: "table", ...params }) }),
  )) as ReactNode;
  const els = [...walk(root)];
  const header = els.find((e) => e.type === "p" && HEADER.test(textOf(e)));
  if (!header) throw new Error(`the page stated no total: ${textOf(root).slice(0, 300)}`);
  const pages = els.map((e) => /^Page (\d+) of (\d+)$/.exec(textOf(e))).find(Boolean);
  const table = els.find((e) => e.type === PropertiesTable);
  const description = els.find((e) => e.props["data-testid"] === "properties-view-description");
  const list = requests
    .filter((r) => r.method === "GET" && /\/rest\/v1\/properties\?/.test(r.url))
    .map((r) => new URL(r.url))
    .find((u) => u.searchParams.get("limit") === String(PAGE_SIZE));
  return {
    ids: table ? (table.props.rows as { id: string }[]).map((r) => r.id) : [],
    total: Number(HEADER.exec(textOf(header))![1]),
    pageCount: pages ? Number(pages[2]) : 1,
    description: description ? textOf(description) : null,
    sorts: (table?.props.sorts ?? {}) as Partial<Record<string, ColumnSort>>,
    land: Boolean(table?.props.land),
    rent: Boolean(table?.props.rent),
    rows: table ? (table.props.rows as PropertyRow[]) : [],
    order: list?.searchParams.get("order") ?? null,
    listQuery: list?.searchParams ?? null,
  };
}

/** Page 1, then every page it says there is; the ids in the order shown. */
async function walkList(user: TestUser, params: Params): Promise<{ ids: string[]; pages: ListScreen[] }> {
  const pages = [await listPage(user, params)];
  for (let p = 2; p <= pages[0]!.pageCount; p++) pages.push(await listPage(user, { ...params, page: String(p) }));
  return { ids: pages.flatMap((s) => s.ids), pages };
}

async function titleOf(user: TestUser, params: Params, which: "list" | "map" = "list"): Promise<string> {
  const { client } = await session(user);
  const meta = await ctx.als.run(client, () =>
    (which === "list" ? listMetadata : mapMetadata)({ searchParams: Promise.resolve({ ...params }) }),
  );
  return String(meta.title);
}

async function mapView(user: TestUser, params: Params): Promise<{ pins: string[]; description: string | null }> {
  const { client } = await session(user);
  const root = (await ctx.als.run(client, () =>
    PropertiesMapPage({ searchParams: Promise.resolve({ ...params }) }),
  )) as ReactNode;
  const els = [...walk(root)];
  const map = els.find((e) => e.type === PropertyMap);
  if (!map) throw new Error("the map page rendered no map");
  const description = els.find((e) => e.props["data-testid"] === "properties-view-description");
  return {
    pins: (map.props.data as { features: { properties: { id: string } }[] }).features.map((f) => f.properties.id),
    description: description ? textOf(description) : null,
  };
}

async function exportRefs(user: TestUser, params: Params): Promise<{ status: number; refs: string[] }> {
  const { client } = await session(user);
  const url = new URL("http://localhost/properties/export");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await ctx.als.run(client, () => propertiesExport(new NextRequest(url)));
  const body = (await res.text()).replace(/^﻿/, "");
  const lines = body.split("\r\n").filter(Boolean);
  // references are the first column and never carry a comma or a quote here
  return { status: res.status, refs: lines.slice(1).map((l) => l.split(",")[0]!) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
const userIds: string[] = [];
let paphos = "";
let limassol = "";

/** The default scope as SQL: every kind but units, nothing retired. */
const ACTIVE = "p.org_id = $1 and p.kind <> 'unit' and p.status <> 'withdrawn' and p.visibility <> 'archived'";

/** The database's own order for each sort: unknown values last, then id. */
const SQL_ORDER: Record<PropertySort, string> = {
  newest: "p.created_at desc, p.id",
  updated: "p.updated_at desc nulls last, p.id",
  price_asc: "p.asking_price asc nulls last, p.id",
  price_desc: "p.asking_price desc nulls last, p.id",
  plot_asc: "p.plot_area_sqm asc nulls last, p.id",
  plot_desc: "p.plot_area_sqm desc nulls last, p.id",
  score_asc: "p.quality_score asc nulls last, p.id",
  score_desc: "p.quality_score desc nulls last, p.id",
  reference: "p.reference asc nulls last, p.id",
  reference_desc: "p.reference desc nulls last, p.id",
};

/** What each sort must send PostgREST. */
const WIRE_ORDER: Record<PropertySort, string> = {
  newest: "created_at.desc,id.asc",
  updated: "updated_at.desc.nullslast,id.asc",
  price_asc: "asking_price.asc.nullslast,id.asc",
  price_desc: "asking_price.desc.nullslast,id.asc",
  plot_asc: "plot_area_sqm.asc.nullslast,id.asc",
  plot_desc: "plot_area_sqm.desc.nullslast,id.asc",
  score_asc: "quality_score.asc.nullslast,id.asc",
  score_desc: "quality_score.desc.nullslast,id.asc",
  reference: "reference.asc.nullslast,id.asc",
  reference_desc: "reference.desc.nullslast,id.asc",
};

async function expected(where: string, order: string, params: unknown[] = []): Promise<{ ids: string[]; refs: string[] }> {
  const { rows } = await pg.query<{ id: string; reference: string }>(
    `select p.id::text as id, p.reference from properties p where ${ACTIVE} and (${where}) order by ${order}`,
    [ORG, ...params],
  );
  return { ids: rows.map((r) => r.id), refs: rows.map((r) => r.reference) };
}

/** The business example, as SQL. */
const LAND_EXAMPLE = `p.district_id = $2 and p.property_type = 'land'
  and p.plot_area_sqm >= 1500 and p.plot_area_sqm <= 6000 and p.building_density_pct >= 90`;
const LAND_PARAMS = (district: string): Params => ({
  district,
  type: "land",
  plot_min: "1500",
  plot_max: "6000",
  density_min: "90",
  sort: "plot_desc",
});

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  await ensureTestOrg(svc, ORG, `List views ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER_ORG, `List views other ${RUN}`, `${SLUG}-other`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `lv-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `lv-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);

  paphos = (await pg.query<{ id: string }>("select id::text as id from districts where org_id = $1 and code = 'PAF'", [ORG])).rows[0]!.id;
  limassol = (
    await pg.query<{ id: string }>(
      `insert into districts (org_id, code, name, sort_order) values ($1, 'LIM', '{"en":"Limassol"}', 2) returning id::text as id`,
      [ORG],
    )
  ).rows[0]!.id;
  const otherPaphos = (await pg.query<{ id: string }>("select id::text as id from districts where org_id = $1 and code = 'PAF'", [OTHER_ORG])).rows[0]!.id;

  const AT = "2026-01-01 09:00:00+00";
  // Land: 36 plots. Plots repeat every 12 (ties on the sort key) and every
  // ninth is unknown; densities spread 0–159 with every seventh unknown;
  // every fourth plot is in Limassol; prices repeat and every fifth is unknown.
  await pg.query(
    `insert into properties (org_id, reference, property_type, transaction_type, status, district_id,
                             plot_area_sqm, building_density_pct, asking_price, quality_score,
                             location, created_at, updated_at)
     select $1::uuid, format('LD%s-%s', $2::text, lpad(g::text, 3, '0')), 'land', 'sale', 'available',
            case when g % 4 = 0 then $4::uuid else $3::uuid end,
            case when g % 9 = 0 then null else (g % 12) * 500 + 500 end,
            case when g % 7 = 0 then null else (g * 13) % 160 end,
            case when g % 5 = 0 then null else (g % 6) * 50000 + 50000 end,
            (g % 4) * 25,
            st_setsrid(st_makepoint(32.4 + g * 0.001, 34.8), 4326)::geography,
            $5::timestamptz + case when g % 7 = 0 then interval '1 day' else interval '0' end,
            $5::timestamptz + (g % 3) * interval '1 day'
       from generate_series(1, 36) g`,
    [ORG, TAG, paphos, limassol, AT],
  );
  // Apartments: sale, rent and sale-or-rent in turn, prices and rents tied,
  // some unknown
  await pg.query(
    `insert into properties (org_id, reference, property_type, transaction_type, status, district_id,
                             bedrooms, asking_price, rent_price_month, quality_score,
                             location, created_at, updated_at)
     select $1::uuid, format('AP%s-%s', $2::text, lpad(g::text, 3, '0')), 'apartment',
            (array['rent','sale','sale_or_rent']::transaction_type[])[1 + g % 3], 'available', $3::uuid,
            1 + g % 4,
            case when g % 3 = 0 or g % 10 = 1 then null else (g % 5) * 100000 + 100000 end,
            case when g % 3 = 1 then null else (g % 4) * 500 + 500 end,
            (g % 4) * 25,
            st_setsrid(st_makepoint(32.5 + g * 0.001, 34.8), 4326)::geography,
            $4::timestamptz, $4::timestamptz + (g % 5) * interval '1 day'
       from generate_series(1, 30) g`,
    [ORG, TAG, paphos, AT],
  );
  // a withdrawn plot that matches the example: the default scope leaves it out
  await pg.query(
    `insert into properties (org_id, reference, property_type, status, district_id, plot_area_sqm, building_density_pct, created_at)
     values ($1, $2, 'land', 'withdrawn', $3, 3000, 95, $4)`,
    [ORG, `LW${TAG}-001`, paphos, AT],
  );
  // OTHER_ORG: plots that match the example, newer and cheaper than all of
  // ORG's — a leak would land first in every walk
  await pg.query(
    `insert into properties (org_id, reference, property_type, status, district_id, plot_area_sqm,
                             building_density_pct, asking_price, location, created_at)
     select $1::uuid, format('XL%s-%s', $2::text, g), 'land', 'available', $3::uuid, 3000, 95, 1,
            st_setsrid(st_makepoint(32.6, 34.8), 4326)::geography, '2026-06-01 09:00:00+00'
       from generate_series(1, 5) g`,
    [OTHER_ORG, TAG, otherPaphos],
  );
  await pg.query("analyze properties;");
}, 300_000);

afterAll(async () => {
  await pg.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "areas", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await pg.end();
}, 300_000);

// ---------------------------------------------------------------------------
describe("the properties list as a self-describing saved view (A03)", () => {
  it("the fixture is what the cases assume", async () => {
    const { rows } = await pg.query<{ land: string; nullplot: string; nulldensity: string; example: string; ties: string }>(
      `select count(*) filter (where property_type = 'land') as land,
              count(*) filter (where property_type = 'land' and plot_area_sqm is null) as nullplot,
              count(*) filter (where property_type = 'land' and building_density_pct is null) as nulldensity,
              count(*) filter (where district_id = $2 and property_type = 'land' and plot_area_sqm between 1500 and 6000
                                 and building_density_pct >= 90 and status <> 'withdrawn') as example,
              (select max(n) from (select count(*) as n from properties where org_id = $1 and asking_price is not null
                                   group by asking_price) t) as ties
         from properties where org_id = $1`,
      [ORG, paphos],
    );
    const r = rows[0]!;
    console.log(
      `[evidence] fixture: land ${r.land} (plot unknown ${r.nullplot}, density unknown ${r.nulldensity}), example matches ${r.example}, largest price tie ${r.ties}`,
    );
    expect(Number(r.land)).toBe(37);
    expect(Number(r.nullplot)).toBeGreaterThan(2);
    expect(Number(r.nulldensity)).toBeGreaterThan(2);
    expect(Number(r.example), "the example matches a handful, on one page").toBeGreaterThanOrEqual(3);
    expect(Number(r.example)).toBeLessThan(PAGE_SIZE);
    expect(Number(r.ties), "prices tie, so the id tie-breaker decides").toBeGreaterThan(3);
  });

  it("Paphos land, plot 1,500–6,000 m², density ≥ 90%, largest plot first: exactly the database's set, in its order", async () => {
    const want = await expected(LAND_EXAMPLE, SQL_ORDER.plot_desc, [paphos]);
    // what the bounds leave out: unknown plot or density, a plot outside them, another district, another org
    const { rows: unknown } = await pg.query<{ id: string }>(
      `select p.id::text as id from properties p where ${ACTIVE} and p.district_id = $2 and p.property_type = 'land'
          and (p.plot_area_sqm is null or p.building_density_pct is null)`,
      [ORG, paphos],
    );
    const { rows: elsewhere } = await pg.query<{ id: string }>(
      "select id::text as id from properties where org_id = $1 or status = 'withdrawn'",
      [OTHER_ORG],
    );
    const page = await listPage(admin, LAND_PARAMS(paphos));
    console.log(
      `[evidence] land example: stated ${page.total}, shown ${page.ids.length} (database ${want.ids.length}); order=${page.order}; ` +
        `bounds on the wire ${page.listQuery?.getAll("plot_area_sqm").join("&")} ${page.listQuery?.get("building_density_pct")}`,
    );
    expect(page.total).toBe(want.ids.length);
    expect(page.ids).toEqual(want.ids);
    expect(page.order).toBe("plot_area_sqm.desc.nullslast,id.asc");
    expect(page.listQuery?.getAll("plot_area_sqm").sort()).toEqual(["gte.1500", "lte.6000"]);
    expect(page.listQuery?.get("building_density_pct")).toBe("gte.90");
    expect(unknown.length, "the fixture has plots with an unknown figure").toBeGreaterThan(0);
    for (const { id } of unknown) expect(page.ids, "an unknown plot or density is never a match").not.toContain(id);
    for (const { id } of elsewhere) expect(page.ids, "withdrawn or another organisation's").not.toContain(id);
    // the table is the land table: Plot m² sorts, and is the current sort
    expect(page.land).toBe(true);
    expect(page.sorts.plot?.direction).toBe("descending");
    expect(new URL(page.sorts.plot!.href, "http://x").searchParams.get("sort")).toBe("plot_asc");
  }, 60_000);

  it("the view names itself — under its heading and in its document title, with the district's own name", async () => {
    const words = "Paphos · Land · plot 1.500–6.000 m² · density ≥ 90% · sorted by plot ↓";
    const page = await listPage(admin, LAND_PARAMS(paphos));
    const title = await titleOf(admin, LAND_PARAMS(paphos));
    const map = await mapView(admin, LAND_PARAMS(paphos));
    const mapTitle = await titleOf(admin, LAND_PARAMS(paphos), "map");
    console.log(`[evidence] described: "${page.description}"; title "${title}"; map "${map.description}" / "${mapTitle}"`);
    expect(page.description).toBe(words);
    expect(title).toBe(`Properties · ${words}`);
    // the map has no order and no pages: it names the filters only
    expect(map.description).toBe("Paphos · Land · plot 1.500–6.000 m² · density ≥ 90%");
    expect(mapTitle).toBe("Properties map · Paphos · Land · plot 1.500–6.000 m² · density ≥ 90%");
    // the default view: no description, the plain name
    expect((await listPage(admin, {})).description).toBeNull();
    expect(await titleOf(admin, {})).toBe("Properties");
    expect(await titleOf(admin, { district: limassol, page: "2" })).toBe("Properties · Limassol · page 2");
  }, 60_000);

  it("the map's pins and the CSV's rows are the list's set — the CSV in the list's order — and the audit records the bounds as numbers", async () => {
    const want = await expected(LAND_EXAMPLE, SQL_ORDER.plot_desc, [paphos]);
    const map = await mapView(admin, LAND_PARAMS(paphos));
    const csv = await exportRefs(admin, LAND_PARAMS(paphos));
    const { rows: audit } = await pg.query<{ payload: { count: number; filters?: Record<string, unknown> } }>(
      "select payload from events where org_id = $1 and event_type = 'exported' order by occurred_at desc limit 1",
      [ORG],
    );
    console.log(
      `[evidence] land example: map ${map.pins.length} pins, CSV ${csv.status} ${csv.refs.length} rows, audit ${JSON.stringify(audit[0]?.payload)} (database ${want.ids.length})`,
    );
    expect([...map.pins].sort()).toEqual([...want.ids].sort());
    expect(csv.status).toBe(200);
    expect(csv.refs).toEqual(want.refs);
    expect(audit[0]!.payload.count).toBe(want.ids.length);
    expect(audit[0]!.payload.filters).toEqual({
      district: paphos,
      type: "land",
      plot_min: 1500,
      plot_max: 6000,
      density_min: 90,
      scope: "active",
    });
  }, 60_000);

  it("an agent sees the same land view (properties are org-wide)", async () => {
    const want = await expected(LAND_EXAMPLE, SQL_ORDER.plot_desc, [paphos]);
    const page = await listPage(agent, LAND_PARAMS(paphos));
    console.log(`[evidence] land example as agent: ${page.ids.length} (database ${want.ids.length})`);
    expect(page.ids).toEqual(want.ids);
  }, 60_000);

  for (const sort of PROPERTY_SORTS) {
    it(`sort=${sort}: every record once, in the database's order, page by page — and the CSV in the same order`, async () => {
      const want = await expected("true", SQL_ORDER[sort]);
      const params: Params = sort === "newest" ? {} : { sort };
      const w = await walkList(admin, params);
      const csv = await exportRefs(admin, params);
      const orders = [...new Set(w.pages.map((p) => p.order))];
      const same = JSON.stringify(w.ids) === JSON.stringify(want.ids);
      console.log(
        `[evidence] sort=${sort}: pages ${w.pages.length}, shown ${w.ids.length}, distinct ${new Set(w.ids).size} (database ${want.ids.length}), ` +
          `database order ${same ? "yes" : "NO"}, order=${orders.join("|")}, CSV ${csv.refs.length} same order ${JSON.stringify(csv.refs) === JSON.stringify(want.refs) ? "yes" : "NO"}`,
      );
      expect(want.ids.length, "the walk spans pages").toBeGreaterThan(2 * PAGE_SIZE);
      expect(w.pages[0]!.total).toBe(want.ids.length);
      expect(new Set(w.ids).size, "no record on two pages").toBe(w.ids.length);
      expect(w.ids).toEqual(want.ids);
      w.pages.forEach((p, i) => expect(p.ids, `page ${i + 1} is exactly its slice`).toEqual(want.ids.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)));
      expect(orders).toEqual([WIRE_ORDER[sort]]);
      expect(csv.status).toBe(200);
      expect(csv.refs).toEqual(want.refs);
    }, 120_000);
  }

  it("a price sort under Rent orders by the monthly rent, unknown rents last", async () => {
    const want = await expected(
      "p.transaction_type in ('rent', 'sale_or_rent')",
      "p.rent_price_month desc nulls last, p.id",
    );
    const w = await walkList(admin, { transaction: "rent", sort: "price_desc" });
    console.log(`[evidence] rent price_desc: shown ${w.ids.length} (database ${want.ids.length}), order=${w.pages[0]!.order}, described "${w.pages[0]!.description}"`);
    expect(w.ids).toEqual(want.ids);
    expect(w.pages[0]!.order).toBe("rent_price_month.desc.nullslast,id.asc");
    expect(w.pages[0]!.description).toBe("For rent · sorted by rent ↓");

    // what the Price column shows is what it is sorted by: the monthly rent,
    // a sale_or_rent row's included — it showed that row's asking price
    const shown = w.pages.flatMap((p) => {
      expect(p.rent, "the table is told it is the Rent list").toBe(true);
      return p.rows.map((r) => ({ r, text: priceCell(r, p.rent) }));
    });
    // the review's case: a sale_or_rent row carrying BOTH figures
    const saleOrRent = shown.filter(
      ({ r }) => r.transaction_type === "sale_or_rent" && r.rent_price_month !== null && r.asking_price !== null,
    );
    console.log(`[evidence] rent price_desc: ${saleOrRent.length} sale_or_rent rows with both figures; the first shows "${saleOrRent[0]?.text}", not its asking "${saleOrRent[0] ? priceCell(saleOrRent[0].r) : ""}"`);
    expect(saleOrRent.length, "the fixture has sale_or_rent rows with a rent and an asking price").toBeGreaterThan(0);
    for (const { r, text } of saleOrRent) expect(text).not.toBe(priceCell(r));
    const figures = shown.map(({ r, text }) => {
      if (r.rent_price_month === null) {
        expect(text).toBe("—");
        return null;
      }
      expect(text).toMatch(/\/mo$/);
      return Number(text.replace(/[^\d,]/g, "").replace(",", "."));
    });
    const known = figures.filter((n): n is number => n !== null);
    expect(known, "the figures on screen descend, as the sort says").toEqual([...known].sort((a, b) => b - a));
    // unknown rents last, as ordered
    expect(figures.slice(known.length).every((n) => n === null)).toBe(true);

    // and nothing changes without the Rent filter
    const sale = await listPage(admin, { sort: "price_desc" });
    expect(sale.rent).toBe(false);
  }, 60_000);

  it("the sortable headers: a link to the next sort with every filter kept and no page; aria-sort on the current one", async () => {
    const page = await listPage(admin, { district: paphos, sort: "price_asc", page: "2" });
    const link = (column: string) => {
      const s = page.sorts[column];
      return s ? { direction: s.direction, params: Object.fromEntries(new URL(s.href, "http://x").searchParams) } : null;
    };
    console.log(`[evidence] headers on sort=price_asc page 2: ${JSON.stringify(page.sorts)}`);
    expect(link("price")).toEqual({ direction: "ascending", params: { view: "table", district: paphos, sort: "price_desc" } });
    expect(link("reference")).toEqual({ direction: null, params: { view: "table", district: paphos, sort: "reference" } });
    expect(link("score")).toEqual({ direction: null, params: { view: "table", district: paphos, sort: "score_asc" } });
    // not a land list: the Area column mixes covered and plot areas, so it does not sort
    expect(page.land).toBe(false);
    expect(page.sorts.plot).toBeUndefined();
  }, 60_000);

  it("a Beds value past int4 is no filter — the list and the map render instead of throwing (was 400 22003)", async () => {
    const all = await listPage(admin, {});
    const huge = await listPage(admin, { beds: "2147483648" });
    const map = await mapView(admin, { beds: "1e300" });
    const capped = await listPage(admin, { beds: "99" });
    console.log(`[evidence] beds=2147483648: stated ${huge.total} (no filter ${all.total}), wire beds ${huge.listQuery?.get("bedrooms")}; map beds=1e300 ${map.pins.length} pins; beds=99 stated ${capped.total}`);
    expect(huge.total).toBe(all.total);
    expect(huge.listQuery?.get("bedrooms")).toBeNull();
    expect(map.pins.length).toBeGreaterThan(0);
    expect(capped.total).toBe(0);
    expect(capped.listQuery?.get("bedrooms")).toBe("gte.99");
  }, 60_000);
});
