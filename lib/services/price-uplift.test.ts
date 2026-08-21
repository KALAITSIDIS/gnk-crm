import { describe, expect, it } from "vitest";
import {
  blocksOf,
  inScope,
  previewUplift,
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
