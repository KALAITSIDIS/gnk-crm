import { describe, expect, it } from "vitest";
import {
  generateUnits,
  generateVillaUnits,
  generatedCount,
  MAX_GENERATED_UNITS,
  priceFor,
  unitNumberFor,
  villaCount,
  villaNumberFor,
  villaPriceFor,
} from "./unit-generator";

describe("unitNumberFor", () => {
  it("uses the floor-then-two-digit-index convention", () => {
    expect(unitNumberFor(3, 1)).toBe("301");
    expect(unitNumberFor(3, 4)).toBe("304");
    expect(unitNumberFor(1, 1)).toBe("101");
  });

  it("keeps floor 10 unambiguous against floor 1", () => {
    // one digit for the index would make floor 10 unit 1 read as "101",
    // colliding with floor 1 unit 1 — sixty rows later nobody would notice
    expect(unitNumberFor(10, 1)).toBe("1001");
    expect(unitNumberFor(1, 1)).toBe("101");
    expect(unitNumberFor(10, 1)).not.toBe(unitNumberFor(1, 1));
  });

  it("handles the ground floor", () => {
    expect(unitNumberFor(0, 1)).toBe("001");
  });
});

describe("priceFor", () => {
  const spec = { basePrice: 250000, pricePerFloor: 5000, floorFrom: 1 };

  it("charges the base on the first floor and climbs with height", () => {
    expect(priceFor(spec, 1)).toBe(250000);
    expect(priceFor(spec, 2)).toBe(255000);
    expect(priceFor(spec, 5)).toBe(270000);
  });

  it("returns null with no base — a generated 0 would read as a real price", () => {
    expect(priceFor({ basePrice: null, pricePerFloor: 5000, floorFrom: 1 }, 3)).toBeNull();
    expect(priceFor({ floorFrom: 1 }, 3)).toBeNull();
  });

  it("treats a missing increment as a flat price", () => {
    expect(priceFor({ basePrice: 200000, floorFrom: 1 }, 7)).toBe(200000);
  });

  it("measures the climb from floorFrom, not from zero", () => {
    // a block starting at floor 5 must not be charged 5 increments on its
    // cheapest unit
    expect(priceFor({ basePrice: 300000, pricePerFloor: 10000, floorFrom: 5 }, 5)).toBe(300000);
    expect(priceFor({ basePrice: 300000, pricePerFloor: 10000, floorFrom: 5 }, 6)).toBe(310000);
  });
});

describe("generatedCount", () => {
  it("multiplies floors by units per floor", () => {
    expect(generatedCount({ floorFrom: 1, floorTo: 5, perFloor: 4 })).toBe(20);
    expect(generatedCount({ floorFrom: 1, floorTo: 1, perFloor: 1 })).toBe(1);
  });

  it("is zero for an inverted or empty range rather than negative", () => {
    expect(generatedCount({ floorFrom: 5, floorTo: 1, perFloor: 4 })).toBe(0);
    expect(generatedCount({ floorFrom: 1, floorTo: 5, perFloor: 0 })).toBe(0);
  });

  it("agrees with what generateUnits actually produces", () => {
    const spec = { floorFrom: 2, floorTo: 6, perFloor: 3 };
    expect(generateUnits(spec)).toHaveLength(generatedCount(spec));
  });
});

describe("generateUnits", () => {
  it("produces the whole block, floor-ascending", () => {
    const units = generateUnits({ block: "A", floorFrom: 1, floorTo: 3, perFloor: 2 });
    expect(units.map((u) => u.label)).toEqual([
      "A101",
      "A102",
      "A201",
      "A202",
      "A301",
      "A302",
    ]);
  });

  it("carries the shared layout onto every unit", () => {
    const units = generateUnits({
      floorFrom: 1,
      floorTo: 2,
      perFloor: 1,
      bedrooms: 2,
      bathrooms: 1,
      coveredAreaSqm: 85,
    });
    for (const u of units) {
      expect(u.bedrooms).toBe(2);
      expect(u.bathrooms).toBe(1);
      expect(u.covered_area_sqm).toBe(85);
    }
  });

  it("prices each floor from its own height", () => {
    const units = generateUnits({
      floorFrom: 1,
      floorTo: 3,
      perFloor: 2,
      basePrice: 250000,
      pricePerFloor: 5000,
    });
    expect(units.map((u) => u.asking_price)).toEqual([
      250000, 250000, 255000, 255000, 260000, 260000,
    ]);
  });

  it("works with no block at all", () => {
    const units = generateUnits({ floorFrom: 2, floorTo: 2, perFloor: 2 });
    expect(units.map((u) => u.label)).toEqual(["201", "202"]);
    expect(units[0].block).toBeNull();
  });

  it("treats a whitespace-only block as no block", () => {
    expect(generateUnits({ block: "   ", floorFrom: 1, floorTo: 1, perFloor: 1 })[0].block)
      .toBeNull();
  });

  it("honours a custom start index", () => {
    const units = generateUnits({ floorFrom: 4, floorTo: 4, perFloor: 3, startIndex: 5 });
    expect(units.map((u) => u.unit_number)).toEqual(["405", "406", "407"]);
  });

  it("never produces two units with the same label", () => {
    const units = generateUnits({ block: "A", floorFrom: 0, floorTo: 12, perFloor: 8 });
    const labels = units.map((u) => u.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("a realistic 60-unit block stays inside the ceiling", () => {
    const spec = { block: "A", floorFrom: 1, floorTo: 15, perFloor: 4 };
    expect(generatedCount(spec)).toBe(60);
    expect(generatedCount(spec)).toBeLessThanOrEqual(MAX_GENERATED_UNITS);
  });
});

/**
 * Villas do not stack. Every pin here is a thing the floor grid would have got
 * wrong if it had been reused with floorFrom = floorTo = 1.
 */
describe("villaNumberFor", () => {
  it("pads to the width of the run so text ordering reads correctly", () => {
    expect(villaNumberFor("V", 1, 2)).toBe("V01");
    expect(villaNumberFor("V", 12, 2)).toBe("V12");
  });

  it("takes no prefix at all when none is given", () => {
    expect(villaNumberFor(null, 3, 2)).toBe("03");
  });
});

describe("villaPriceFor", () => {
  it("climbs by the per-villa step, not by floor", () => {
    const spec = { basePrice: 800000, pricePerVilla: 25000 };
    expect(villaPriceFor(spec, 0)).toBe(800000);
    expect(villaPriceFor(spec, 3)).toBe(875000);
  });

  it("stays null without a base — an invented 0 would read as a real price", () => {
    expect(villaPriceFor({ basePrice: null, pricePerVilla: 25000 }, 2)).toBeNull();
  });

  it("a flat complex needs no step", () => {
    expect(villaPriceFor({ basePrice: 750000, pricePerVilla: null }, 5)).toBe(750000);
  });
});

describe("generateVillaUnits", () => {
  it("numbers V01..V12 for a twelve-villa complex", () => {
    const villas = generateVillaUnits({ prefix: "V", count: 12 });
    expect(villas).toHaveLength(12);
    expect(villas[0].label).toBe("V01");
    expect(villas[11].label).toBe("V12");
  });

  it("NEVER writes a floor number — the matrix and the share would print the lie", () => {
    const villas = generateVillaUnits({ prefix: "V", count: 4 });
    expect(villas.every((v) => v.floor_number === null)).toBe(true);
  });

  it("leaves `block` free — it is the repricing scope, not a label", () => {
    const villas = generateVillaUnits({ prefix: "V", count: 3 });
    expect(villas.every((v) => v.block === null)).toBe(true);
  });

  it("carries a plot size, which a stacked unit never has", () => {
    const villas = generateVillaUnits({ prefix: "V", count: 2, plotAreaSqm: 520 });
    expect(villas.map((v) => v.plot_area_sqm)).toEqual([520, 520]);
  });

  it("pads to three digits past ninety-nine villas", () => {
    const villas = generateVillaUnits({ prefix: "V", count: 100 });
    expect(villas[0].label).toBe("V001");
    expect(villas[99].label).toBe("V100");
  });

  it("honours a custom start number", () => {
    const villas = generateVillaUnits({ prefix: "V", count: 3, startNumber: 7 });
    expect(villas.map((v) => v.label)).toEqual(["V07", "V08", "V09"]);
  });

  it("never produces two villas with the same label", () => {
    const labels = generateVillaUnits({ prefix: "V", count: 40 }).map((v) => v.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("a zero or negative count builds nothing rather than throwing", () => {
    expect(generateVillaUnits({ count: 0 })).toEqual([]);
    expect(generateVillaUnits({ count: -3 })).toEqual([]);
    expect(villaCount({ count: 0 })).toBe(0);
  });

  it("a realistic complex stays inside the shared ceiling", () => {
    expect(villaCount({ count: 24 })).toBe(24);
    expect(villaCount({ count: 24 })).toBeLessThanOrEqual(MAX_GENERATED_UNITS);
  });

  it("prices the row, so the preview can show the range the desk will get", () => {
    const villas = generateVillaUnits({
      prefix: "V", count: 3, basePrice: 800000, pricePerVilla: 50000,
    });
    expect(villas.map((v) => v.asking_price)).toEqual([800000, 850000, 900000]);
  });
});
