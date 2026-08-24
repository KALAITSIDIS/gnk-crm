import { describe, expect, it } from "vitest";
import { buildSchedule, outstanding, type PlanInstallment } from "./payment-schedule";

const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

const STANDARD: PlanInstallment[] = [
  { label: "Reservation", pct: 10, due: "On reservation" },
  { label: "Contract", pct: 30, due: "On contract signing" },
  { label: "Completion", pct: 60, due: "On delivery" },
];

describe("buildSchedule — the money has to add up", () => {
  it("splits a clean plan exactly", () => {
    const s = buildSchedule(STANDARD, 250000);
    expect(s.lines.map((l) => l.amount)).toEqual([25000, 75000, 150000]);
    expect(sum(s.lines.map((l) => l.amount))).toBe(250000);
    expect(s.scheduleTotal).toBe(250000);
    expect(s.totalPct).toBe(100);
  });

  it("makes the LAST line absorb rounding drift, so the lines sum to the total", () => {
    // THE CASE THIS FUNCTION EXISTS FOR. Three 33.333% lines on 100.000 are
    // 33.333,00 each — a euro short. Rounding each line and hoping is how a
    // schedule ends up not summing to what the buyer was quoted.
    const thirds: PlanInstallment[] = [
      { label: "A", pct: 33.333 },
      { label: "B", pct: 33.333 },
      { label: "C", pct: 33.334 },
    ];
    const s = buildSchedule(thirds, 100000);
    expect(sum(s.lines.map((l) => l.amount))).toBe(s.scheduleTotal);
    expect(s.scheduleTotal).toBe(100000);
  });

  it("keeps the lines summing to the total across many awkward prices", () => {
    // A property function should not be true only for the number I picked.
    for (const price of [99999.99, 137500.5, 1, 7, 250000.01, 333333.33, 1234567.89]) {
      const s = buildSchedule(STANDARD, price);
      expect(sum(s.lines.map((l) => l.amount)), `price ${price}`).toBe(s.scheduleTotal);
    }
  });

  it("does NOT scale a partial plan up to 100%", () => {
    // A plan adding to 90 means 90% is scheduled and 10% is not yet agreed.
    // Scaling it would silently invent money the desk never quoted.
    const partial: PlanInstallment[] = [
      { label: "Reservation", pct: 10 },
      { label: "Contract", pct: 80 },
    ];
    const s = buildSchedule(partial, 200000);
    expect(s.totalPct).toBe(90);
    expect(s.scheduleTotal).toBe(180000);
    expect(sum(s.lines.map((l) => l.amount))).toBe(180000);
  });

  it("reports a plan that overshoots rather than clamping it", () => {
    const over: PlanInstallment[] = [
      { label: "A", pct: 60 },
      { label: "B", pct: 60 },
    ];
    const s = buildSchedule(over, 100000);
    expect(s.totalPct, "the UI needs to be able to say 120%").toBe(120);
    expect(s.scheduleTotal).toBe(120000);
  });

  it("carries the milestone text through, and normalises a blank one to null", () => {
    const s = buildSchedule(
      [
        { label: "A", pct: 50, due: "  On signing  " },
        { label: "B", pct: 50, due: "   " },
      ],
      100000,
    );
    expect(s.lines[0]!.milestone).toBe("On signing");
    expect(s.lines[1]!.milestone, "blank milestone is null, not an empty string").toBeNull();
  });

  it("drops unusable lines instead of producing zero-value rows", () => {
    const messy: PlanInstallment[] = [
      { label: "Real", pct: 50 },
      { label: "", pct: 25 },
      { label: "Zero", pct: 0 },
      { label: "Negative", pct: -10 },
      { label: "NaN", pct: Number.NaN },
    ];
    const s = buildSchedule(messy, 100000);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]!.label).toBe("Real");
  });

  it("returns an empty schedule rather than throwing on an unpriced unit", () => {
    // 0041 ships an unpriced unit on purpose; a reservation on one must not
    // produce a schedule of zeros that looks like a real quote.
    expect(buildSchedule(STANDARD, 0).lines).toEqual([]);
    expect(buildSchedule(STANDARD, Number.NaN).lines).toEqual([]);
    expect(buildSchedule([], 250000).lines).toEqual([]);
  });

  it("numbers the lines in plan order, because a schedule is read top to bottom", () => {
    const s = buildSchedule(STANDARD, 250000);
    expect(s.lines.map((l) => l.sortOrder)).toEqual([0, 1, 2]);
    expect(s.lines.map((l) => l.label)).toEqual(["Reservation", "Contract", "Completion"]);
  });
});

describe("outstanding", () => {
  it("treats an unpaid line as zero paid, not as missing", () => {
    const r = outstanding([
      { amount: 25000, paidAmount: 25000 },
      { amount: 75000, paidAmount: null },
      { amount: 150000, paidAmount: null },
    ]);
    expect(r.paid).toBe(25000);
    expect(r.due).toBe(225000);
  });

  it("handles a part payment", () => {
    const r = outstanding([{ amount: 25000, paidAmount: 10000 }]);
    expect(r.paid).toBe(10000);
    expect(r.due).toBe(15000);
  });

  it("does not go negative on an overpayment — it reports it", () => {
    const r = outstanding([{ amount: 25000, paidAmount: 30000 }]);
    expect(r.paid).toBe(30000);
    expect(r.due, "an overpayment shows as negative due, not silently clamped").toBe(-5000);
  });
});
