import { describe, expect, it } from "vitest";
import {
  SERIES_MONTHS,
  computeVelocity,
  monthKey,
  soldAtFromEvents,
  type VelocityUnit,
} from "./sales-velocity";

const NOW = new Date("2026-08-25T09:00:00Z");

const unit = (over: Partial<VelocityUnit> = {}): VelocityUnit => ({
  id: Math.random().toString(36).slice(2),
  status: "available",
  soldAt: null,
  askingPrice: 200000,
  ...over,
});

/** ISO for the 15th of a month, mid-morning UTC — safely inside the Cyprus day */
const on = (month: string) => `${month}-15T09:00:00Z`;

describe("soldAtFromEvents reads BOTH event shapes", () => {
  it("reads the units-grid shape (status_changed)", () => {
    expect(
      soldAtFromEvents([
        {
          event_type: "status_changed",
          occurred_at: "2026-05-02T10:00:00Z",
          payload: { reference: "PAF0001-101", from: "reserved", to: "sold" },
        },
      ]),
    ).toBe("2026-05-02T10:00:00Z");
  });

  it("reads the details-form shape (updated, with a per-field diff)", () => {
    // the shape that would be MISSED by reading status_changed alone — and
    // missed silently, which is the whole point of handling it
    expect(
      soldAtFromEvents([
        {
          event_type: "updated",
          occurred_at: "2026-05-03T10:00:00Z",
          payload: { section: "details", changed: { status: { from: "available", to: "sold" } } },
        },
      ]),
    ).toBe("2026-05-03T10:00:00Z");
  });

  it("takes the EARLIEST sale when a unit round-tripped", () => {
    expect(
      soldAtFromEvents([
        { event_type: "status_changed", occurred_at: "2026-07-01T00:00:00Z", payload: { to: "sold" } },
        { event_type: "status_changed", occurred_at: "2026-03-01T00:00:00Z", payload: { to: "sold" } },
      ]),
    ).toBe("2026-03-01T00:00:00Z");
  });

  it("ignores transitions to anything else, and malformed payloads", () => {
    expect(
      soldAtFromEvents([
        { event_type: "status_changed", occurred_at: "2026-01-01T00:00:00Z", payload: { to: "reserved" } },
        { event_type: "updated", occurred_at: "2026-01-02T00:00:00Z", payload: { changed: { asking_price: { to: 1 } } } },
        { event_type: "updated", occurred_at: "2026-01-03T00:00:00Z", payload: null },
        { event_type: "created", occurred_at: "2026-01-04T00:00:00Z", payload: { status: "sold" } },
      ]),
    ).toBeNull();
  });

  it("returns null for a unit with no events at all", () => {
    expect(soldAtFromEvents([])).toBeNull();
  });
});

describe("computeVelocity", () => {
  it("handles an empty project without dividing by zero", () => {
    const r = computeVelocity([], NOW);
    expect(r.totalUnits).toBe(0);
    expect(r.absorptionPct).toBe(0);
    expect(r.monthsToSellOut).toBeNull();
    expect(r.months).toHaveLength(SERIES_MONTHS);
  });

  it("counts inventory by current status", () => {
    const r = computeVelocity(
      [
        unit({ status: "available" }),
        unit({ status: "available" }),
        unit({ status: "reserved" }),
        unit({ status: "sold", soldAt: on("2026-08") }),
        unit({ status: "withdrawn" }),
      ],
      NOW,
    );
    expect(r.totalUnits).toBe(5);
    expect(r.byStatus).toEqual({ available: 2, reserved: 1, sold: 1, withdrawn: 1 });
    expect(r.soldTotal).toBe(1);
    // withdrawn is not inventory anybody is still trying to shift
    expect(r.remaining).toBe(3);
    expect(r.absorptionPct).toBe(20);
  });

  it("buckets sales into Cyprus months and sums their value", () => {
    const r = computeVelocity(
      [
        unit({ status: "sold", soldAt: on("2026-07"), askingPrice: 100000 }),
        unit({ status: "sold", soldAt: on("2026-07"), askingPrice: 150000 }),
        unit({ status: "sold", soldAt: on("2026-08"), askingPrice: 200000 }),
        unit({ status: "available" }),
      ],
      NOW,
    );
    const july = r.months.find((m) => m.month === "2026-07")!;
    const aug = r.months.find((m) => m.month === "2026-08")!;
    expect(july.sold).toBe(2);
    expect(july.value).toBe(250000);
    expect(aug.sold).toBe(1);
    expect(aug.value).toBe(200000);
  });

  it("coerces a numeric that arrived as a STRING", () => {
    // the bug that silently killed the price-drop alert: PostgREST hands
    // `numeric` over as a string, so Number.isFinite("100000.00") is not the
    // test to run
    const r = computeVelocity(
      [unit({ status: "sold", soldAt: on("2026-08"), askingPrice: "175000.50" })],
      NOW,
    );
    expect(r.months.find((m) => m.month === "2026-08")!.value).toBe(175000.5);
  });

  it("treats an unpriced sold unit as zero value, not NaN", () => {
    const r = computeVelocity(
      [unit({ status: "sold", soldAt: on("2026-08"), askingPrice: null })],
      NOW,
    );
    const aug = r.months.find((m) => m.month === "2026-08")!;
    expect(aug.sold).toBe(1);
    expect(aug.value).toBe(0);
    expect(Number.isNaN(aug.value)).toBe(false);
  });

  it("surfaces sold units with no recorded date instead of hiding them", () => {
    const r = computeVelocity(
      [
        unit({ status: "sold", soldAt: on("2026-08") }),
        unit({ status: "sold", soldAt: null }),
        unit({ status: "sold", soldAt: null }),
      ],
      NOW,
    );
    expect(r.soldTotal, "all three count as sold").toBe(3);
    expect(r.soldDated, "only one can be placed on the chart").toBe(1);
    expect(r.soldUndated, "and the other two are declared, not dropped").toBe(2);
    // absorption uses the honest total, not just the datable ones
    expect(r.absorptionPct).toBe(100);
  });

  it("projects from the last 12 months, not from all time", () => {
    // 6 sold long ago, 3 in the last year: the pace that matters is 3/12
    const old = [on("2023-01"), on("2023-02"), on("2023-03"), on("2023-04"), on("2023-05"), on("2023-06")];
    const recent = [on("2026-02"), on("2026-05"), on("2026-08")];
    const units = [
      ...old.map((d) => unit({ status: "sold", soldAt: d })),
      ...recent.map((d) => unit({ status: "sold", soldAt: d })),
      ...Array.from({ length: 6 }, () => unit({ status: "available" })),
    ];
    const r = computeVelocity(units, NOW);
    expect(r.soldTotal).toBe(9);
    expect(r.soldLast12, "only the recent three").toBe(3);
    expect(r.perMonth).toBeCloseTo(0.25, 10);
    expect(r.remaining).toBe(6);
    expect(r.monthsToSellOut, "6 remaining at 0.25/month").toBeCloseTo(24, 10);
  });

  it("refuses to project when nothing has sold in a year", () => {
    const r = computeVelocity(
      [
        unit({ status: "sold", soldAt: on("2024-01") }),
        unit({ status: "available" }),
        unit({ status: "available" }),
      ],
      NOW,
    );
    expect(r.soldLast12).toBe(0);
    expect(r.perMonth).toBe(0);
    // "never" would be a claim and "0 months" would be a lie
    expect(r.monthsToSellOut).toBeNull();
  });

  it("keeps old sales in the totals even when they fall off the chart", () => {
    const r = computeVelocity(
      [unit({ status: "sold", soldAt: on("2019-01") }), unit({ status: "available" })],
      NOW,
    );
    expect(r.soldTotal, "counted").toBe(1);
    expect(r.soldDated, "and dated").toBe(1);
    expect(r.absorptionPct).toBe(50);
    expect(r.months.reduce((s, m) => s + m.sold, 0), "but off the left of the chart").toBe(0);
  });

  it("does not let a future-dated sale inflate the recent pace", () => {
    // clock skew on an import is the realistic way this arrives
    const r = computeVelocity(
      [unit({ status: "sold", soldAt: on("2027-06") })],
      NOW,
    );
    expect(r.soldLast12).toBe(0);
    expect(r.monthsToSellOut).toBeNull();
  });

  it("does not count a unit whose sale was reverted", () => {
    // the event says it sold; the current status says otherwise, and the
    // current status wins so the chart reconciles with the inventory beside it
    const r = computeVelocity(
      [unit({ status: "available", soldAt: on("2026-07") })],
      NOW,
    );
    expect(r.soldTotal).toBe(0);
    expect(r.months.reduce((s, m) => s + m.sold, 0)).toBe(0);
  });

  it("returns a contiguous ascending series ending this month", () => {
    const r = computeVelocity([], NOW);
    expect(r.months[r.months.length - 1]!.month).toBe("2026-08");
    expect(r.months[0]!.month).toBe("2024-09");
    const sorted = [...r.months].map((m) => m.month).sort();
    expect(r.months.map((m) => m.month)).toEqual(sorted);
  });

  it("crosses a year boundary correctly", () => {
    const r = computeVelocity([], new Date("2026-01-10T09:00:00Z"));
    expect(r.months[r.months.length - 1]!.month).toBe("2026-01");
    expect(r.months[0]!.month).toBe("2024-02");
  });
});

describe("monthKey uses Cyprus wall-clock, not UTC", () => {
  it("rolls a late-UTC instant into the next Cyprus month", () => {
    // 31 July 22:00 UTC is 1 August 01:00 in Cyprus (EEST, UTC+3)
    expect(monthKey("2026-07-31T22:00:00Z")).toBe("2026-08");
  });

  it("keeps an ordinary mid-month instant where it belongs", () => {
    expect(monthKey("2026-07-15T09:00:00Z")).toBe("2026-07");
  });
});
