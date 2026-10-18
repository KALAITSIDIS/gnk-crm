import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * F07 through the REAL property page, the REAL Details action and a REAL
 * PostgREST + Postgres behind the local gateway, as an aal2 admin session:
 *
 *   1. the quality ring on the detail page is the STORED score — computed
 *      through buildQualityInput like the list, the worklist and the gate —
 *      for a listing whose map point is an approximate centroid (0054). At
 *      66a4f09 the page built its own input, counted the centroid as an exact
 *      location and showed 10 points more than everything else;
 *   2. a plot's Overview shows its planning terms, frontage and utilities in
 *      place of "Bedrooms / Bathrooms", and calls its area the plot;
 *   3. a Details save of that plot, posting what the per-type form posts
 *      (lib/testing/details-form-post — the collapsed groups included, as a
 *      browser sends a closed <details>), changes the one field edited and
 *      nothing else: the collapsed bedroom count, the features, a recorded
 *      utility and an UNRECORDED one survive, and the `updated` event names
 *      only the density. An untouched save writes nothing at all;
 *   4. a flat's save never writes the land panel, whatever stray values its
 *      row holds.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `details-layout-${RUN}`;

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
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/services/site-revalidate", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySiteAfter: vi.fn(),
  notifySiteIfPublic: vi.fn(async () => {}),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});

import PropertyDetailPage from "@/app/(app)/properties/[id]/page";
import { QualityScoreRing } from "@/components/features/shared/quality-score-ring";
import { updatePropertySection } from "@/lib/actions/properties";
import { recomputeQualityScore } from "@/lib/services/quality-score";
import { detailsFormPost } from "@/lib/testing/details-form-post";

// ---------------------------------------------------------------------------
let o: Client;
let svc: SupabaseClient;
let admin: TestUser;
const userIds: string[] = [];

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

async function renderPage(id: string): Promise<Element[]> {
  const root = (await ctx.als.run(admin.client, () =>
    PropertyDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
  )) as ReactNode;
  return [...walk(root)];
}

/** The Overview's facts, label → value, as the page renders them. */
function overviewFacts(tree: Element[]): Map<string, string> {
  const dts = tree.filter((e) => e.type === "dt").map((e) => String(e.props.children));
  const dds = tree.filter((e) => e.type === "dd").map((e) => String(e.props.children));
  expect(dts.length).toBe(dds.length);
  return new Map(dts.map((d, i) => [d, dds[i]!]));
}

let seq = 0;
async function insertProperty(cols: Record<string, unknown>): Promise<string> {
  const all: Record<string, unknown> = {
    org_id: ORG,
    reference: `DL${TAG}${String(++seq).padStart(3, "0")}`,
    status: "available",
    ...cols,
  };
  const names = Object.keys(all);
  const { rows } = await o.query<{ id: string }>(
    `insert into properties (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(all),
  );
  return rows[0]!.id;
}

/** The row as the page read it (select * through the session) — what the form was rendered from. */
async function rendered(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await admin.client.from("properties").select("*").eq("id", id).single();
  if (error) throw new Error(`read: ${error.message}`);
  return data as Record<string, unknown>;
}

async function save(fd: FormData) {
  return ctx.als.run(admin.client, () => updatePropertySection({ error: null, savedAt: null }, fd));
}

const updatedEvents = async (id: string) =>
  (
    await o.query<{ payload: { section: string; changed: Record<string, unknown> } }>(
      "select payload from events where org_id = $1 and entity_id = $2 and event_type = 'updated' order by id",
      [ORG, id],
    )
  ).rows.map((r) => r.payload);

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `Details layout ${RUN}`, SLUG);
  admin = await createTestUser(svc, `dl-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
}, 300_000);

afterAll(async () => {
  if (!o) return;
  await o.query("delete from properties where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await o.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await o.query("delete from organizations where id = $1", [ORG]);
  await o.end();
}, 120_000);

// ---------------------------------------------------------------------------
describe("the detail page's ring is the stored score (one definition)", () => {
  it("an approximate map point earns no 'Exact map location' points on the ring — as in the list, the worklist and the gate", async () => {
    const id = await insertProperty({
      property_type: "apartment",
      title: { en: "Approximate flat" },
      asking_price: 210000,
      covered_area_sqm: 85,
      bedrooms: 2,
      bathrooms: 1,
      // the area's centroid, taken as a stand-in (0054)
      location: "SRID=4326;POINT(32.4297 34.7720)",
      location_approx: true,
    });
    const fresh = await ctx.als.run(admin.client, () => recomputeQualityScore(admin.client as never, id));
    const stored = (await o.query<{ quality_score: number }>("select quality_score from properties where id = $1", [id]))
      .rows[0]!.quality_score;
    const ring = (await renderPage(id)).find((e) => e.type === QualityScoreRing);
    expect(ring, "the page rendered its ring").toBeDefined();
    const score = ring!.props.score as number;
    const missing = (ring!.props.missing as { key: string }[]).map((m) => m.key);
    console.log(`[evidence] approximate point: stored ${stored}, recomputed ${fresh?.score}, ring ${score}; ring missing ${missing.join(",")}`);
    expect(stored).toBe(fresh!.score);
    expect(score, "the ring shows the stored score").toBe(stored);
    expect(missing, "the centroid is not an exact location").toContain("coords");
  });

  it("an exact map point still earns them", async () => {
    const id = await insertProperty({
      property_type: "apartment",
      location: "SRID=4326;POINT(32.4297 34.7720)",
      location_approx: false,
    });
    await ctx.als.run(admin.client, () => recomputeQualityScore(admin.client as never, id));
    const stored = (await o.query<{ quality_score: number }>("select quality_score from properties where id = $1", [id]))
      .rows[0]!.quality_score;
    const ring = (await renderPage(id)).find((e) => e.type === QualityScoreRing)!;
    expect(ring.props.score).toBe(stored);
    expect((ring.props.missing as { key: string }[]).map((m) => m.key)).not.toContain("coords");
  });
});

describe("a plot of land", () => {
  let landId = "";
  beforeAll(async () => {
    // PAF0003's shape: a plot carrying a stray bedroom count and residential features
    landId = await insertProperty({
      property_type: "land",
      title: { en: "Plot near Tala" },
      asking_price: 180000,
      plot_area_sqm: 1200,
      planning_zone_code: "Κα6",
      building_density_pct: 60,
      coverage_ratio_pct: 35,
      road_frontage_m: 22.5,
      water_available: true,
      bedrooms: 2,
      features: ["sea_view", "furnished"],
    });
  });

  it("its Overview shows the plot, planning, frontage and utilities — not bedrooms", async () => {
    const facts = overviewFacts(await renderPage(landId));
    console.log(`[evidence] land overview: ${JSON.stringify(Object.fromEntries(facts))}`);
    expect(facts.get("Plot")).toBe("1.200 m²");
    expect(facts.get("Planning")).toBe("Κα6 · density 60% · coverage 35%");
    expect(facts.get("Road frontage")).toBe("22,5 m");
    expect(facts.get("Utilities")).toBe("Water: Yes · Electricity: not recorded");
    expect(facts.has("Bedrooms / Bathrooms")).toBe(false);
    expect(facts.has("Area")).toBe(false);
  });

  it("a Details save changing the density alone keeps everything else, and its event names only the density", async () => {
    const before = await rendered(landId);
    const res = await save(detailsFormPost(before, { building_density_pct: "55" }));
    expect(res.error).toBeNull();
    expect(res.notice ?? null).toBeNull();
    const { rows } = await o.query(
      `select building_density_pct::float8 as density, planning_zone_code, bedrooms, features, has_storage,
              water_available, electricity_available, plot_area_sqm::float8 as plot, coverage_ratio_pct::float8 as coverage
         from properties where id = $1`,
      [landId],
    );
    expect(rows[0]).toEqual({
      density: 55,
      planning_zone_code: "Κα6",
      bedrooms: 2,
      features: ["sea_view", "furnished"],
      has_storage: false,
      water_available: true,
      electricity_available: null,
      plot: 1200,
      coverage: 35,
    });
    const events = await updatedEvents(landId);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.changed)).toEqual(["building_density_pct"]);
  });

  it("an untouched save writes nothing — an unrecorded utility is not turned into a No", async () => {
    const before = await rendered(landId);
    const res = await save(detailsFormPost(before));
    expect(res.error).toBeNull();
    const after = await rendered(landId);
    expect(after.updated_at, "no write").toBe(before.updated_at);
    expect(after.electricity_available).toBeNull();
    expect(await updatedEvents(landId)).toHaveLength(1);
  });
});

describe("a flat", () => {
  it("never writes the land panel, whatever stray values its row holds", async () => {
    const id = await insertProperty({
      property_type: "apartment",
      bedrooms: 2,
      road_frontage_m: 9,
      water_available: true,
    });
    const before = await rendered(id);
    // a crafted post carrying land fields beside the one real edit
    const res = await save(detailsFormPost(before, { bedrooms: "3", road_frontage_m: "1", water_available: "no" }));
    expect(res.error).toBeNull();
    const { rows } = await o.query(
      "select bedrooms, road_frontage_m::float8 as frontage, water_available from properties where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ bedrooms: 3, frontage: 9, water_available: true });
    const events = await updatedEvents(id);
    expect(Object.keys(events[0]!.changed)).toEqual(["bedrooms"]);
  });
});

describe("the record", () => {
  it("the organisation's event chain verifies after everything above", async () => {
    const { rows } = await o.query("select ok, reason from public.verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
