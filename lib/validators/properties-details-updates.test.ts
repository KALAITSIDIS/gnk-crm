import { describe, expect, it } from "vitest";
import {
  UTILITY_STATES,
  detailsSectionSchema,
  detailsUpdates,
  utilityFormValue,
} from "@/lib/validators/properties";

/**
 * F07: `detailsUpdates` — which columns a Details save writes, and with what —
 * moved out of `updatePropertySection` into a pure function, so the per-type
 * layout can be pinned against it (lib/services/property-layout.test.ts). The
 * rule that was only an `if` inside the action is pinned here: the land panel
 * is written for land rows only. And the utilities have three answers now.
 */
const BASE = { status: "available", visibility: "private", transaction_type: "sale", vat_status: "unknown" };

const parse = (raw: Record<string, unknown>) => {
  const r = detailsSectionSchema.safeParse({ features: [], ...BASE, ...raw });
  if (!r.success) throw new Error(r.error.issues[0]?.message);
  return r.data;
};

const LAND_COLUMNS = [
  "planning_zone_code",
  "building_density_pct",
  "coverage_ratio_pct",
  "max_floors",
  "max_height_m",
  "road_frontage_m",
  "water_available",
  "electricity_available",
  "constraints_notes",
];

/** The columns the save wrote before F07 for a non-land row — the extraction changed none of them. */
const ALWAYS = [
  "status",
  "visibility",
  "transaction_type",
  "area_id",
  "address",
  "postal_code",
  "sea_distance_m",
  "amenities_notes",
  "asking_price",
  "min_acceptable_price",
  "owner_net_price",
  "rent_price_month",
  "vat_status",
  "covered_area_sqm",
  "plot_area_sqm",
  "veranda_sqm",
  "roof_garden_sqm",
  "basement_sqm",
  "bedrooms",
  "bathrooms",
  "wc",
  "parking_spaces",
  "has_storage",
  "floor_number",
  "total_floors",
  "year_built",
  "energy_class",
  "features",
  "construction_status",
  "delivery_date",
  "internal_notes",
];

const LAND_POST = {
  planning_zone_code: "Κα6",
  building_density_pct: "60",
  coverage_ratio_pct: "35",
  max_floors: "2",
  max_height_m: "8.3",
  road_frontage_m: "22.5",
  water_available: "yes",
  electricity_available: "no",
  constraints_notes: "Archaeological zone B",
};

describe("detailsUpdates: the land panel is written for land rows only", () => {
  it("a land row takes every land column, with what was posted", () => {
    const u = detailsUpdates(parse(LAND_POST), { property_type: "land" });
    expect(Object.keys(u).sort()).toEqual([...ALWAYS, ...LAND_COLUMNS].sort());
    expect(u).toMatchObject({
      planning_zone_code: "Κα6",
      building_density_pct: 60,
      coverage_ratio_pct: 35,
      max_floors: 2,
      max_height_m: 8.3,
      road_frontage_m: 22.5,
      water_available: true,
      electricity_available: false,
      constraints_notes: "Archaeological zone B",
    });
  });

  it("a non-land row takes none of them — even when a crafted post carries them", () => {
    for (const t of ["apartment", "villa", "shop", "building", "other"]) {
      const u = detailsUpdates(parse(LAND_POST), { property_type: t });
      expect(Object.keys(u).sort(), t).toEqual([...ALWAYS].sort());
      for (const c of LAND_COLUMNS) expect(u, `${t}: ${c}`).not.toHaveProperty(c);
    }
  });

  it("blank fields write null (that is how a box is cleared) and has_storage mirrors the feature (F02)", () => {
    const u = detailsUpdates(parse({ bedrooms: "", address: "" }), { property_type: "apartment" });
    expect(u.bedrooms).toBeNull();
    expect(u.address).toBeNull();
    expect(u.has_storage).toBe(false);
    expect(detailsUpdates(parse({ features: ["storage_room"] }), { property_type: "apartment" }).has_storage).toBe(true);
  });
});

describe("water and electricity: Yes, No, or not known", () => {
  const land = (raw: Record<string, unknown>) => detailsUpdates(parse(raw), { property_type: "land" });

  it("yes / no / unknown → true / false / null", () => {
    expect(land({ water_available: "yes", electricity_available: "no" })).toMatchObject({
      water_available: true,
      electricity_available: false,
    });
    const u = land({ water_available: "unknown", electricity_available: "unknown" });
    expect(u.water_available).toBeNull();
    expect(u.electricity_available).toBeNull();
  });

  it("a ticked box from a page rendered before F07 still means yes", () => {
    expect(land({ water_available: "on" }).water_available).toBe(true);
    expect(land({ water_available: "true" }).water_available).toBe(true);
  });

  it("NOT POSTED is not written — an unticked box on a stale page, or a form that did not render it, changes nothing", () => {
    const u = land({});
    expect(u).not.toHaveProperty("water_available");
    expect(u).not.toHaveProperty("electricity_available");
    // the rest of the land panel is still written as before
    expect(u).toHaveProperty("planning_zone_code", null);
  });

  it("anything else is refused, in words", () => {
    const r = detailsSectionSchema.safeParse({ features: [], ...BASE, water_available: "maybe" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toBe("Choose Yes, No or Not known");
  });

  it("the form shows what is stored, and posts back what it shows", () => {
    expect(UTILITY_STATES).toEqual(["unknown", "yes", "no"]);
    for (const stored of [true, false, null] as const) {
      const shown = utilityFormValue(stored);
      expect(land({ water_available: shown }).water_available).toBe(stored);
    }
    expect(utilityFormValue(undefined)).toBe("unknown");
  });
});
