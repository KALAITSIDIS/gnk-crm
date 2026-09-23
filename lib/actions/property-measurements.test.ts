import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * The measurement rules (LST-07; audit 2026-09-23) at the level the product
 * uses them: the server actions, not the schemas. A schema that only its own
 * tests call validates nothing (the operator's standing rule, 2026-09-20), so
 * each case here goes through the action a form posts to and asserts what the
 * database was asked to do — for a refusal, NOTHING: no write, no event.
 */
const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() => vi.fn(async () => undefined));
const logEvents = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent, logEvents }));
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
const { createUnit, generateProjectUnits, createUnitType, applyUnitType } = await import(
  "@/lib/actions/units"
);

/** A client that fails the test if the action reaches the database at all. */
const untouchable = {
  from: (table: string) => {
    throw new Error(`the action reached the database (${table}) before refusing`);
  },
};

beforeEach(() => {
  logEvent.mockClear();
  logEvents.mockClear();
});

/* ---------------------------------------------------------------- details */

const UPDATED_AT = "2026-09-23T10:00:00.000000+00:00";

/** The stored row the details page rendered: a flat on the 2nd of 4 floors. */
const storedFlat = {
  id: "prop-1",
  org_id: "org-1",
  reference: "PAF0004",
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
  location: null,
  location_approx: false,
  sea_distance_m: null,
  amenities_notes: null,
  asking_price: 250000,
  min_acceptable_price: null,
  owner_net_price: null,
  rent_price_month: null,
  covered_area_sqm: 92,
  plot_area_sqm: null,
  veranda_sqm: null,
  roof_garden_sqm: null,
  basement_sqm: null,
  bedrooms: 2,
  bathrooms: 1,
  wc: null,
  parking_spaces: null,
  has_storage: false,
  floor_number: 2,
  total_floors: 4,
  year_built: null,
  energy_class: null,
  features: [],
  construction_status: null,
  delivery_date: null,
  internal_notes: null,
  inherited_fields: null,
  parent_id: null,
};

/** What the Details form posts: every field, each re-posted from the row unless overridden. */
function detailsForm(over: Record<string, string>) {
  const fd = new FormData();
  const posted: Record<string, string> = {
    property_id: "prop-1",
    section: "details",
    expected_updated_at: UPDATED_AT,
    status: "available",
    visibility: "private",
    transaction_type: "sale",
    vat_status: "unknown",
    asking_price: "250000",
    covered_area_sqm: "92",
    plot_area_sqm: "",
    bedrooms: "2",
    bathrooms: "1",
    floor_number: "2",
    total_floors: "4",
    ...over,
  };
  for (const [k, v] of Object.entries(posted)) fd.set(k, v);
  return fd;
}

function setupDetails(pages: FakePage[]) {
  const fake = fakeClient({ properties: pages });
  state.client = fake.client;
  return fake;
}

describe("updatePropertySection (details) refuses an impossible measurement and writes nothing", () => {
  it.each([
    [{ floor_number: "9", total_floors: "3" }, /^Floor 9 is above the building's total floors \(3\)/],
    [{ covered_area_sqm: "0" }, /^Covered area must be greater than 0/],
    [{ plot_area_sqm: "0" }, /^Plot area must be greater than 0/],
    [{ covered_area_sqm: "-5" }, /^Covered area must be greater than 0/],
  ])("%j", async (over, message) => {
    const fake = setupDetails([{ data: storedFlat, error: null }]);
    const res = await updatePropertySection({ error: null, savedAt: null }, detailsForm(over));
    expect(res.savedAt).toBeNull();
    expect(res.error).toMatch(message);
    expect(fake.argsOf("properties", "update"), "no UPDATE was sent").toHaveLength(0);
    expect(logEvent, "no event claims a save that did not happen").not.toHaveBeenCalled();
  });
});

describe("updatePropertySection (details) saves the legitimate cases", () => {
  it.each([
    [{ floor_number: "-1", total_floors: "3" }, { floor_number: -1, total_floors: 3 }],
    [{ floor_number: "0", total_floors: "3" }, { floor_number: 0, total_floors: 3 }],
    [{ floor_number: "4", total_floors: "4" }, { floor_number: 4, total_floors: 4 }],
    [{ floor_number: "", total_floors: "" }, { floor_number: null, total_floors: null }],
    [{ covered_area_sqm: "" }, { covered_area_sqm: null }],
    [{ covered_area_sqm: "  " }, { covered_area_sqm: null }],
  ])("%j", async (over, written) => {
    const fake = setupDetails([
      { data: storedFlat, error: null }, // the read
      { data: [{ id: "prop-1" }], error: null }, // the UPDATE, one row
    ]);
    const res = await updatePropertySection({ error: null, savedAt: null }, detailsForm(over));
    expect(res.error).toBeNull();
    const [payload] = fake.argsOf("properties", "update")[0] as [Record<string, unknown>];
    expect(payload).toMatchObject(written);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("writes ALL FOUR measurement columns on every save — so checking the submission IS checking the resulting row", async () => {
    // The precondition the action's validation rests on. The details save is
    // a full replace of these columns (absent → null), never a partial one; a
    // change that made it partial (the land panel's shape) would let a new
    // floor pair with a stored total the save never saw, and must add a check
    // on the merged row when it does. 0113's CHECK refuses that pairing for
    // every writer regardless (supabase/tests/property-measurements.test.ts).
    const fake = setupDetails([
      { data: storedFlat, error: null },
      { data: [{ id: "prop-1" }], error: null },
    ]);
    const fd = detailsForm({});
    fd.delete("total_floors"); // a crafted post that omits the height…
    fd.set("floor_number", "9"); // …and names a floor the stored height (4) forbids
    const res = await updatePropertySection({ error: null, savedAt: null }, fd);
    expect(res.error).toBeNull();
    const [payload] = fake.argsOf("properties", "update")[0] as [Record<string, unknown>];
    // the stored total (4) is NOT kept: the save writes null, and 9-of-unknown is admissible
    expect(payload).toMatchObject({ floor_number: 9, total_floors: null });
    expect(Object.keys(payload)).toEqual(
      expect.arrayContaining(["covered_area_sqm", "plot_area_sqm", "floor_number", "total_floors"]),
    );
  });
});

/* ------------------------------------------------------------------ units */

const PROJECT = "22222222-2222-4222-8222-222222222222";

function unitForm(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("unit write paths refuse a zero area before touching anything", () => {
  it("createUnit", async () => {
    state.client = untouchable;
    const res = await createUnit(
      { error: null, savedAt: null },
      unitForm({ project_id: PROJECT, unit_number: "101", property_type: "apartment", covered_area_sqm: "0" }),
    );
    expect(res.error).toMatch(/^Covered area must be greater than 0/);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("createUnit reads a whitespace floor as unknown, not the ground floor", async () => {
    // reaches the project read, which is where the scripted client answers "not found"
    const fake = fakeClient({ properties: [{ data: null, error: null }] });
    state.client = fake.client;
    const res = await createUnit(
      { error: null, savedAt: null },
      unitForm({ project_id: PROJECT, unit_number: "101", property_type: "apartment", floor_number: "  " }),
    );
    expect(res.error).toBe("Project not found"); // parsed fine: blank is unknown
    expect(fake.argsOf("properties", "insert")).toHaveLength(0);
  });

  it.each([
    [{ layout: "villas", villa_count: "3", plot_area_sqm: "0" }, /^Plot area must be greater than 0/],
    [{ layout: "floors", floor_from: "1", floor_to: "2", per_floor: "2", covered_area_sqm: "0.004" }, /^Covered area must be at least 0\.01/],
  ])("generateProjectUnits %j", async (over, message) => {
    state.client = untouchable;
    const res = await generateProjectUnits(
      { error: null, savedAt: null },
      unitForm({ project_id: PROJECT, property_type: "apartment", ...over }),
    );
    expect(res.error).toMatch(message);
    expect(logEvents).not.toHaveBeenCalled();
  });

  it("createUnitType", async () => {
    state.client = untouchable;
    const res = await createUnitType(
      { error: null, savedAt: null },
      unitForm({ project_id: PROJECT, code: "A1", covered_area_sqm: "0" }),
    );
    expect(res.error).toMatch(/^Covered area must be greater than 0/);
  });
});

describe("applyUnitType checks the stamp BEFORE the first unit is written", () => {
  it("a type whose stored area is 0 stamps nothing and records nothing", async () => {
    // unit_types can only hold 0 through a direct write (createUnitType
    // refuses it, and 0113 adds a CHECK); the loop below the check is not
    // atomic, so a refusal on unit N would have left units 1..N-1 stamped
    // with no events. Refused up front instead.
    const fake = fakeClient({
      unit_types: [
        {
          data: {
            id: "type-1",
            code: "A1",
            name: null,
            bedrooms: 2,
            bathrooms: 1,
            covered_area_sqm: 0,
            veranda_sqm: null,
            price_per_sqm: null,
          },
          error: null,
        },
      ],
      properties: [{ data: [{ id: "u1", reference: "PAF0002-101", asking_price: null }], error: null }],
    });
    state.client = fake.client;
    const res = await applyUnitType(
      { error: null, savedAt: null },
      unitForm({ project_id: PROJECT, unit_type_id: "type-1" }),
    );
    expect(res.error).toMatch(/^Type A1: Covered area must be greater than 0/);
    expect(fake.argsOf("properties", "update"), "no unit was stamped").toHaveLength(0);
    expect(logEvents).not.toHaveBeenCalled();
  });
});
