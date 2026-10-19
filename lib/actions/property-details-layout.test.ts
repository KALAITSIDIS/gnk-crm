import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { detailsFormPost } from "@/lib/testing/details-form-post";

/**
 * F07 at the level the product uses it: the Details form, laid out per kind of
 * property, posted UNTOUCHED but for one field (lib/testing/details-form-post
 * mirrors what the browser sends — a closed native <details> still posts its
 * inputs), through the real `updatePropertySection`. What the action asks the
 * database to write, and what its `updated` event says moved.
 *
 * The database half — RLS, the 0152 trigger, the page that renders it — is
 * supabase/tests/property-details-layout.test.ts; the browser half is
 * tests/e2e/land-details.spec.ts.
 */
const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent, logEvents: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/services/site-revalidate", () => ({ notifySiteAfter: vi.fn() }));
vi.mock("@/lib/services/quality-score", () => ({
  recomputeQuietly: vi.fn(async () => undefined),
  refreshContainerScores: vi.fn(async () => undefined),
  computeQualityScore: vi.fn(() => ({ score: 100, items: [], missing: [], warnings: [] })),
  PUBLISH_THRESHOLD: 70,
}));

const { updatePropertySection } = await import("@/lib/actions/properties");

const UPDATED_AT = "2026-10-18T09:00:00.000000+00:00";

/** A stored row as `select *` returns it: every Details column present. */
function stored(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "prop-1",
    org_id: "org-1",
    reference: "PAF0003",
    kind: "standalone",
    property_type: "apartment",
    status: "available",
    visibility: "private",
    transaction_type: "sale",
    vat_status: "unknown",
    updated_at: UPDATED_AT,
    area_id: null,
    address: null,
    postal_code: null,
    sea_distance_m: null,
    amenities_notes: null,
    location: null,
    location_approx: false,
    asking_price: 180000,
    min_acceptable_price: null,
    owner_net_price: null,
    rent_price_month: null,
    covered_area_sqm: null,
    plot_area_sqm: null,
    veranda_sqm: null,
    roof_garden_sqm: null,
    basement_sqm: null,
    bedrooms: null,
    bathrooms: null,
    wc: null,
    parking_spaces: null,
    has_storage: false,
    floor_number: null,
    total_floors: null,
    year_built: null,
    energy_class: null,
    features: [],
    construction_status: null,
    delivery_date: null,
    internal_notes: null,
    planning_zone_code: null,
    building_density_pct: null,
    coverage_ratio_pct: null,
    max_floors: null,
    max_height_m: null,
    road_frontage_m: null,
    water_available: null,
    electricity_available: null,
    constraints_notes: null,
    inherited_fields: null,
    parent_id: null,
    ...over,
  };
}

/** PAF0003's shape: a plot carrying a stray bedroom count and residential features. */
const LAND = stored({
  property_type: "land",
  plot_area_sqm: 1200,
  planning_zone_code: "Κα6",
  building_density_pct: 60,
  coverage_ratio_pct: 35,
  road_frontage_m: 22.5,
  water_available: true,
  electricity_available: null,
  bedrooms: 2,
  features: ["sea_view", "furnished"],
  constraints_notes: "Archaeological zone B",
});

function setup(row: Record<string, unknown>) {
  const pages: FakePage[] = [
    { data: row, error: null }, // the read
    { data: [{ id: "prop-1" }], error: null }, // the UPDATE, one row
  ];
  const fake = fakeClient({ properties: pages });
  state.client = fake.client;
  return fake;
}

const writeOf = (fake: ReturnType<typeof setup>) =>
  (fake.argsOf("properties", "update")[0] as [Record<string, unknown>])[0];

function changed(): Record<string, unknown> {
  const e = logEvent.mock.calls.map((c) => c[1]).find((x) => x.eventType === "updated");
  expect(e, "the save logged an `updated` event").toBeDefined();
  return (e!.payload as { changed: Record<string, unknown> }).changed;
}

beforeEach(() => logEvent.mockClear());

describe("a plot's Details save keeps every value it did not change", () => {
  it("changing the density alone: the collapsed bedroom count, the features, the utilities and the planning terms are written back as they were, and the event names only the density", async () => {
    const fake = setup(LAND);
    const res = await updatePropertySection(
      { error: null, savedAt: null },
      detailsFormPost(LAND, { building_density_pct: "55" }),
    );
    expect(res.error).toBeNull();
    expect(writeOf(fake)).toMatchObject({
      building_density_pct: 55,
      bedrooms: 2,
      features: ["sea_view", "furnished"],
      water_available: true,
      electricity_available: null,
      planning_zone_code: "Κα6",
      plot_area_sqm: 1200,
      constraints_notes: "Archaeological zone B",
    });
    expect(Object.keys(changed())).toEqual(["building_density_pct"]);
    expect(changed().building_density_pct).toEqual({ from: 60, to: 55 });
  });

  it("an untouched save writes nothing and logs nothing — an unrecorded utility is not turned into a No", async () => {
    // before F07 the utilities were checkboxes: this save wrote
    // electricity_available false over null and logged it as a change
    const fake = setup(LAND);
    const res = await updatePropertySection({ error: null, savedAt: null }, detailsFormPost(LAND));
    expect(res.error).toBeNull();
    expect(res.savedAt).not.toBeNull();
    expect(fake.argsOf("properties", "update")).toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("the utilities can be answered, and un-answered", async () => {
    const fake = setup(LAND);
    await updatePropertySection(
      { error: null, savedAt: null },
      detailsFormPost(LAND, { water_available: "unknown", electricity_available: "yes" }),
    );
    expect(writeOf(fake)).toMatchObject({ water_available: null, electricity_available: true });
    expect(changed()).toEqual({
      water_available: { from: true, to: null },
      electricity_available: { from: null, to: true },
    });
  });

  it("the collapsed bedroom count can still be cleared, on purpose", async () => {
    const fake = setup(LAND);
    await updatePropertySection({ error: null, savedAt: null }, detailsFormPost(LAND, { bedrooms: "" }));
    expect(writeOf(fake)).toMatchObject({ bedrooms: null });
    expect(changed()).toEqual({ bedrooms: { from: 2, to: null } });
  });
});

describe("other kinds of property", () => {
  it("an apartment never writes the land panel, whatever its row holds", async () => {
    const row = stored({ property_type: "apartment", bedrooms: 2, road_frontage_m: 9, water_available: true });
    const fake = setup(row);
    // a crafted post carrying land fields: still not written for a flat
    const fd = detailsFormPost(row, { bedrooms: "3", water_available: "no", road_frontage_m: "1" });
    await updatePropertySection({ error: null, savedAt: null }, fd);
    const write = writeOf(fake);
    expect(write).toMatchObject({ bedrooms: 3 });
    expect(write).not.toHaveProperty("water_available");
    expect(write).not.toHaveProperty("road_frontage_m");
    expect(Object.keys(changed())).toEqual(["bedrooms"]);
  });

  it("a project's collapsed rooms post back untouched; changing its delivery date moves only that", async () => {
    const row = stored({
      kind: "project",
      property_type: "apartment",
      plot_area_sqm: 4000,
      total_floors: 5,
      construction_status: "under_construction",
      delivery_date: "2027-06-30",
    });
    const fake = setup(row);
    await updatePropertySection(
      { error: null, savedAt: null },
      detailsFormPost(row, { delivery_date: "2027-09-30" }),
    );
    expect(writeOf(fake)).toMatchObject({ total_floors: 5, plot_area_sqm: 4000, delivery_date: "2027-09-30" });
    expect(changed()).toEqual({ delivery_date: { from: "2027-06-30", to: "2027-09-30" } });
  });
});
