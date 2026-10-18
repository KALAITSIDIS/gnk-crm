import { describe, expect, it } from "vitest";
import {
  daysOnMarket,
  isPriceReviewDue,
  listingHealthVerdict,
  PRICE_REVIEW_DAYS,
} from "./listing-health";
import { computeQualityScore, type QualityScoreInput } from "./quality-score";
import { buildWorklist, type ScoredProperty } from "./quality-worklist";

/**
 * Days on market is a WHOLE-DAY count from the publish stamp (0073) to now.
 * It feeds the worklist and the admin dashboard (audit 2026-09-15, LST-03),
 * so the two must agree — hence one function, pinned here.
 */
describe("daysOnMarket", () => {
  it("counts whole days from the publish stamp to now, rounding down", () => {
    expect(daysOnMarket("2026-09-01T10:00:00Z", new Date("2026-09-15T09:00:00Z"))).toBe(13);
    expect(daysOnMarket("2026-09-01T10:00:00Z", new Date("2026-09-15T10:00:00Z"))).toBe(14);
  });

  it("is zero on the day a listing is published", () => {
    expect(daysOnMarket("2026-09-15T08:00:00Z", new Date("2026-09-15T20:00:00Z"))).toBe(0);
  });

  it("never goes negative when a clock is behind the stamp", () => {
    // a stamp minutes ahead of the reader's clock is skew, not a listing from the future
    expect(daysOnMarket("2026-09-15T20:05:00Z", new Date("2026-09-15T20:00:00Z"))).toBe(0);
  });
});

describe("isPriceReviewDue", () => {
  it("is due at PRICE_REVIEW_DAYS and after, not a day before", () => {
    expect(PRICE_REVIEW_DAYS).toBe(90);
    expect(isPriceReviewDue(89)).toBe(false);
    expect(isPriceReviewDue(90)).toBe(true);
    expect(isPriceReviewDue(400)).toBe(true);
  });
});

/**
 * F03: the dashboard's Listing health is the worklist's fresh computation,
 * stated as separate facts. Green only when the website essentials and the
 * completeness line are clean and no price review is due; data warnings are
 * said beside it and never decide it.
 */
describe("listingHealthVerdict", () => {
  const NOW = new Date("2026-10-19T12:00:00Z");
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
  const live = (reference: string, daysAgo: number, over: Partial<QualityScoreInput> = {}): ScoredProperty => {
    const result = computeQualityScore({ ...perfect, ...over });
    return {
      property: { id: `id-${reference}`, reference, title: null, score: result.score },
      listing: {
        visibility: "public",
        status: "available",
        publishedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
      },
      result,
    };
  };
  const verdict = (rows: ScoredProperty[]) => listingHealthVerdict(buildWorklist(rows, NOW));

  it("is healthy when every public listing has its essentials, clears the threshold and is under 90 days", () => {
    const v = verdict([live("PAF0001", 10), live("PAF0002", 89)]);
    expect(v.healthy).toBe(true);
    expect(v.publicCount).toBe(2);
    expect(v.essentials).toEqual([]);
    expect(v.belowThreshold).toEqual([]);
    expect(v.longest?.property.reference).toBe("PAF0002");
  });

  it("is NOT healthy for an 85-point public listing with no photograph — the case the old line called green", () => {
    const v = verdict([live("PAF0004", 10, { hasCoverPhoto: false, photoCount: 0 })]);
    expect(v.belowThreshold, "it clears the threshold").toEqual([]);
    expect(v.essentials.map((e) => [e.property.reference, e.missing.map((m) => m.key)])).toEqual([
      ["PAF0004", ["cover"]],
    ]);
    expect(v.healthy).toBe(false);
  });

  it("is not healthy below the threshold, nor with a price review due", () => {
    // 65, with every essential in place: the completeness line alone decides it
    const thin = verdict([live("THIN", 1, { titleDeedSet: false, mandateActive: false, hasCoords: false, permitSet: false })]);
    expect(thin.essentials).toEqual([]);
    expect(thin.belowThreshold.map((p) => [p.reference, p.score])).toEqual([["THIN", 65]]);
    expect(thin.healthy).toBe(false);
    const due = verdict([live("OLD", PRICE_REVIEW_DAYS)]);
    expect(due.priceReviewDue).toBe(1);
    expect(due.healthy).toBe(false);
  });

  it("reports data warnings separately and never lets them flip the verdict", () => {
    const rows = [
      live("PAF0001", 5, { buildConflict: "The delivery date has passed and the build is not recorded as finished." }),
      live("PAF0002", 5, { sharedPhotoWith: ["PAF0003"] }),
      live("PAF0003", 5, { sharedPhotoWith: ["PAF0002"] }),
    ];
    const v = verdict(rows);
    expect(v.dataWarnings).toEqual({ buildConflicts: 1, buildConflictSources: 1, sharedPhotos: 2 });
    expect(v.healthy, "warnings are said, not judged").toBe(true);
  });

  it("is healthy with nothing public — and says nothing is public, never 'all 0 clear'", () => {
    const v = verdict([]);
    expect(v.publicCount).toBe(0);
    expect(v.longest).toBeNull();
    expect(v.healthy).toBe(true);
  });
});
