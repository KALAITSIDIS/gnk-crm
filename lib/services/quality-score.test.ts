import { describe, expect, it } from "vitest";
import { computeQualityScore, type QualityScoreInput } from "./quality-score";

const empty: QualityScoreInput = {
  isLand: false,
  isContainer: false,
  unitCount: 0,
  hasCoverPhoto: false,
  photoCount: 0,
  titleEn: null,
  publicDescriptionEn: null,
  hasPrice: false,
  hasArea: false,
  hasBedroomsAndBathrooms: false,
  hasPlanningZoneAndDensity: false,
  hasCoords: false,
  titleDeedSet: false,
  permitSet: false,
  mandateActive: false,
  hasAssignedAgent: false,
  hasOwnerOrDeveloper: false,
};

const full: QualityScoreInput = {
  isLand: false,
  isContainer: false,
  unitCount: 0,
  hasCoverPhoto: true,
  photoCount: 6,
  titleEn: "Seafront villa",
  publicDescriptionEn: "x".repeat(300),
  hasPrice: true,
  hasArea: true,
  hasBedroomsAndBathrooms: true,
  hasPlanningZoneAndDensity: false,
  hasCoords: true,
  titleDeedSet: true,
  permitSet: true,
  mandateActive: true,
  hasAssignedAgent: true,
  hasOwnerOrDeveloper: true,
};

describe("computeQualityScore — weight table (doc 02 §C1)", () => {
  it("empty property scores 0; complete property scores 100", () => {
    expect(computeQualityScore(empty).score).toBe(0);
    expect(computeQualityScore(full).score).toBe(100);
  });

  it.each([
    ["hasCoverPhoto", { hasCoverPhoto: true }, 5],
    ["photoCount ≥ 6", { photoCount: 6 }, 10],
    ["titleEn", { titleEn: "Villa" }, 5],
    ["description ≥ 300", { publicDescriptionEn: "x".repeat(300) }, 10],
    ["hasPrice", { hasPrice: true }, 10],
    ["hasArea", { hasArea: true }, 10],
    ["rooms", { hasBedroomsAndBathrooms: true }, 5],
    ["hasCoords", { hasCoords: true }, 10],
    ["titleDeedSet", { titleDeedSet: true }, 10],
    ["permitSet", { permitSet: true }, 5],
    ["mandateActive", { mandateActive: true }, 10],
    ["hasAssignedAgent", { hasAssignedAgent: true }, 5],
    ["hasOwnerOrDeveloper", { hasOwnerOrDeveloper: true }, 5],
  ] as const)("%s alone contributes exactly its weight", (_name, patch, points) => {
    expect(computeQualityScore({ ...empty, ...patch }).score).toBe(points);
  });

  it("boundaries: 5 photos ≠ 6 photos; 299 chars ≠ 300 chars", () => {
    expect(computeQualityScore({ ...empty, photoCount: 5 }).score).toBe(0);
    expect(computeQualityScore({ ...empty, photoCount: 6 }).score).toBe(10);
    expect(computeQualityScore({ ...empty, publicDescriptionEn: "x".repeat(299) }).score).toBe(0);
    expect(computeQualityScore({ ...empty, publicDescriptionEn: "x".repeat(300) }).score).toBe(10);
  });

  it("land swaps rooms weight for planning zone + density", () => {
    const land = { ...empty, isLand: true };
    // rooms no longer counts for land
    expect(computeQualityScore({ ...land, hasBedroomsAndBathrooms: true }).score).toBe(0);
    // planning fields count instead, same 5 points
    expect(computeQualityScore({ ...land, hasPlanningZoneAndDensity: true }).score).toBe(5);
    // non-land ignores planning fields
    expect(computeQualityScore({ ...empty, hasPlanningZoneAndDensity: true }).score).toBe(0);
  });

  it("whitespace-only title does not count", () => {
    expect(computeQualityScore({ ...empty, titleEn: "   " }).score).toBe(0);
  });

  it("missing list names exactly the unearned items", () => {
    const result = computeQualityScore({ ...full, hasCoverPhoto: false, mandateActive: false });
    expect(result.score).toBe(85); // 100 − cover 5 − mandate 10
    expect(result.missing.map((m) => m.key).sort()).toEqual(["cover", "mandate"]);
  });

  it("the weights still total exactly 100", () => {
    // the guard on rebalancing: adding an item without paying for it inflates
    // every score and quietly weakens the publish gate
    const total = computeQualityScore(empty).items.reduce((sum, i) => sum + i.points, 0);
    expect(total).toBe(100);
    expect(computeQualityScore({ ...empty, isLand: true }).items.reduce((s2, i) => s2 + i.points, 0))
      .toBe(100);
  });

  it("imagery pays for the two responsibility items (audit finding 15)", () => {
    // cover 10→5 and ≥6 photos 15→10 funded agent 5 + party 5. Imagery still
    // carries 15, the joint-largest dimension, and nothing about price,
    // location or legal status was touched.
    expect(computeQualityScore({ ...empty, hasCoverPhoto: true, photoCount: 6 }).score).toBe(15);
    expect(
      computeQualityScore({ ...empty, hasAssignedAgent: true, hasOwnerOrDeveloper: true }).score,
    ).toBe(10);
  });

  it("an owner OR a developer earns the party point, not both required", () => {
    expect(computeQualityScore({ ...empty, hasOwnerOrDeveloper: true }).score).toBe(5);
  });
});

/**
 * A project or phase is not a dwelling. It was graded as one until 2026-09-02,
 * which is how a real project with NO UNITS scored 100/100 and went public.
 */
describe("containers are graded on units, not rooms", () => {
  const container = (over: Partial<QualityScoreInput> = {}): QualityScoreInput => ({
    ...full,
    isContainer: true,
    unitCount: 0,
    // a container legitimately has none of these — they must stop being asked
    hasArea: false,
    hasBedroomsAndBathrooms: false,
    ...over,
  });

  it("still totals 100 when everything is earned — the branch is a swap, not a discount", () => {
    // "everything" for a container includes a priced unit — its price item is
    // its units' prices, not its own (2026-09-02 review)
    expect(computeQualityScore(container({ unitCount: 12, pricedUnitCount: 12 })).score).toBe(100);
  });

  it("never asks a container for covered area or bedrooms", () => {
    const keys = computeQualityScore(container()).items.map((i) => i.key);
    expect(keys).not.toContain("area");
    expect(keys).not.toContain("rooms");
    expect(keys).not.toContain("planning");
    expect(keys).toContain("units");
  });

  it("an empty project loses the 15 the dwelling pair carried AND the 10 for price", () => {
    // no units means no priced units either: the two items an empty
    // development cannot earn are exactly the two its units would carry
    expect(computeQualityScore(container({ unitCount: 0, pricedUnitCount: 0 })).score).toBe(75);
    expect(computeQualityScore(container({ unitCount: 1, pricedUnitCount: 1 })).score).toBe(100);
  });

  it("names the gap so the worklist can chase it", () => {
    const { missing } = computeQualityScore(container({ unitCount: 0 }));
    expect(missing.map((m) => m.key)).toContain("units");
    expect(missing.find((m) => m.key === "units")?.label).toBe("At least one unit");
  });

  it("75 is ABOVE the publish threshold — the score informs, the gate enforces", () => {
    // this is why lib/actions/properties.ts refuses an empty container
    // separately; removing that gate would reopen the incident
    expect(computeQualityScore(container({ unitCount: 0 })).score).toBeGreaterThan(70);
  });

  it("a land CONTAINER is still scored as a container, not as land", () => {
    const keys = computeQualityScore(container({ isLand: true })).items.map((i) => i.key);
    expect(keys).toContain("units");
    expect(keys).not.toContain("planning");
  });
});

/**
 * "The units carry the prices" — every line of container copy says so, and
 * until the 2026-09-02 review the score still docked a project 10 points for
 * not having an asking price OF ITS OWN. The item is now about the units.
 */
describe("a container's price is its units' prices", () => {
  const container = (over: Partial<QualityScoreInput> = {}): QualityScoreInput => ({
    ...full,
    isContainer: true,
    unitCount: 3,
    hasArea: false,
    hasBedroomsAndBathrooms: false,
    ...over,
  });

  it("a project's own asking price earns nothing when none of its units is priced", () => {
    const result = computeQualityScore(container({ hasPrice: true, pricedUnitCount: 0 }));
    const price = result.items.find((i) => i.key === "price");
    expect(price?.label).toBe("Units priced");
    expect(price?.earned).toBe(false);
    expect(result.score).toBe(90);
  });

  it("one priced unit earns the item even with no project-level price", () => {
    const result = computeQualityScore(container({ hasPrice: false, pricedUnitCount: 1 }));
    expect(result.items.find((i) => i.key === "price")?.earned).toBe(true);
    expect(result.score).toBe(100);
  });

  it("keeps the SAME key, so the worklist groups both gaps under one row", () => {
    const { missing } = computeQualityScore(container({ pricedUnitCount: 0 }));
    expect(missing.map((m) => m.key)).toContain("price");
  });

  it("a dwelling is still graded on its own price — nothing changed for the common case", () => {
    const price = computeQualityScore({ ...full, hasPrice: true }).items.find(
      (i) => i.key === "price",
    );
    expect(price?.label).toBe("Price set");
    expect(price?.earned).toBe(true);
  });

  it("an absent pricedUnitCount reads as zero, never as NaN or true", () => {
    const { pricedUnitCount: _drop, ...without } = container({ hasPrice: true });
    void _drop;
    expect(computeQualityScore(without).items.find((i) => i.key === "price")?.earned).toBe(false);
  });
});
