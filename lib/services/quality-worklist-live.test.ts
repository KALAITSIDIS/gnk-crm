import { describe, expect, it } from "vitest";
import { computeQualityScore, PUBLISH_THRESHOLD, type QualityScoreInput } from "./quality-score";
import { buildWorklist, type ScoredProperty } from "./quality-worklist";

/**
 * The worklist watches LIVE listings as well as scoring them (audit
 * 2026-09-15, LST-03). Two things used to be invisible from every screen:
 * a public listing whose score has decayed below the publish threshold
 * (`published_below_threshold()` existed in SQL since 0066 and nothing
 * rendered it), and how long each public listing has been on the market.
 */
const perfect: QualityScoreInput = {
  isLand: false,
  isContainer: false,
  unitCount: 0,
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

const NOW = new Date("2026-09-15T12:00:00Z");

/** A listing that has been public since `daysAgo` days before NOW. */
const publicFor = (daysAgo: number): ScoredProperty["listing"] => ({
  visibility: "public",
  status: "available",
  publishedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
});

const scored = (
  reference: string,
  listing: ScoredProperty["listing"],
  over: Partial<QualityScoreInput> = {},
): ScoredProperty => {
  const result = computeQualityScore({ ...perfect, ...over });
  return {
    property: { id: "id-" + reference, reference, title: null, score: result.score },
    listing,
    result,
  };
};

/** Enough gaps to fall below the threshold: -10 price, -10 coords, -10 deed = 70, then -5 cover = 65. */
const thin: Partial<QualityScoreInput> = {
  hasPrice: false,
  hasCoords: false,
  titleDeedSet: false,
  hasCoverPhoto: false,
};

describe("public listings below the publish threshold", () => {
  it("lists a public, available listing whose fresh score is below the threshold", () => {
    const w = buildWorklist([scored("PAF0001", publicFor(10), thin)], NOW);
    expect(w.belowThreshold.map((p) => p.reference)).toEqual(["PAF0001"]);
    expect(w.belowThreshold[0]!.score).toBeLessThan(PUBLISH_THRESHOLD);
  });

  it("leaves a listing that clears the threshold out of the list", () => {
    const w = buildWorklist([scored("PAF0001", publicFor(10))], NOW);
    expect(w.belowThreshold).toEqual([]);
  });

  it("ignores a private or draft listing however low it scores — the gate has not been passed", () => {
    const w = buildWorklist(
      [
        scored("PRIVATE", { visibility: "private", status: "available", publishedAt: null }, thin),
        scored("DRAFT", { visibility: "public", status: "draft", publishedAt: null }, thin),
      ],
      NOW,
    );
    expect(w.belowThreshold).toEqual([]);
  });

  it("orders the worst score first, then by reference", () => {
    const w = buildWorklist(
      [
        scored("PAF0009", publicFor(1), thin),
        scored("PAF0002", publicFor(1), { ...thin, permitSet: false }),
        scored("PAF0005", publicFor(1), thin),
      ],
      NOW,
    );
    expect(w.belowThreshold.map((p) => p.reference)).toEqual(["PAF0002", "PAF0005", "PAF0009"]);
  });
});

describe("days on market", () => {
  it("reports every public, available listing with its days since publishing, longest first", () => {
    const w = buildWorklist(
      [scored("NEW", publicFor(3)), scored("OLD", publicFor(45)), scored("MID", publicFor(20))],
      NOW,
    );
    expect(w.onMarket.map((m) => [m.property.reference, m.days])).toEqual([
      ["OLD", 45],
      ["MID", 20],
      ["NEW", 3],
    ]);
  });

  it("flags a listing at ninety days as due a price review, and not one at eighty-nine", () => {
    const w = buildWorklist([scored("DUE", publicFor(90)), scored("NOT", publicFor(89))], NOW);
    expect(w.onMarket.find((m) => m.property.reference === "DUE")!.priceReviewDue).toBe(true);
    expect(w.onMarket.find((m) => m.property.reference === "NOT")!.priceReviewDue).toBe(false);
  });

  it("leaves a public listing with no publish stamp out — a pre-0073 row, or an import that skipped it", () => {
    const w = buildWorklist(
      [scored("UNSTAMPED", { visibility: "public", status: "available", publishedAt: null })],
      NOW,
    );
    expect(w.onMarket).toEqual([]);
  });

  it("does not list private, reserved or draft rows — they are not on the market", () => {
    const w = buildWorklist(
      [
        scored("PRIVATE", { visibility: "private", status: "available", publishedAt: publicFor(5).publishedAt }),
        scored("RESERVED", { visibility: "public", status: "reserved", publishedAt: publicFor(5).publishedAt }),
      ],
      NOW,
    );
    expect(w.onMarket).toEqual([]);
  });
});
