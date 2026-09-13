import { describe, expect, it } from "vitest";
import { buildQualityInput, computeQualityScore, type QualityScoreSource } from "./quality-score";

/**
 * A contradictory build declaration reaches the score's warnings — the list
 * the property page's ring and the worklist already render — without
 * costing points (audit CRM-05: warn, never block).
 */
const source = {
  kind: "standalone",
  property_type: "villa",
  title: { en: "Villa" },
  public_description: { en: "x".repeat(300) },
  asking_price: 450000,
  rent_price_month: null,
  covered_area_sqm: 185,
  plot_area_sqm: 1200,
  bedrooms: 3,
  bathrooms: 3,
  planning_zone_code: null,
  building_density_pct: null,
  location: "0101000020E6100000000000000000F03F000000000000F03F",
  location_approx: false,
  title_deed_status: "separate",
  permit_status: "granted",
  assigned_agent_id: "agent",
  owner_contact_id: "owner",
  developer_contact_id: null,
  year_built: 2007,
  construction_status: "finishing",
  delivery_date: "2026-11-29",
} as unknown as QualityScoreSource;

const extras = {
  hasCoverPhoto: true,
  photoCount: 6,
  sharedPhotoWith: [],
  unitCount: 0,
  pricedUnitCount: 0,
  mandateActive: true,
};

describe("the build-conflict warning", () => {
  it("is raised from a source whose year built contradicts its build status", () => {
    const result = computeQualityScore(buildQualityInput(source, extras));
    const w = result.warnings.find((x) => x.key === "build_conflict");
    expect(w, "a build_conflict warning").toBeDefined();
    expect(w!.label).toMatch(/2007/);
  });

  it("costs no points — the score is the same with and without the contradiction", () => {
    const withConflict = computeQualityScore(buildQualityInput(source, extras)).score;
    const clean = computeQualityScore(
      buildQualityInput({ ...source, construction_status: "completed", delivery_date: null } as QualityScoreSource, extras),
    );
    expect(clean.warnings.find((x) => x.key === "build_conflict")).toBeUndefined();
    expect(clean.score).toBe(withConflict);
  });

  it("is absent when the source carries no build fields at all", () => {
    const bare = { ...source } as Record<string, unknown>;
    delete bare.year_built;
    delete bare.construction_status;
    delete bare.delivery_date;
    const result = computeQualityScore(buildQualityInput(bare as unknown as QualityScoreSource, extras));
    expect(result.warnings.find((x) => x.key === "build_conflict")).toBeUndefined();
  });
});
