import { describe, expect, it } from "vitest";
import { daysOnMarket, isPriceReviewDue, PRICE_REVIEW_DAYS } from "./listing-health";

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
