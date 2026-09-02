import { describe, expect, it } from "vitest";
import { tallyContainerUnits, type TallyRow } from "./container-units";

/**
 * The definition of "a unit" that the publish gate, the score, the detail
 * page and the worklist share (2026-09-02 review). The first cut counted
 * every child row — so a project holding one EMPTY PHASE and no units
 * satisfied the non-overridable empty-container refusal, and a project whose
 * units all sit under phases counted as having none. These pin the in-memory
 * half; the query half (countContainerUnits) applies the same rules in SQL.
 */
const row = (over: Partial<TallyRow> & { id: string }): TallyRow => ({
  kind: "unit",
  parent_id: null,
  asking_price: null,
  ...over,
});

describe("tallyContainerUnits", () => {
  it("a phase is not a unit — a project with only an empty phase has no units", () => {
    const tally = tallyContainerUnits([
      row({ id: "P", kind: "project" }),
      row({ id: "PH", kind: "phase", parent_id: "P" }),
    ]);
    expect(tally.get("P")).toBeUndefined();
    expect(tally.get("PH")).toBeUndefined();
  });

  it("a unit under a phase counts for the phase AND for the project above it", () => {
    const tally = tallyContainerUnits([
      row({ id: "P", kind: "project" }),
      row({ id: "PH", kind: "phase", parent_id: "P" }),
      row({ id: "U1", parent_id: "PH", asking_price: "250000" }),
      row({ id: "U2", parent_id: "PH" }),
    ]);
    expect(tally.get("PH")).toEqual({ unitCount: 2, pricedUnitCount: 1 });
    expect(tally.get("P")).toEqual({ unitCount: 2, pricedUnitCount: 1 });
  });

  it("direct units and phased units add up on the project", () => {
    const tally = tallyContainerUnits([
      row({ id: "P", kind: "project" }),
      row({ id: "PH", kind: "phase", parent_id: "P" }),
      row({ id: "U1", parent_id: "P", asking_price: 100000 }),
      row({ id: "U2", parent_id: "PH", asking_price: 120000 }),
      row({ id: "U3", parent_id: "PH" }),
    ]);
    expect(tally.get("P")).toEqual({ unitCount: 3, pricedUnitCount: 2 });
    expect(tally.get("PH")).toEqual({ unitCount: 2, pricedUnitCount: 1 });
  });

  it("a standalone never accrues a tally, and a parentless unit is nobody's", () => {
    const tally = tallyContainerUnits([
      row({ id: "S", kind: "standalone", asking_price: 300000 }),
      row({ id: "orphan", parent_id: null, asking_price: 1 }),
    ]);
    expect(tally.size).toBe(0);
  });

  it("a price of 0 is a price; only null is unpriced (numeric arrives as a string)", () => {
    const tally = tallyContainerUnits([
      row({ id: "P", kind: "project" }),
      row({ id: "U1", parent_id: "P", asking_price: "0" }),
      row({ id: "U2", parent_id: "P", asking_price: 0 }),
      row({ id: "U3", parent_id: "P", asking_price: null }),
    ]);
    expect(tally.get("P")).toEqual({ unitCount: 3, pricedUnitCount: 2 });
  });
});
