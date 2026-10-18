import { describe, expect, it } from "vitest";
import {
  BUDGET_TOLERANCE_PCT,
  HARD_REQUIREMENT_FIELDS,
  MATCH_WEIGHTS,
  QUALIFYING_CRITERIA,
  SOFT_REQUIREMENT_FIELDS,
  matchProperty,
  unstatedCriteria,
  type HardRequirementField,
  type MatchCandidate,
  type MatchRequirement,
  type SoftRequirementField,
} from "./matching";

/** A requirement that constrains almost nothing — add only what a test needs. */
const req = (over: Partial<MatchRequirement> = {}): MatchRequirement => ({
  transaction_type: "sale",
  property_types: [],
  district_ids: [],
  area_ids: [],
  budget_min: null,
  budget_max: null,
  bedrooms_min: null,
  bedrooms_max: null,
  bathrooms_min: null,
  covered_area_min_sqm: null,
  plot_area_min_sqm: null,
  title_deed_required: false,
  vat_preference: null,
  max_sea_distance_m: null,
  delivery_by: null,
  features_required: [],
  ...over,
});

/** A plain sellable 2-bed apartment. */
const prop = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  id: "p1",
  status: "available",
  transaction_type: "sale",
  property_type: "apartment",
  district_id: "d1",
  area_id: "a1",
  asking_price: 250000,
  rent_price_month: null,
  bedrooms: 2,
  bathrooms: 1,
  covered_area_sqm: 90,
  plot_area_sqm: null,
  title_deed_status: "separate",
  vat_status: "resale_no_vat",
  sea_distance_m: 800,
  delivery_date: null,
  features: [],
  ...over,
});

const codes = (rs: { code: string }[]) => rs.map((r) => r.code).sort();

describe("matchProperty — hard filters disqualify and name themselves", () => {
  it("passes a property that constrains nothing", () => {
    const v = matchProperty(req(), prop());
    expect(v.eligible).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it("blocks a status that is not on the market, and allows the three that are", () => {
    for (const status of ["draft", "sold", "rented", "withdrawn"] as const) {
      const v = matchProperty(req(), prop({ status }));
      expect(v.eligible, `${status} must not match`).toBe(false);
      expect(codes(v.blockers)).toContain("status");
      expect(v.score, "a blocked candidate scores zero").toBe(0);
    }
    // reserved and under_offer stay matchable — a Cyprus chain falls through
    // often enough that hiding them loses the desk real options. They are
    // ranked below `available` by a soft criterion, not excluded.
    for (const status of ["available", "reserved", "under_offer"] as const) {
      expect(matchProperty(req(), prop({ status })).eligible, `${status} matches`).toBe(true);
    }
  });

  it("treats sale_or_rent as compatible with both sides", () => {
    expect(matchProperty(req({ transaction_type: "sale" }), prop({ transaction_type: "rent" })).eligible)
      .toBe(false);
    expect(
      matchProperty(
        req({ transaction_type: "sale" }),
        prop({ transaction_type: "sale_or_rent" }),
      ).eligible,
      "a sale_or_rent listing satisfies a sale requirement",
    ).toBe(true);
    expect(
      matchProperty(
        req({ transaction_type: "rent" }),
        prop({ transaction_type: "sale_or_rent", rent_price_month: 1200 }),
      ).eligible,
      "and a rent requirement too",
    ).toBe(true);
  });

  it("prices a rental requirement off the monthly rent, not the asking price", () => {
    // The bug this pins: reading asking_price for a rental compares €250.000
    // against a €1.500 budget and rejects every rental in the database.
    const v = matchProperty(
      req({ transaction_type: "rent", budget_max: 1500 }),
      prop({ transaction_type: "rent", asking_price: 250000, rent_price_month: 1200 }),
    );
    expect(v.eligible).toBe(true);
    expect(codes(v.blockers)).not.toContain("budget");
  });

  it("filters on type and district only when the requirement lists them", () => {
    expect(matchProperty(req({ property_types: ["villa"] }), prop()).eligible).toBe(false);
    expect(matchProperty(req({ property_types: ["apartment", "villa"] }), prop()).eligible).toBe(true);
    expect(matchProperty(req({ district_ids: ["d9"] }), prop()).eligible).toBe(false);
    expect(matchProperty(req({ district_ids: ["d1"] }), prop()).eligible).toBe(true);
    // an empty list means "no opinion", never "matches nothing"
    expect(matchProperty(req({ property_types: [], district_ids: [] }), prop()).eligible).toBe(true);
  });

  it("enforces the bedroom band, and treats an unknown bedroom count as a miss", () => {
    expect(matchProperty(req({ bedrooms_min: 3 }), prop({ bedrooms: 2 })).eligible).toBe(false);
    expect(matchProperty(req({ bedrooms_min: 2 }), prop({ bedrooms: 2 })).eligible).toBe(true);
    expect(matchProperty(req({ bedrooms_max: 3 }), prop({ bedrooms: 5 })).eligible).toBe(false);
    // land has no bedrooms; someone asking for 2 does not want it
    expect(matchProperty(req({ bedrooms_min: 2 }), prop({ bedrooms: null })).eligible).toBe(false);
  });

  it("requires a separate title deed only when asked", () => {
    for (const deed of ["pending", "shared", "none", "unknown"] as const) {
      const v = matchProperty(req({ title_deed_required: true }), prop({ title_deed_status: deed }));
      expect(v.eligible, `${deed} must not satisfy a deed requirement`).toBe(false);
      expect(codes(v.blockers)).toContain("title_deed");
    }
    expect(
      matchProperty(req({ title_deed_required: true }), prop({ title_deed_status: "separate" }))
        .eligible,
    ).toBe(true);
    expect(matchProperty(req({ title_deed_required: false }), prop({ title_deed_status: "none" })).eligible)
      .toBe(true);
  });
});

describe("matchProperty — the budget tolerance", () => {
  it("is 10 percent, and the boundary is INCLUSIVE", () => {
    expect(BUDGET_TOLERANCE_PCT).toBe(10);
    // exactly 10% over is still a match — the boundary is asserted so the next
    // reader cannot move it by accident
    const at = matchProperty(req({ budget_max: 300000 }), prop({ asking_price: 330000 }));
    expect(at.eligible, "exactly 10% over is eligible").toBe(true);
    const past = matchProperty(req({ budget_max: 300000 }), prop({ asking_price: 330001 }));
    expect(past.eligible, "a euro past the tolerance is not").toBe(false);
    expect(codes(past.blockers)).toContain("budget");
  });

  it("flags an overage rather than hiding it, and reports how much", () => {
    const v = matchProperty(req({ budget_max: 300000 }), prop({ asking_price: 312000 }));
    expect(v.eligible).toBe(true);
    const miss = v.misses.find((m) => m.code === "budget");
    expect(miss, "an in-tolerance overage is a named miss, not silence").toBeDefined();
    expect(miss).toMatchObject({ code: "budget", max: 300000, got: 312000, overBy: 12000 });
  });

  it("does not reject an unpriced property — it names the gap", () => {
    // Unpriced units are real: 0041's availability demo has B302 with no price.
    // Excluding them from every budgeted search would hide live inventory.
    const v = matchProperty(req({ budget_max: 300000 }), prop({ asking_price: null }));
    expect(v.eligible, "an unpriced property is still worth showing").toBe(true);
    expect(codes(v.misses)).toContain("price_unknown");
  });
});

describe("matchProperty — the score", () => {
  it("is 100 when the requirement asks for nothing it can miss", () => {
    // Nothing applicable means nothing missed. A buyer who states only a
    // transaction type must not be punished for being vague.
    const v = matchProperty(req(), prop({ status: "available" }));
    expect(v.score).toBe(100);
  });

  it("is normalised over APPLICABLE weight, not total weight", () => {
    // Only the area criterion applies here, and it fails, so the score floors
    // at 0 without any other criterion diluting it.
    const v = matchProperty(req({ area_ids: ["a9"] }), prop({ area_id: "a1", status: "available" }));
    expect(v.eligible, "area is a soft criterion, never a blocker").toBe(true);
    expect(codes(v.misses)).toContain("area");
    expect(v.score).toBeLessThan(100);
  });

  it("ranks an available property above an equivalent one under offer", () => {
    const r = req({ area_ids: ["a1"] });
    const open = matchProperty(r, prop({ status: "available" }));
    const taken = matchProperty(r, prop({ status: "under_offer" }));
    expect(open.score).toBeGreaterThan(taken.score);
    expect(codes(taken.misses)).toContain("status_not_available");
  });

  it("scores required features pro-rata and names every one that is absent", () => {
    const r = req({ features_required: ["sea_view", "private_pool", "elevator"] });
    const none = matchProperty(r, prop({ features: [] }));
    const some = matchProperty(r, prop({ features: ["sea_view", "elevator"] }));
    const all = matchProperty(r, prop({ features: ["sea_view", "private_pool", "elevator", "gym"] }));
    expect(none.score).toBeLessThan(some.score);
    expect(some.score).toBeLessThan(all.score);
    expect(none.misses.filter((m) => m.code === "feature")).toHaveLength(3);
    expect(some.misses.filter((m) => m.code === "feature")).toHaveLength(1);
    expect(all.misses.filter((m) => m.code === "feature")).toHaveLength(0);
  });

  it("always returns hits alongside misses, so a score can be explained", () => {
    const v = matchProperty(
      req({ area_ids: ["a1"], covered_area_min_sqm: 80, bathrooms_min: 1 }),
      prop(),
    );
    expect(v.hits.length).toBeGreaterThan(0);
    expect(codes(v.hits)).toContain("area");
    expect(v.score).toBe(100);
  });

  it("keeps every weight positive — a zero weight is a criterion that silently stops counting", () => {
    for (const [name, weight] of Object.entries(MATCH_WEIGHTS)) {
      expect(weight, `${name} must carry weight`).toBeGreaterThan(0);
    }
  });
});

describe("matchProperty — hostile input", () => {
  it("never throws on an all-null property", () => {
    const bare: MatchCandidate = {
      id: "p0",
      status: "available",
      transaction_type: "sale",
      property_type: "land",
      district_id: null,
      area_id: null,
      asking_price: null,
      rent_price_month: null,
      bedrooms: null,
      bathrooms: null,
      covered_area_sqm: null,
      plot_area_sqm: null,
      title_deed_status: "unknown",
      vat_status: "unknown",
      sea_distance_m: null,
      delivery_date: null,
      features: [],
    };
    expect(() => matchProperty(req(), bare)).not.toThrow();
    const v = matchProperty(req(), bare);
    expect(Number.isFinite(v.score)).toBe(true);
    expect(v.score).toBeGreaterThanOrEqual(0);
    expect(v.score).toBeLessThanOrEqual(100);
  });

  it("blocks on a district the property does not have at all", () => {
    expect(matchProperty(req({ district_ids: ["d1"] }), prop({ district_id: null })).eligible).toBe(
      false,
    );
  });

  it("returns a score inside 0..100 for every combination it is given", () => {
    const cases: MatchCandidate[] = [
      prop({ asking_price: 0 }),
      prop({ covered_area_sqm: 0 }),
      prop({ sea_distance_m: 0 }),
      prop({ features: ["sea_view"] }),
    ];
    for (const c of cases) {
      const v = matchProperty(
        req({ budget_max: 300000, covered_area_min_sqm: 50, max_sea_distance_m: 500 }),
        c,
      );
      expect(v.score).toBeGreaterThanOrEqual(0);
      expect(v.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(v.score), "scores are whole numbers for display").toBe(true);
    }
  });
});

/*
 * A04: the saved-search form now SAYS which fields hide a listing and which
 * only rank it, and lays its fields out from these two lists. So the lists
 * are pinned to the engine here, field by field: a field moved between them,
 * or a rule changed underneath them, turns this red instead of leaving the
 * form telling the desk something the matcher does not do.
 */
describe("HARD_REQUIREMENT_FIELDS / SOFT_REQUIREMENT_FIELDS — the form's grouping is the engine's", () => {
  /** each field set ALONE, and a property that violates it */
  const HARD_CASES: Record<HardRequirementField, [Partial<MatchRequirement>, Partial<MatchCandidate>]> = {
    transaction_type: [{ transaction_type: "rent" }, {}],
    property_types: [{ property_types: ["villa"] }, {}],
    district_ids: [{ district_ids: ["d2"] }, {}],
    bedrooms_min: [{ bedrooms_min: 3 }, {}],
    bedrooms_max: [{ bedrooms_max: 1 }, {}],
    title_deed_required: [{ title_deed_required: true }, { title_deed_status: "pending" }],
    // 25% over: beyond the tolerance, which is what makes a budget hide a row
    budget_max: [{ budget_max: 200000 }, {}],
  };
  const SOFT_CASES: Record<SoftRequirementField, [Partial<MatchRequirement>, Partial<MatchCandidate>]> = {
    budget_min: [{ budget_min: 300000 }, {}],
    area_ids: [{ area_ids: ["a2"] }, {}],
    bathrooms_min: [{ bathrooms_min: 3 }, {}],
    covered_area_min_sqm: [{ covered_area_min_sqm: 200 }, {}],
    plot_area_min_sqm: [{ plot_area_min_sqm: 500 }, {}],
    max_sea_distance_m: [{ max_sea_distance_m: 100 }, {}],
    delivery_by: [{ delivery_by: "2020-01-01" }, { delivery_date: "2027-06-30" }],
    vat_preference: [{ vat_preference: "new_vat" }, {}],
    features_required: [{ features_required: ["pool"] }, {}],
  };

  it("the two lists cover every requirement field exactly once", () => {
    const all = Object.keys(req()).sort();
    const listed = [...HARD_REQUIREMENT_FIELDS, ...SOFT_REQUIREMENT_FIELDS];
    expect([...listed].sort()).toEqual(all);
    expect(new Set(listed).size, "no field in both lists").toBe(listed.length);
    // and the case tables above are exactly those lists
    expect(Object.keys(HARD_CASES).sort()).toEqual([...HARD_REQUIREMENT_FIELDS].sort());
    expect(Object.keys(SOFT_CASES).sort()).toEqual([...SOFT_REQUIREMENT_FIELDS].sort());
  });

  for (const field of HARD_REQUIREMENT_FIELDS) {
    it(`${field}, set alone and missed, HIDES the listing (a blocker)`, () => {
      const [r, p] = HARD_CASES[field];
      expect(matchProperty(req(), prop(p)).eligible, "the control property matches with nothing set").toBe(true);
      const v = matchProperty(req(r), prop(p));
      expect(v.eligible, `${field} must hide a listing that misses it`).toBe(false);
      expect(v.blockers.length).toBeGreaterThan(0);
    });
  }

  for (const field of SOFT_REQUIREMENT_FIELDS) {
    it(`${field}, set alone and missed, only RANKS the listing (a named miss, never a blocker)`, () => {
      const [r, p] = SOFT_CASES[field];
      const v = matchProperty(req(r), prop(p));
      expect(v.eligible, `${field} must never hide a listing`).toBe(true);
      expect(v.blockers).toEqual([]);
      // `availableNow` is always judged; the miss asserted is this field's own
      expect(v.misses.filter((m) => m.code !== "status_not_available").length, `${field} names its miss`).toBeGreaterThan(0);
      expect(v.score).toBeLessThan(100);
    });
  }

  it("budget_max inside the tolerance ranks rather than hides — the form says 10% over still shows", () => {
    const v = matchProperty(req({ budget_max: 230000 }), prop({ asking_price: 250000 }));
    expect(v.eligible).toBe(true);
    expect(codes(v.misses)).toContain("budget");
    expect(BUDGET_TOLERANCE_PCT).toBe(10);
  });
});

describe("unstatedCriteria — what the desk still has to ask", () => {
  it("an empty search leaves all four open, in the order a desk asks them", () => {
    expect(unstatedCriteria(req())).toEqual(["budget", "location", "property type", "bedrooms"]);
    expect([...QUALIFYING_CRITERIA]).toEqual(["budget", "location", "property type", "bedrooms"]);
  });

  it("a budget-only search (a two-field website brief) names the other three", () => {
    expect(unstatedCriteria(req({ budget_max: 300000 }))).toEqual(["location", "property type", "bedrooms"]);
    expect(unstatedCriteria(req({ budget_min: 300000 })), "a floor is a stated budget too").toEqual([
      "location",
      "property type",
      "bedrooms",
    ]);
  });

  it("an area alone, or a district alone, is a stated location; either bedroom bound is stated", () => {
    expect(unstatedCriteria(req({ area_ids: ["a1"] }))).not.toContain("location");
    expect(unstatedCriteria(req({ district_ids: ["d1"] }))).not.toContain("location");
    expect(unstatedCriteria(req({ bedrooms_max: 2 }))).not.toContain("bedrooms");
    expect(unstatedCriteria(req({ bedrooms_min: 0 })), "zero is a stated minimum (a studio)").not.toContain(
      "bedrooms",
    );
  });

  it("a full search leaves nothing open", () => {
    expect(
      unstatedCriteria(
        req({ budget_max: 400000, district_ids: ["d1"], property_types: ["villa"], bedrooms_min: 3 }),
      ),
    ).toEqual([]);
  });

  it("tolerates what PostgREST hands back for numeric — a number, or a numeric string", () => {
    expect(unstatedCriteria(req({ budget_max: "300000" as unknown as number }))).not.toContain("budget");
    expect(unstatedCriteria(req({ budget_max: Number.NaN }))).toContain("budget");
  });
});
