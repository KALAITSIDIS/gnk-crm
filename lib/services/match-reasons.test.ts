import { describe, expect, it } from "vitest";
import { describeMatchHit, describeMatchReason } from "./match-reasons";
import { matchProperty, type MatchCandidate, type MatchRequirement } from "./matching";
import type { MatchReason } from "./matching";

/** Every code the union defines — the exhaustiveness guard below walks this. */
const ONE_OF_EACH: MatchReason[] = [
  { code: "status", got: "sold" },
  { code: "status_not_available", got: "under_offer" },
  { code: "transaction_type", wanted: "sale", got: "rent" },
  { code: "property_type", wanted: ["villa"], got: "apartment" },
  { code: "district", wanted: ["d1"], got: "d2" },
  { code: "area", wanted: ["a1"], got: "a2" },
  { code: "budget", max: 300000, got: 312000, overBy: 12000 },
  { code: "budget_bracket", min: 200000, got: 150000 },
  { code: "price_unknown" },
  { code: "bedrooms", min: 2, max: null, got: 1 },
  { code: "bathrooms", min: 2, got: 1 },
  { code: "covered_area", min: 100, got: 80 },
  { code: "plot_area", min: 500, got: 300 },
  { code: "title_deed", got: "pending" },
  { code: "sea_distance", max: 500, got: 900 },
  { code: "delivery", by: "2027-06-30", got: "2028-01-31" },
  { code: "vat", wanted: "resale_no_vat", got: "new_vat" },
  { code: "feature", feature: "private_pool" },
];

describe("describeMatchReason", () => {
  it("renders every reason code as non-empty text with no leftover placeholder", () => {
    // The exhaustiveness guard. TypeScript catches a MISSING case at compile
    // time; this catches one that returns nothing useful at runtime.
    for (const r of ONE_OF_EACH) {
      const text = describeMatchReason(r);
      expect(text, `${r.code} produced nothing`).toBeTruthy();
      expect(text, `${r.code} left a placeholder`).not.toMatch(/[{}]|undefined|null|NaN/);
    }
  });

  it("states the overage in money, because that is the number an agent negotiates with", () => {
    expect(describeMatchReason({ code: "budget", max: 300000, got: 312000, overBy: 12000 })).toBe(
      "€12.000 over budget",
    );
  });

  it("says 'not stated' rather than showing a null", () => {
    expect(describeMatchReason({ code: "bedrooms", min: 2, max: null, got: null })).toBe(
      "Needs 2+ bed, has not stated",
    );
    expect(describeMatchReason({ code: "sea_distance", max: 500, got: null })).toMatch(
      /not stated/,
    );
  });

  it("distinguishes reserved from under offer", () => {
    expect(describeMatchReason({ code: "status_not_available", got: "reserved" })).toBe("Reserved");
    expect(describeMatchReason({ code: "status_not_available", got: "under_offer" })).toBe(
      "Under offer",
    );
  });

  it("uses the feature vocabulary's own label, not the raw key", () => {
    expect(describeMatchReason({ code: "feature", feature: "private_pool" })).toBe(
      "No private pool",
    );
  });
});

describe("describeMatchHit", () => {
  it("renders every code positively and never empty", () => {
    for (const r of ONE_OF_EACH) {
      expect(describeMatchHit(r), `${r.code} produced nothing`).toBeTruthy();
    }
  });

  it("phrases a satisfied criterion as a positive, not as a miss", () => {
    expect(describeMatchHit({ code: "area", wanted: ["a1"], got: "a1" })).toBe("In their area");
    expect(describeMatchHit({ code: "status_not_available", got: "available" })).toBe(
      "Available now",
    );
  });
});

describe("the two halves agree with the engine", () => {
  it("renders every reason a real verdict actually produces", () => {
    // Guards the seam: matching.ts could add a reason code and this module
    // would still typecheck if the switch had a default. It does not have one,
    // but a real verdict is the honest end-to-end check.
    const req: MatchRequirement = {
      transaction_type: "sale",
      property_types: ["apartment"],
      district_ids: [],
      area_ids: ["a9"],
      budget_min: 100000,
      budget_max: 200000,
      bedrooms_min: null,
      bedrooms_max: null,
      bathrooms_min: 3,
      covered_area_min_sqm: 200,
      plot_area_min_sqm: 400,
      title_deed_required: false,
      vat_preference: "reduced_rate_eligible",
      max_sea_distance_m: 100,
      delivery_by: "2027-01-01",
      features_required: ["private_pool"],
    };
    const candidate: MatchCandidate = {
      id: "p1",
      status: "under_offer",
      transaction_type: "sale",
      property_type: "apartment",
      district_id: "d1",
      area_id: "a1",
      asking_price: 210000,
      rent_price_month: null,
      bedrooms: 2,
      bathrooms: 1,
      covered_area_sqm: 90,
      plot_area_sqm: null,
      title_deed_status: "pending",
      vat_status: "new_vat",
      sea_distance_m: 800,
      delivery_date: null,
      features: [],
    };

    const v = matchProperty(req, candidate);
    expect(v.eligible, "in-tolerance overage stays eligible").toBe(true);
    expect(v.misses.length).toBeGreaterThan(5);
    for (const m of [...v.misses, ...v.hits]) {
      expect(describeMatchReason(m), `${m.code} unrendered`).toBeTruthy();
      expect(describeMatchHit(m), `${m.code} unrendered as hit`).toBeTruthy();
    }
  });
});
