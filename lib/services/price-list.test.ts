import { describe, expect, it } from "vitest";
import { comparePriceLists, summariseVersion, type PriceListItem } from "./price-list";

const item = (unit_id: string, list_price: number | string, label?: string): PriceListItem => ({
  unit_id,
  list_price,
  unit_label: label ?? unit_id,
});

describe("comparePriceLists", () => {
  it("reports the per-unit delta against the previous version", () => {
    const c = comparePriceLists(
      [item("a", 260000), item("b", 300000)],
      [item("a", 250000), item("b", 300000)],
    );
    expect(c.rows[0]).toMatchObject({ label: "a", price: 260000, previousPrice: 250000, delta: 10000 });
    expect(c.rows[0].deltaPct).toBeCloseTo(0.04);
    expect(c.rows[1].delta).toBe(0);
    expect(c.changedCount).toBe(1);
  });

  it("gives the FIRST version null deltas, not zeroes", () => {
    // a fabricated 0 reads as "we held the price", which is a different
    // statement from "there was no previous price"
    const c = comparePriceLists([item("a", 250000)], null);
    expect(c.rows[0].delta).toBeNull();
    expect(c.rows[0].deltaPct).toBeNull();
    expect(c.rows[0].previousPrice).toBeNull();
    expect(c.previousTotal).toBeNull();
    expect(c.totalDelta).toBeNull();
  });

  it("marks a unit added since the previous version as new", () => {
    const c = comparePriceLists([item("a", 250000), item("b", 400000)], [item("a", 250000)]);
    const added = c.rows.find((r) => r.label === "b")!;
    expect(added.isNew).toBe(true);
    expect(added.delta).toBeNull();
    expect(c.newCount).toBe(1);
    // a new unit is not a reprice
    expect(c.changedCount).toBe(0);
  });

  it("COUNTS units that vanished rather than ignoring them", () => {
    // otherwise the two totals silently describe different inventory
    const c = comparePriceLists([item("a", 250000)], [item("a", 250000), item("gone", 999999)]);
    expect(c.droppedCount).toBe(1);
    expect(c.total).toBe(250000);
    expect(c.previousTotal).toBe(1249999);
    expect(c.totalDelta).toBe(-999999);
  });

  it("totals both versions and their difference", () => {
    const c = comparePriceLists(
      [item("a", 260000), item("b", 310000)],
      [item("a", 250000), item("b", 300000)],
    );
    expect(c.total).toBe(570000);
    expect(c.previousTotal).toBe(550000);
    expect(c.totalDelta).toBe(20000);
  });

  it("handles the numeric strings postgres returns", () => {
    const c = comparePriceLists([item("a", "260000.00")], [item("a", "250000.00")]);
    expect(c.total).toBe(260000);
    expect(c.rows[0].delta).toBe(10000);
  });

  it("does not divide by a zero previous price", () => {
    const c = comparePriceLists([item("a", 250000)], [item("a", 0)]);
    expect(c.rows[0].delta).toBe(250000);
    expect(c.rows[0].deltaPct).toBeNull(); // not Infinity
  });

  it("sorts by label so a version reads in unit order", () => {
    const c = comparePriceLists(
      [item("u3", 1, "A301"), item("u1", 1, "A101"), item("u2", 1, "A201")],
      null,
    );
    expect(c.rows.map((r) => r.label)).toEqual(["A101", "A201", "A301"]);
  });

  it("is empty-safe", () => {
    const c = comparePriceLists([], null);
    expect(c.rows).toEqual([]);
    expect(c.total).toBe(0);
    expect(c.droppedCount).toBe(0);
  });
});

describe("summariseVersion", () => {
  it("says what moved", () => {
    const c = comparePriceLists(
      [item("a", 260000), item("b", 300000), item("c", 400000)],
      [item("a", 250000), item("b", 300000)],
    );
    expect(summariseVersion(c)).toBe("3 units · 1 repriced · 1 new");
  });

  it("says only the count for a first version", () => {
    expect(summariseVersion(comparePriceLists([item("a", 1), item("b", 2)], null))).toBe("2 units");
  });

  it("mentions dropped units, because the totals stop being comparable", () => {
    const c = comparePriceLists([item("a", 1)], [item("a", 1), item("b", 2)]);
    expect(summariseVersion(c)).toContain("1 dropped");
  });
});
