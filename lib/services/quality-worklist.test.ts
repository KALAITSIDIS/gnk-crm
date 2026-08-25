import { describe, expect, it } from "vitest";
import { computeQualityScore, type QualityScoreInput } from "./quality-score";
import {
  buildWorklist,
  fixLocation,
  type ScoredProperty,
} from "./quality-worklist";

/** Everything earned, so a test can take exactly what it wants away. */
const perfect: QualityScoreInput = {
  isLand: false,
  hasCoverPhoto: true,
  photoCount: 6,
  titleEn: "A title",
  publicDescriptionEn: "x".repeat(300),
  hasPrice: true,
  hasArea: true,
  hasBedroomsAndBathrooms: true,
  hasPlanningZoneAndDensity: true,
  hasCoords: true,
  titleDeedSet: true,
  permitSet: true,
  mandateActive: true,
  hasAssignedAgent: true,
  hasOwnerOrDeveloper: true,
};

const scored = (
  reference: string,
  over: Partial<QualityScoreInput> = {},
): ScoredProperty => {
  const result = computeQualityScore({ ...perfect, ...over });
  return {
    property: { id: `id-${reference}`, reference, title: null, score: result.score },
    result,
  };
};

describe("buildWorklist", () => {
  it("handles an empty portfolio without dividing by zero", () => {
    const w = buildWorklist([]);
    expect(w).toMatchObject({ categories: [], total: 0, complete: 0, recoverable: 0 });
    expect(w.averageScore).toBeNull();
  });

  it("counts a criterion once per property missing it", () => {
    const w = buildWorklist([
      scored("A", { titleDeedSet: false }),
      scored("B", { titleDeedSet: false }),
      scored("C"),
    ]);
    const deed = w.categories.find((c) => c.key === "deed")!;
    expect(deed.count).toBe(2);
    expect(deed.points).toBe(10);
    expect(deed.recoverable).toBe(20);
    expect(deed.properties.map((p) => p.reference).sort()).toEqual(["A", "B"]);
  });

  it("leaves a complete property out of every category but counts it", () => {
    const w = buildWorklist([scored("A"), scored("B", { hasPrice: false })]);
    expect(w.total).toBe(2);
    expect(w.complete).toBe(1);
    expect(w.categories.every((c) => !c.properties.some((p) => p.reference === "A"))).toBe(true);
  });

  it("ORDERS BY POINTS RECOVERABLE, not by how common the gap is", () => {
    // 3 missing a cover photo (5 each = 15) vs 2 missing a deed status
    // (10 each = 20). Sorting by count would put the cover photo first and
    // send the desk at the smaller win.
    const w = buildWorklist([
      scored("A", { hasCoverPhoto: false }),
      scored("B", { hasCoverPhoto: false }),
      scored("C", { hasCoverPhoto: false }),
      scored("D", { titleDeedSet: false }),
      scored("E", { titleDeedSet: false }),
    ]);
    expect(w.categories.map((c) => c.key)).toEqual(["deed", "cover"]);
    expect(w.categories[0]!.recoverable).toBe(20);
    expect(w.categories[1]!.recoverable).toBe(15);
    expect(w.categories[1]!.count, "the commoner gap is still second").toBe(3);
  });

  it("lists the worst-scoring properties first inside a category", () => {
    // one gap vs many: the many-gap listing gains most from a sitting
    const w = buildWorklist([
      scored("HIGH", { titleDeedSet: false }),
      scored("LOW", {
        titleDeedSet: false,
        hasPrice: false,
        hasCoverPhoto: false,
        hasCoords: false,
      }),
    ]);
    const deed = w.categories.find((c) => c.key === "deed")!;
    expect(deed.properties.map((p) => p.reference)).toEqual(["LOW", "HIGH"]);
  });

  it("breaks a score tie by reference so the order does not shuffle", () => {
    const w = buildWorklist([
      scored("PAF0009", { hasPrice: false }),
      scored("PAF0002", { hasPrice: false }),
    ]);
    expect(w.categories[0]!.properties.map((p) => p.reference)).toEqual(["PAF0002", "PAF0009"]);
  });

  it("totals what the whole list could recover, and the mean score", () => {
    const w = buildWorklist([
      scored("A", { hasPrice: false }), // -10
      scored("B", { hasCoverPhoto: false }), // -5
    ]);
    expect(w.recoverable).toBe(15);
    expect(w.averageScore).toBe(Math.round((90 + 95) / 2));
  });
});

describe("land and non-land share a KEY even when the label differs", () => {
  it("keeps `area` one category across a mixed portfolio", () => {
    // "Plot area set" for land, "Covered area set" otherwise. Grouping by label
    // would split one real gap into two rows that each look smaller than it is.
    const w = buildWorklist([
      scored("LAND", { isLand: true, hasArea: false }),
      scored("FLAT", { isLand: false, hasArea: false }),
    ]);
    const area = w.categories.filter((c) => c.key === "area");
    expect(area).toHaveLength(1);
    expect(area[0]!.count).toBe(2);
  });

  it("keeps land's `planning` separate from a flat's `rooms`", () => {
    // these are genuinely different criteria, not one with two names
    const w = buildWorklist([
      scored("LAND", { isLand: true, hasPlanningZoneAndDensity: false }),
      scored("FLAT", { isLand: false, hasBedroomsAndBathrooms: false }),
    ]);
    expect(w.categories.map((c) => c.key).sort()).toEqual(["planning", "rooms"]);
  });
});

describe("fixLocation turns a count into an instruction", () => {
  it("names the tab for every criterion the score can report", () => {
    // a category with nowhere to send the user is a dead end on the page
    const all = computeQualityScore({
      ...perfect,
      hasCoverPhoto: false,
      photoCount: 0,
      titleEn: "",
      publicDescriptionEn: "",
      hasPrice: false,
      hasArea: false,
      hasBedroomsAndBathrooms: false,
      hasCoords: false,
      titleDeedSet: false,
      permitSet: false,
      mandateActive: false,
      hasAssignedAgent: false,
      hasOwnerOrDeveloper: false,
    });
    for (const item of all.missing) {
      expect(fixLocation(item.key), `${item.key} has no tab`).toBeTruthy();
    }
  });

  it("covers land's planning criterion too, which the non-land list never shows", () => {
    const land = computeQualityScore({
      ...perfect,
      isLand: true,
      hasPlanningZoneAndDensity: false,
    });
    expect(land.missing.map((m) => m.key)).toContain("planning");
    expect(fixLocation("planning")).toBe("Legal");
  });

  it("returns null for a key it does not know, rather than guessing", () => {
    expect(fixLocation("not_a_criterion")).toBeNull();
  });
});
