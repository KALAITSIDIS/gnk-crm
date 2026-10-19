import { describe, expect, it } from "vitest";
import {
  DETAILS_FIELDS,
  LAND_DETAILS_FIELDS,
  detailsFieldLabel,
  detailsLayout,
  isRecorded,
  landOverviewFacts,
  layoutFields,
  propertyProfile,
  recordedValues,
  type DetailsField,
  type DetailsGroupId,
  type DetailsLayout,
} from "@/lib/services/property-layout";
import {
  PROPERTY_KINDS,
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
  detailsSectionSchema,
  detailsUpdates,
} from "@/lib/validators/properties";
import { postedValue } from "@/lib/testing/details-form-post";

/**
 * F07: the Details tab is laid out per kind of property, and the save writes
 * every column of the section on every submit (absent → null). The one thing
 * a layout must never do is leave a field out, so these tests hold the layout
 * and the save together for EVERY type × kind × transaction: what is laid out
 * is exactly what is written — a field may move, never disappear.
 */
const ROWS = PROPERTY_TYPES.flatMap((property_type) =>
  PROPERTY_KINDS.flatMap((kind) =>
    TRANSACTION_TYPES.map((transaction_type) => ({ property_type, kind, transaction_type })),
  ),
);

/** The columns a field writes: the map point is the action's (compared first), and storage is the features' mirror (F02). */
function columnsOf(fields: readonly DetailsField[]): string[] {
  return fields
    .flatMap((f) => (f === "location" ? [] : f === "features" ? ["features", "has_storage"] : [f]))
    .sort();
}

/** The blank form for this layout, as the browser posts it (selects at their defaults). */
function blankPost(layout: DetailsLayout, transaction_type: string) {
  const row: Record<string, unknown> = {
    status: "draft",
    visibility: "private",
    transaction_type,
    vat_status: "unknown",
  };
  const raw: Record<string, unknown> = {};
  for (const f of layoutFields(layout)) Object.assign(raw, postedValue(f, row));
  return { ...raw, features: [] as string[] };
}

const ids = (l: DetailsLayout) => l.groups.map((g) => g.id);
const at = (l: DetailsLayout, id: DetailsGroupId) => ids(l).indexOf(id);

describe("the partition: every field laid out is a column written, and every column written is laid out", () => {
  it.each(ROWS)("$property_type / $kind / $transaction_type", (row) => {
    const layout = detailsLayout(row);
    const fields = layoutFields(layout);
    // no field twice — a duplicated input posts twice and the first one wins
    expect(new Set(fields).size, `duplicates in ${JSON.stringify(fields)}`).toBe(fields.length);
    for (const f of fields) expect(DETAILS_FIELDS).toContain(f);
    // the map point and the features are on every layout
    expect(fields).toContain("location");
    expect(fields).toContain("features");

    const parsed = detailsSectionSchema.safeParse(blankPost(layout, row.transaction_type));
    expect(parsed.success, parsed.success ? "" : parsed.error.issues[0]?.message).toBe(true);
    const written = Object.keys(detailsUpdates(parsed.data!, row)).sort();
    expect(written).toEqual(columnsOf(fields));
  });

  it("the land panel is laid out exactly when it is written: for land, of any kind", () => {
    for (const row of ROWS) {
      const fields = layoutFields(detailsLayout(row));
      for (const f of LAND_DETAILS_FIELDS) {
        expect(fields.includes(f), `${row.property_type}/${row.kind}: ${f}`).toBe(
          row.property_type === "land",
        );
      }
    }
  });

  it("every field of DETAILS_FIELDS is laid out for some property — none is dead", () => {
    const seen = new Set(ROWS.flatMap((r) => layoutFields(detailsLayout(r))));
    expect([...seen].sort()).toEqual([...DETAILS_FIELDS].sort());
  });
});

describe("profiles", () => {
  it("a project or a phase is a container whatever its type; land is land at any other kind", () => {
    expect(propertyProfile({ property_type: "land", kind: "project" })).toBe("container");
    expect(propertyProfile({ property_type: "apartment", kind: "phase" })).toBe("container");
    expect(propertyProfile({ property_type: "land", kind: "standalone" })).toBe("land");
    expect(propertyProfile({ property_type: "land", kind: "unit" })).toBe("land");
    expect(propertyProfile({ property_type: "villa", kind: "unit" })).toBe("built");
    // commercial premises keep the built layout (whether they are graded on
    // rooms is an operator decision, BACKLOG) — nothing is collapsed for them
    for (const t of ["shop", "office", "warehouse", "hotel", "building", "mixed_use", "other"]) {
      expect(propertyProfile({ property_type: t, kind: "standalone" })).toBe("built");
    }
  });
});

describe("built: unchanged content", () => {
  const layout = detailsLayout({ property_type: "apartment", kind: "standalone", transaction_type: "sale" });

  it("the same sections in the same order as before F07, nothing collapsed", () => {
    expect(ids(layout)).toEqual([
      "listing",
      "location",
      "pricing",
      "areas_rooms",
      "build_handover",
      "features",
      "internal_notes",
    ]);
    expect(layout.groups.every((g) => g.collapsed === null)).toBe(true);
    expect(layout.groups.map((g) => g.heading)).toEqual([
      null,
      "Location",
      "Pricing",
      "Areas & rooms",
      "Build & handover",
      "Features",
      "Internal notes",
    ]);
  });

  it("Areas & rooms holds the fields it always held, in order", () => {
    expect(layout.groups.find((g) => g.id === "areas_rooms")!.fields).toEqual([
      "covered_area_sqm",
      "plot_area_sqm",
      "veranda_sqm",
      "roof_garden_sqm",
      "basement_sqm",
      "bedrooms",
      "bathrooms",
      "wc",
      "parking_spaces",
      "floor_number",
      "total_floors",
      "year_built",
      "energy_class",
    ]);
  });

  it("no land panel", () => {
    for (const f of LAND_DETAILS_FIELDS) expect(layoutFields(layout)).not.toContain(f);
  });
});

describe("land: planning first, the dwelling fields set aside", () => {
  const layout = detailsLayout({ property_type: "land", kind: "standalone", transaction_type: "sale" });

  it("Location → Plot & planning → Access & utilities → Constraints → Pricing → Features, then the collapsed groups, then notes", () => {
    expect(ids(layout)).toEqual([
      "listing",
      "location",
      "plot_planning",
      "access_utilities",
      "constraints",
      "pricing",
      "features",
      "building_accommodation",
      "build_handover",
      "internal_notes",
    ]);
    expect(at(layout, "plot_planning")).toBeLessThan(at(layout, "building_accommodation"));
  });

  it("the planning group carries the plot and the planning terms; utilities and frontage follow", () => {
    const g = (id: DetailsGroupId) => layout.groups.find((x) => x.id === id)!;
    expect(g("plot_planning").fields).toEqual([
      "plot_area_sqm",
      "planning_zone_code",
      "building_density_pct",
      "coverage_ratio_pct",
      "max_floors",
      "max_height_m",
    ]);
    expect(g("access_utilities").fields).toEqual(["road_frontage_m", "water_available", "electricity_available"]);
    expect(g("constraints").fields).toEqual(["constraints_notes"]);
  });

  it("collapsed, not left out: Building & accommodation and Build & handover, each saying why", () => {
    const collapsed = layout.groups.filter((g) => g.collapsed !== null);
    expect(collapsed.map((g) => g.id)).toEqual(["building_accommodation", "build_handover"]);
    for (const g of collapsed) expect(g.collapsed).toBe("not usual for land");
    expect(collapsed[0]!.fields).toEqual([
      "covered_area_sqm",
      "veranda_sqm",
      "roof_garden_sqm",
      "basement_sqm",
      "bedrooms",
      "bathrooms",
      "wc",
      "parking_spaces",
      "floor_number",
      "total_floors",
      "year_built",
      "energy_class",
    ]);
  });
});

describe("container: build and handover first, the rooms collapsed", () => {
  it("a project opens on Build & handover; its units carry the rooms", () => {
    const layout = detailsLayout({ property_type: "apartment", kind: "project", transaction_type: "sale" });
    expect(ids(layout)).toEqual([
      "listing",
      "build_handover",
      "location",
      "site",
      "pricing",
      "features",
      "building_accommodation",
      "internal_notes",
    ]);
    const build = layout.groups.find((g) => g.id === "build_handover")!;
    expect(build.collapsed).toBeNull();
    expect(build.fields).toEqual(["construction_status", "delivery_date", "year_built", "energy_class"]);
    expect(build.note).toMatch(/new unit takes its construction status, delivery date and energy class/);
    const rooms = layout.groups.find((g) => g.id === "building_accommodation")!;
    expect(rooms.collapsed).toBe("each unit carries its own");
    expect(rooms.fields).toContain("bedrooms");
    expect(rooms.fields).toContain("covered_area_sqm");
    expect(layout.groups.find((g) => g.id === "site")!.fields).toEqual(["plot_area_sqm"]);
  });

  it("a land subdivision project gets the land groups too", () => {
    const layout = detailsLayout({ property_type: "land", kind: "project", transaction_type: "sale" });
    expect(layout.profile).toBe("container");
    expect(layout.isLand).toBe(true);
    expect(ids(layout)).toEqual([
      "listing",
      "build_handover",
      "location",
      "site",
      "access_utilities",
      "constraints",
      "pricing",
      "features",
      "building_accommodation",
      "internal_notes",
    ]);
    expect(layout.groups.find((g) => g.id === "site")!.heading).toBe("Site & planning");
  });

  it("the container's labels: From price, Site plot", () => {
    expect(detailsFieldLabel("asking_price", "container")).toBe("From price (€)");
    expect(detailsFieldLabel("plot_area_sqm", "container")).toBe("Site plot (m²)");
    expect(detailsFieldLabel("asking_price", "built")).toBe("Asking price (€)");
    expect(detailsFieldLabel("plot_area_sqm", "land")).toBe("Plot (m²)");
  });
});

describe("pricing follows the transaction, and every price input stays", () => {
  const pricing = (transaction_type: string) =>
    detailsLayout({ property_type: "villa", kind: "standalone", transaction_type }).groups.find(
      (g) => g.id === "pricing",
    )!.fields;

  it("rent: the rent first", () => {
    expect(pricing("rent")[0]).toBe("rent_price_month");
    expect(pricing("rent").indexOf("rent_price_month")).toBeLessThan(pricing("rent").indexOf("asking_price"));
  });

  it("sale and sale-or-rent: the asking price first", () => {
    expect(pricing("sale")[0]).toBe("asking_price");
    expect(pricing("sale_or_rent")[0]).toBe("asking_price");
  });

  it("the same five inputs whatever the transaction", () => {
    for (const t of TRANSACTION_TYPES) {
      expect([...pricing(t)].sort()).toEqual(
        ["asking_price", "min_acceptable_price", "owner_net_price", "rent_price_month", "vat_status"].sort(),
      );
    }
  });
});

describe("what a collapsed group says it holds", () => {
  const land = detailsLayout({ property_type: "land", kind: "standalone" });
  const rooms = land.groups.find((g) => g.id === "building_accommodation")!;
  const build = land.groups.find((g) => g.id === "build_handover")!;

  it("names each recorded value, with its unit after the number", () => {
    expect(
      recordedValues(rooms, { bedrooms: 3, parking_spaces: 1, covered_area_sqm: 120, energy_class: "B+" }, "land"),
    ).toEqual(["Covered 120 m²", "Bedrooms 3", "Parking spaces 1", "Energy class B+"]);
    expect(recordedValues(build, { construction_status: "under_construction", delivery_date: "2027-06-30" }, "land")).toEqual([
      "Construction status under construction",
      "Expected delivery 2027-06-30",
    ]);
  });

  it("a zero is a value; a blank, a null and an empty list are not", () => {
    expect(recordedValues(rooms, { bedrooms: 0, bathrooms: null, wc: undefined, veranda_sqm: "" }, "land")).toEqual([
      "Bedrooms 0",
    ]);
    expect(isRecorded(0)).toBe(true);
    expect(isRecorded(false)).toBe(true);
    expect(isRecorded("  ")).toBe(false);
    expect(isRecorded([])).toBe(false);
    expect(isRecorded(null)).toBe(false);
  });

  it("nothing recorded is an empty list", () => {
    expect(recordedValues(rooms, {}, "land")).toEqual([]);
  });
});

describe("the land Overview facts", () => {
  const blank = {
    planning_zone_code: null,
    building_density_pct: null,
    coverage_ratio_pct: null,
    road_frontage_m: null,
    water_available: null,
    electricity_available: null,
  };

  it("planning terms, frontage and utilities, as recorded", () => {
    expect(
      landOverviewFacts({
        planning_zone_code: "Κα6",
        building_density_pct: 60,
        coverage_ratio_pct: 35,
        road_frontage_m: 22.5,
        water_available: true,
        electricity_available: false,
      }),
    ).toEqual([
      ["Planning", "Κα6 · density 60% · coverage 35%"],
      ["Road frontage", "22,5 m"],
      ["Utilities", "Water: Yes · Electricity: No"],
    ]);
  });

  it("nothing recorded is a dash — never a zero, never a No", () => {
    expect(landOverviewFacts(blank)).toEqual([
      ["Planning", "—"],
      ["Road frontage", "—"],
      ["Utilities", "—"],
    ]);
  });

  it("one utility known, the other said to be unrecorded; a zero density is a value", () => {
    expect(landOverviewFacts({ ...blank, building_density_pct: 0, water_available: true })).toEqual([
      ["Planning", "density 0%"],
      ["Road frontage", "—"],
      ["Utilities", "Water: Yes · Electricity: not recorded"],
    ]);
  });

  it("numeric text (a numeric column read as text) reads the same; junk is a dash", () => {
    expect(landOverviewFacts({ ...blank, building_density_pct: "62.50", road_frontage_m: "abc" })).toEqual([
      ["Planning", "density 62,5%"],
      ["Road frontage", "—"],
      ["Utilities", "—"],
    ]);
  });
});
