import { describe, expect, it } from "vitest";
import {
  blocksOf,
  inScope,
  MIN_PRICE,
  previewUplift,
  reviewedScope,
  ROUND_TO,
  upliftPrice,
  type UpliftTarget,
} from "./price-uplift";

const unit = (over: Partial<UpliftTarget> & { id: string }): UpliftTarget => ({
  reference: `PAF0002-${over.id}`,
  block: "A",
  asking_price: 250000,
  ...over,
});

describe("upliftPrice", () => {
  it("applies a percentage", () => {
    expect(upliftPrice(250000, { mode: "percent", amount: 3 })).toBe(257500);
  });

  it("applies a fixed amount", () => {
    expect(upliftPrice(250000, { mode: "fixed", amount: 5000 })).toBe(255000);
  });

  it("goes down as well as up", () => {
    expect(upliftPrice(250000, { mode: "percent", amount: -10 })).toBe(225000);
    expect(upliftPrice(250000, { mode: "fixed", amount: -25000 })).toBe(225000);
  });

  it("always lands on a round number", () => {
    // 3% of 253000 is 260590 — rounded to the €100 prices are quoted at
    expect(upliftPrice(253000, { mode: "percent", amount: 3 })).toBe(260600);
    expect(upliftPrice(253000, { mode: "percent", amount: 3 })! % ROUND_TO).toBe(0);
  });

  it("SKIPS a unit with no price rather than inventing one", () => {
    // +3% of "not priced yet" is not €100
    expect(upliftPrice(null, { mode: "percent", amount: 3 })).toBeNull();
    expect(upliftPrice("", { mode: "percent", amount: 3 })).toBeNull();
    expect(upliftPrice(0, { mode: "percent", amount: 3 })).toBeNull();
  });

  it("never produces a zero or negative price", () => {
    expect(upliftPrice(100000, { mode: "percent", amount: -100 })).toBe(ROUND_TO);
    expect(upliftPrice(100000, { mode: "fixed", amount: -999999 })).toBe(ROUND_TO);
  });

  it("reads the numeric strings postgres returns", () => {
    expect(upliftPrice("250000.00", { mode: "percent", amount: 3 })).toBe(257500);
  });

  it("a zero-amount uplift is a no-op, not a rounding event", () => {
    expect(upliftPrice(257531, { mode: "fixed", amount: 0 })).toBe(257500);
    expect(upliftPrice(250000, { mode: "fixed", amount: 0 })).toBe(250000);
  });
});

describe("previewUplift", () => {
  it("reports the rows that move, and the totals either side", () => {
    const p = previewUplift(
      [unit({ id: "a" }), unit({ id: "b", asking_price: 300000 })],
      { mode: "percent", amount: 10 },
    );
    expect(p.rows).toEqual([
      { id: "a", reference: "PAF0002-a", from: 250000, to: 275000 },
      { id: "b", reference: "PAF0002-b", from: 300000, to: 330000 },
    ]);
    expect(p.totalBefore).toBe(550000);
    expect(p.totalAfter).toBe(605000);
  });

  it("counts unpriced units as skipped, not as changes", () => {
    const p = previewUplift([unit({ id: "a", asking_price: null })], {
      mode: "percent",
      amount: 3,
    });
    expect(p.rows).toHaveLength(0);
    expect(p.skipped).toBe(1);
    expect(p.totalBefore).toBe(0);
  });

  it("counts a unit whose rounded price does not move as unchanged", () => {
    const p = previewUplift([unit({ id: "a", asking_price: 250000 })], {
      mode: "fixed",
      amount: 10, // rounds back to 250000
    });
    expect(p.rows).toHaveLength(0);
    expect(p.unchanged).toBe(1);
    // it still counts toward both totals — it IS in scope and priced
    expect(p.totalBefore).toBe(250000);
    expect(p.totalAfter).toBe(250000);
  });

  it("is empty-safe", () => {
    expect(previewUplift([], { mode: "percent", amount: 3 })).toEqual({
      rows: [],
      skipped: 0,
      unchanged: 0,
      totalBefore: 0,
      totalAfter: 0,
    });
  });
});

describe("scope", () => {
  const units = [
    unit({ id: "a", block: "A" }),
    unit({ id: "b", block: "B" }),
    unit({ id: "c", block: "A" }),
    unit({ id: "d", block: null }),
  ];

  it("lists the distinct blocks, sorted, ignoring blockless units", () => {
    expect(blocksOf(units)).toEqual(["A", "B"]);
  });

  it("null scope means every unit, including blockless ones", () => {
    expect(inScope(units, null)).toHaveLength(4);
  });

  it("a block scope covers only that block", () => {
    expect(inScope(units, "A").map((u) => u.id)).toEqual(["a", "c"]);
  });
});

/**
 * Exact decimals (T-price-uplift-atomic, 0141): the database computes the
 * write in numeric, and this preview must agree with it digit for digit —
 * supabase/tests/price-list-version.test.ts compares the two on a real stack.
 * These pin the arithmetic itself, independently of the database.
 */
describe("exact arithmetic — the €100 rule at a half", () => {
  it("a half rounds UP, where floating point rounded it down", () => {
    // 50000 × 1.001 = 50050 exactly; in float64 it is 50049.999…, which the
    // pre-0141 preview (and write) rounded to 50000
    expect(upliftPrice(50000, { mode: "percent", amount: 0.1 })).toBe(50100);
    expect(upliftPrice(150000, { mode: "percent", amount: 0.1 })).toBe(150200);
    expect(upliftPrice(250000, { mode: "percent", amount: 0.02 })).toBe(250100);
    // and just under a half rounds down
    expect(upliftPrice(49999, { mode: "percent", amount: 0.1 })).toBe(50000);
  });

  it("decimal prices and amounts: the cents decide", () => {
    expect(upliftPrice("1234.56", { mode: "fixed", amount: 15.44 })).toBe(1300); // 1250.00 → half → up
    expect(upliftPrice("1234.56", { mode: "fixed", amount: 15.43 })).toBe(1200); // 1249.99 → down
    expect(upliftPrice(1234.56, { mode: "fixed", amount: 15.44 })).toBe(1300);
    expect(upliftPrice("1000.00", { mode: "percent", amount: 5 })).toBe(1100); // 1050 → half → up
  });

  it("every way a number can be spelled reads the same digits", () => {
    expect(upliftPrice("250000.00", { mode: "percent", amount: 3 })).toBe(257500);
    expect(upliftPrice("2.5e5", { mode: "percent", amount: 3 })).toBe(257500);
    expect(upliftPrice(250000, { mode: "percent", amount: 1e-7 })).toBe(250000); // String(1e-7) is "1e-7"
    expect(upliftPrice("1e3", { mode: "fixed", amount: 100 })).toBe(1100);
    expect(upliftPrice(100000, { mode: "fixed", amount: -1e21 })).toBe(MIN_PRICE); // String(-1e21) is "-1e+21"
  });

  it("cuts: half away from zero, then never below the floor", () => {
    expect(upliftPrice(250000, { mode: "percent", amount: -0.1 })).toBe(249800); // 249750 → half → away from zero = up
    expect(upliftPrice(100000, { mode: "percent", amount: -150 })).toBe(MIN_PRICE);
    expect(upliftPrice(100, { mode: "fixed", amount: -50 })).toBe(MIN_PRICE);
    expect(upliftPrice(149.99, { mode: "fixed", amount: -50 })).toBe(MIN_PRICE);
  });

  it("an amount that is not a finite number prices nothing", () => {
    expect(upliftPrice(250000, { mode: "percent", amount: Number.NaN })).toBeNull();
    expect(upliftPrice(250000, { mode: "fixed", amount: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("whole euros and whole percents agree with plain integer arithmetic, everywhere on a grid", () => {
    // an independent reference: price × (100 + pct) is an integer; to the
    // nearest multiple of 10 000 (half up, all positive here) is hundreds
    for (let price = 100; price <= 300_000; price += 997) {
      for (const pct of [-99, -37, -10, -3, -1, 1, 2, 3, 5, 7, 10, 25, 100]) {
        const x = price * (100 + pct);
        const want = Math.max(Math.floor((x + 5000) / 10000) * 100, MIN_PRICE);
        expect(upliftPrice(price, { mode: "percent", amount: pct }), `${price} ${pct}%`).toBe(want);
      }
    }
  });
});

describe("reviewedScope", () => {
  it("sends every unit the preview covered, priced or not, with the price it showed", () => {
    expect(
      reviewedScope([
        unit({ id: "a", asking_price: "250000.00" }),
        unit({ id: "b", asking_price: null }),
        unit({ id: "c", asking_price: 0 }),
      ]),
    ).toEqual([
      { id: "a", price: 250000 },
      { id: "b", price: null },
      { id: "c", price: 0 },
    ]);
  });
});
