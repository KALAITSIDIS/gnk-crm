import { describe, expect, it } from "vitest";
import { computePricing, hasPricingInsight, type PricingInput } from "./commission";

const input = (over: Partial<PricingInput> = {}): PricingInput => ({
  askingPrice: 250000,
  minAcceptablePrice: null,
  ownerNetPrice: null,
  commissionPct: 5,
  ...over,
});

describe("commission at the asking price", () => {
  it("takes the percentage of the sale", () => {
    const b = computePricing(input({ askingPrice: 250000, commissionPct: 5 }));
    expect(b.commissionAtAsking).toBe(12500);
    expect(b.ownerNetsAtAsking).toBe(237500);
  });

  it("handles a fractional percentage to the cent", () => {
    const b = computePricing(input({ askingPrice: 333333, commissionPct: 3.5 }));
    expect(b.commissionAtAsking).toBe(11666.66);
    expect(b.ownerNetsAtAsking).toBe(321666.34);
    expect(b.commissionAtAsking! + b.ownerNetsAtAsking!).toBeCloseTo(333333, 2);
  });

  it("treats a zero percentage as real, not missing", () => {
    const b = computePricing(input({ commissionPct: 0 }));
    expect(b.commissionPct).toBe(0);
    expect(b.commissionAtAsking).toBe(0);
    expect(b.ownerNetsAtAsking).toBe(250000);
  });

  it("derives nothing without an asking price", () => {
    const b = computePricing(input({ askingPrice: null }));
    expect(b.commissionAtAsking).toBeNull();
    expect(b.ownerNetsAtAsking).toBeNull();
  });
});

describe("the floor is a DIVISION, not an addition", () => {
  it("computes the lowest sale that delivers the owner's net", () => {
    // 200.000 net at 5% -> 200000 / 0.95 = 210526.32
    const b = computePricing(input({ ownerNetPrice: 200000, commissionPct: 5 }));
    expect(b.floor).toBe(210526.32);
  });

  it("REFUSES the tempting wrong answer, and the difference is real money", () => {
    // net + commission = 210.000 is the intuitive version. Selling there
    // returns 210000 x 0.95 = 199.500 -- five hundred short of the promise.
    const b = computePricing(input({ ownerNetPrice: 200000, commissionPct: 5 }));
    expect(b.floor).not.toBe(210000);
    expect(b.floor! * 0.95).toBeCloseTo(200000, 2);
    // and the naive figure is correctly flagged as short
    const naive = computePricing(
      input({ ownerNetPrice: 200000, commissionPct: 5, minAcceptablePrice: 210000 }),
    );
    expect(naive.minAcceptableShortfall).toBe(500);
  });

  it("equals the net exactly at zero commission", () => {
    expect(computePricing(input({ ownerNetPrice: 200000, commissionPct: 0 })).floor).toBe(200000);
  });

  it("has no floor without an owner net target", () => {
    expect(computePricing(input({ ownerNetPrice: null })).floor).toBeNull();
  });
});

describe("percentages that would produce a nonsense floor are refused", () => {
  it("refuses 100% — the agency taking the whole sale leaves no floor", () => {
    // 1 - 100/100 = 0; dividing would be Infinity, which renders as a number
    const b = computePricing(input({ ownerNetPrice: 200000, commissionPct: 100 }));
    expect(b.commissionPct).toBeNull();
    expect(b.floor).toBeNull();
    expect(b.commissionAtAsking).toBeNull();
  });

  it("refuses above 100% and negative percentages", () => {
    for (const pct of [101, 150, -5]) {
      const b = computePricing(input({ ownerNetPrice: 200000, commissionPct: pct }));
      expect(b.commissionPct, `${pct}% must be refused`).toBeNull();
      expect(b.floor).toBeNull();
    }
  });

  it("accepts 99.99%, absurd but arithmetically sound", () => {
    const b = computePricing(input({ ownerNetPrice: 1, commissionPct: 99.99 }));
    expect(b.floor).toBe(10000);
  });
});

describe("commission masked by mandates_safe", () => {
  it("derives nothing at all when the percentage is null", () => {
    // a listing manager reads commission_pct as NULL from the view; the prices
    // still show, the arithmetic does not
    const b = computePricing(
      input({ commissionPct: null, ownerNetPrice: 200000, minAcceptablePrice: 205000 }),
    );
    expect(b.commissionPct).toBeNull();
    expect(b.commissionAtAsking).toBeNull();
    expect(b.floor).toBeNull();
    expect(b.minAcceptableShortfall).toBeNull();
    // but what was entered on the property is untouched
    expect(b.asking).toBe(250000);
    expect(b.ownerNetTarget).toBe(200000);
    expect(hasPricingInsight(b)).toBe(false);
  });

  it("has insight as soon as a percentage arrives", () => {
    expect(hasPricingInsight(computePricing(input()))).toBe(true);
  });
});

describe("shortfalls name the gap in euro", () => {
  it("flags a min acceptable that does not deliver the net", () => {
    // 205.000 at 5% returns 194.750 against a 200.000 promise
    const b = computePricing(
      input({ ownerNetPrice: 200000, commissionPct: 5, minAcceptablePrice: 205000 }),
    );
    expect(b.minAcceptableShortfall).toBe(5250);
  });

  it("stays silent when the min acceptable clears the floor", () => {
    const b = computePricing(
      input({ ownerNetPrice: 200000, commissionPct: 5, minAcceptablePrice: 215000 }),
    );
    expect(b.minAcceptableShortfall).toBeNull();
  });

  it("treats landing exactly on the floor as no shortfall", () => {
    const b = computePricing(
      input({ ownerNetPrice: 200000, commissionPct: 5, minAcceptablePrice: 210526.32 }),
    );
    expect(b.minAcceptableShortfall).toBeNull();
  });

  it("flags the ASKING price falling short, which is the worse case", () => {
    // asking below the floor means the listing cannot deliver the promise even
    // at full price -- nothing else on the page would say so
    const b = computePricing(
      input({ askingPrice: 205000, ownerNetPrice: 200000, commissionPct: 5 }),
    );
    expect(b.askingShortfall).toBe(5250);
    expect(b.floor).toBe(210526.32);
  });
});

describe("the shapes a real row arrives in", () => {
  it("reads numerics that came over as STRINGS", () => {
    const b = computePricing({
      askingPrice: "250000.00",
      minAcceptablePrice: "205000.00",
      ownerNetPrice: "200000.00",
      commissionPct: "5.000",
    });
    expect(b.commissionAtAsking).toBe(12500);
    expect(b.floor).toBe(210526.32);
    expect(b.minAcceptableShortfall).toBe(5250);
  });

  it("returns nulls rather than NaN for unparseable input", () => {
    const b = computePricing({
      askingPrice: "not a number",
      minAcceptablePrice: "",
      ownerNetPrice: null,
      commissionPct: "abc",
    });
    for (const [k, v] of Object.entries(b)) {
      expect(Number.isNaN(v as number), `${k} must not be NaN`).toBe(false);
    }
    expect(b.asking).toBeNull();
    expect(b.commissionPct).toBeNull();
  });
});
