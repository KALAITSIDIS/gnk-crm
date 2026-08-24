import { describe, expect, it } from "vitest";
import { BUDGET_TOLERANCE_PCT } from "./matching";
import { isAlertableDrop, priceFor, wasPricedOut } from "./price-drop-alerts";

describe("isAlertableDrop", () => {
  it("fires only on a genuine decrease", () => {
    expect(isAlertableDrop(500000, 450000)).toBe(true);
    expect(isAlertableDrop(450000, 500000), "a rise is not a drop").toBe(false);
    expect(isAlertableDrop(450000, 450000), "no change is not a drop").toBe(false);
  });

  it("does not fire when either side is unknown", () => {
    // Pricing a previously unpriced property is a NEW LISTING, not a drop, and
    // it is a different feature. Removing a price is not a drop either.
    expect(isAlertableDrop(null, 450000)).toBe(false);
    expect(isAlertableDrop(450000, null)).toBe(false);
    expect(isAlertableDrop(null, null)).toBe(false);
  });

  it("has NO arbitrary minimum, on purpose", () => {
    // A €1 drop only ever alerts if it crosses somebody's ceiling — see
    // wasPricedOut. A "minimum meaningful drop" constant would be a number
    // nobody could defend, and it would suppress exactly the case that matters.
    expect(isAlertableDrop(450001, 450000)).toBe(true);
  });
});

describe("wasPricedOut — the crux of the feature", () => {
  // The question is not "can they afford it now" but "could they NOT afford it
  // before". Without that, every price drop would alert every buyer who already
  // matched, which is noise the desk would learn to ignore.
  const ceiling = (budget: number) => budget * (1 + BUDGET_TOLERANCE_PCT / 100);

  it("is true only when the drop crosses their ceiling", () => {
    // budget 300k, ceiling 330k
    expect(wasPricedOut(300000, 400000, 320000), "crossed into reach").toBe(true);
    expect(wasPricedOut(300000, 400000, 350000), "still out of reach").toBe(false);
    expect(wasPricedOut(300000, 320000, 310000), "already in reach before").toBe(false);
  });

  it("uses the same tolerance the matcher uses, not a stricter one", () => {
    // If these disagreed, a buyer could be alerted and then not appear in the
    // match list, or appear in it and never be alerted.
    const budget = 300000;
    const justInside = ceiling(budget);
    expect(wasPricedOut(budget, justInside + 1, justInside)).toBe(true);
    expect(wasPricedOut(budget, justInside + 2, justInside + 1)).toBe(false);
  });

  it("treats a buyer with no ceiling as never priced out", () => {
    // No budget_max means no opinion on price, so a drop tells them nothing new.
    expect(wasPricedOut(null, 900000, 100000)).toBe(false);
  });

  it("handles a zero or negative budget without throwing", () => {
    expect(() => wasPricedOut(0, 100, 50)).not.toThrow();
    expect(wasPricedOut(0, 100, 50)).toBe(false);
  });

  it("accepts the STRING a numeric column actually arrives as", () => {
    // THE BUG THIS GUARDS, found end-to-end and not by a unit test. Postgres
    // `numeric` comes back from PostgREST as a string, so budget_max is
    // "700000.00", and `Number.isFinite("700000.00")` is FALSE — it does not
    // coerce. The first version bailed on every real row and the feature
    // silently did nothing: no task, no event, no error.
    expect(wasPricedOut("700000.00" as unknown as number, 800000, 760000)).toBe(true);
    expect(wasPricedOut("700000.00" as unknown as number, 800000, 790000)).toBe(false);
  });

  it("still rejects a genuinely non-numeric value", () => {
    expect(wasPricedOut("not a number" as unknown as number, 800000, 760000)).toBe(false);
    expect(wasPricedOut("" as unknown as number, 800000, 760000)).toBe(false);
  });
});

describe("priceFor", () => {
  it("reads the rent for a rental requirement and the asking price otherwise", () => {
    const p = { asking_price: 250000, rent_price_month: 1200 };
    expect(priceFor("rent", p)).toBe(1200);
    expect(priceFor("sale", p)).toBe(250000);
    expect(priceFor("sale_or_rent", p)).toBe(250000);
  });

  it("returns null rather than NaN when the relevant price is unset", () => {
    expect(priceFor("rent", { asking_price: 250000, rent_price_month: null })).toBeNull();
    expect(priceFor("sale", { asking_price: null, rent_price_month: 1200 })).toBeNull();
  });
});
