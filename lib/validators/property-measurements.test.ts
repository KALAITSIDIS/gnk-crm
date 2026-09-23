import { describe, expect, it } from "vitest";
import {
  MEASUREMENT_FIELDS,
  MIN_AREA_SQM,
  areaProblem,
  floorProblem,
  measurementProblem,
} from "./property-measurements";

/**
 * The four measurement rules (LST-07; audit 2026-09-23). One pure definition,
 * read by the Zod schemas, the unit-type stamp, the unit writer and the CSV
 * importer — and held for every other path by migration 0113's CHECKs;
 * supabase/tests/property-measurements.test.ts checks the database refuses
 * exactly what this module refuses, case by case.
 */
describe("areaProblem — a known area is positive AS STORED", () => {
  it.each([
    [0, /greater than 0/],
    [-5, /greater than 0/],
    ["0.00", /greater than 0/],
  ])("refuses %s", (value, message) => {
    expect(areaProblem("Covered area", value)).toMatch(message);
  });

  it("refuses a positive value the numeric(10,2) column would store as 0.00", () => {
    // 0.004::numeric(10,2) = 0.00 (measured); `.positive()` alone let it through
    expect(areaProblem("Plot area", 0.004)).toMatch(/at least 0\.01/);
  });

  it.each([MIN_AREA_SQM, 0.5, 85, "240.50", 99_999_999.99])("accepts %s", (value) => {
    expect(areaProblem("Covered area", value)).toBeNull();
  });

  it("treats a missing value as unknown, not as a problem", () => {
    expect(areaProblem("Covered area", null)).toBeNull();
    expect(areaProblem("Covered area", undefined)).toBeNull();
  });

  it("names the field it is about", () => {
    expect(areaProblem("Plot area", 0)).toMatch(/^Plot area /);
  });
});

describe("floorProblem — a known floor is not above its building's known height", () => {
  it("refuses floor 9 of 3 (the reproduced finding)", () => {
    expect(floorProblem(9, 3)).toMatch(/^Floor 9 is above .*\(3\)/);
  });

  it("refuses one floor too many", () => {
    expect(floorProblem(4, 3)).not.toBeNull();
  });

  it.each([
    [0, 3, "the ground floor"],
    [-1, 3, "a basement"],
    [-2, 0, "a basement under a building recorded with 0 floors"],
    [3, 3, "the top floor when total_floors counts the storeys above ground"],
    [2, 4, "an ordinary stacked flat"],
  ])("accepts floor %s of %s (%s)", (floor, total) => {
    expect(floorProblem(floor, total)).toBeNull();
  });

  it("has nothing to compare while either value is unknown", () => {
    expect(floorProblem(9, null)).toBeNull();
    expect(floorProblem(null, 3)).toBeNull();
    expect(floorProblem(undefined, undefined)).toBeNull();
  });
});

describe("measurementProblem — the whole row, as it will be stored", () => {
  it("covers exactly the four columns 0113 constrains", () => {
    expect([...MEASUREMENT_FIELDS].sort()).toEqual(
      ["covered_area_sqm", "floor_number", "plot_area_sqm", "total_floors"],
    );
  });

  it("returns the offending FIELD with its message", () => {
    expect(measurementProblem({ covered_area_sqm: 0 })).toEqual({
      field: "covered_area_sqm",
      message: expect.stringMatching(/^Covered area must be greater than 0/),
    });
    expect(measurementProblem({ plot_area_sqm: -1 })?.field).toBe("plot_area_sqm");
    expect(measurementProblem({ floor_number: 9, total_floors: 3 })?.field).toBe("floor_number");
  });

  it("reads a stored total the save did not touch (a partial write cannot pair a new floor with it)", () => {
    const stored = { floor_number: null, total_floors: 3, covered_area_sqm: 85, plot_area_sqm: null };
    expect(measurementProblem({ ...stored, floor_number: 9 })?.field).toBe("floor_number");
  });

  it("passes a valid row, blanks and legitimate zeros elsewhere included", () => {
    // a whole stored row, as the callers pass one
    const row = {
      covered_area_sqm: 85,
      plot_area_sqm: null,
      floor_number: -1,
      total_floors: 3,
      // not measurement columns: zero is a real answer for these
      bedrooms: 0,
      parking_spaces: 0,
      veranda_sqm: 0,
    };
    expect(measurementProblem(row)).toBeNull();
    expect(measurementProblem({})).toBeNull();
  });
});
