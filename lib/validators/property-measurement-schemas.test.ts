import { describe, expect, it } from "vitest";
import { createPropertySchema, detailsSectionSchema } from "./properties";

/**
 * Creation and editing apply the SAME measurement rules (LST-07; audit
 * 2026-09-23). Reproduced against a321de5: the details schema accepted floor 9
 * of 3 and a 0 m² covered or plot area, while the create schema refused 0 —
 * the same fact was valid or invalid depending on which form typed it.
 *
 * The cases below run through BOTH schemas wherever both carry the field, so
 * the two cannot drift apart again without a red test naming the case.
 */

const DISTRICT = "11111111-1111-4111-8111-111111111111";

/** Everything else a details save requires, all valid. */
const detailsBase = {
  status: "available",
  visibility: "private",
  transaction_type: "sale",
  vat_status: "unknown",
};
/** Everything else a create requires, all valid. */
const createBase = { kind: "standalone", property_type: "apartment", district_id: DISTRICT };

const details = (over: Record<string, unknown>) =>
  detailsSectionSchema.safeParse({ ...detailsBase, ...over });
const create = (over: Record<string, unknown>) =>
  createPropertySchema.safeParse({ ...createBase, ...over });

const issue = (r: ReturnType<typeof details> | ReturnType<typeof create>) =>
  r.success ? null : { path: r.error.issues[0]!.path.join("."), message: r.error.issues[0]!.message };

describe.each([
  ["details (edit)", details],
  ["create", create],
])("areas through %s", (_name, parse) => {
  it.each([
    ["covered_area_sqm", "0", /^Covered area must be greater than 0/],
    ["covered_area_sqm", "-5", /^Covered area must be greater than 0/],
    ["covered_area_sqm", "0.004", /^Covered area must be at least 0\.01/],
    ["plot_area_sqm", "0", /^Plot area must be greater than 0/],
    ["plot_area_sqm", "-1", /^Plot area must be greater than 0/],
  ])("refuses %s = %s with a message naming the field", (field, value, message) => {
    const r = parse({ [field]: value });
    expect(issue(r)).toEqual({ path: field, message: expect.stringMatching(message) });
  });

  it.each([
    ["covered_area_sqm", "85", 85],
    ["covered_area_sqm", "0.01", 0.01],
    ["plot_area_sqm", "1200.5", 1200.5],
  ])("accepts %s = %s", (field, value, parsed) => {
    const r = parse({ [field]: value });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>)[field]).toBe(parsed);
  });

  it.each([[""], ["   "], [null]])("reads a blank (%j) as UNKNOWN — never as 0", (blank) => {
    const r = parse({ covered_area_sqm: blank, plot_area_sqm: blank });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>).covered_area_sqm).toBeUndefined();
    expect((r.data as Record<string, unknown>).plot_area_sqm).toBeUndefined();
  });

  it("still accepts a legitimate zero where zero means something (a studio has 0 bedrooms)", () => {
    const r = parse({ bedrooms: "0" });
    expect(r.success).toBe(true);
    expect((r.data as { bedrooms?: number }).bedrooms).toBe(0);
  });
});

describe("the create wizard's generated-unit areas follow the same rule", () => {
  it.each([
    ["gen_covered_area_sqm", "0"],
    ["gen_plot_area_sqm", "0"],
    ["gen_covered_area_sqm", "0.004"],
  ])("refuses %s = %s", (field, value) => {
    const r = create({ kind: "project", [field]: value });
    expect(issue(r)?.path).toBe(field);
  });
});

describe("floors on the details form", () => {
  it("refuses floor 9 of 3 (the reproduced finding), on the Floor field", () => {
    expect(issue(details({ floor_number: "9", total_floors: "3" }))).toEqual({
      path: "floor_number",
      message: expect.stringMatching(/^Floor 9 is above the building's total floors \(3\)/),
    });
  });

  it.each([
    ["0", "3", "ground floor"],
    ["-1", "3", "basement"],
    ["3", "3", "top floor — total_floors' ground-storey convention is not fixed, so ≤ not <"],
    ["2", "", "floor known, height unknown"],
    ["", "5", "height known, floor unknown"],
    ["", "", "neither known"],
  ])("accepts floor %j of %j (%s)", (floor, total) => {
    expect(details({ floor_number: floor, total_floors: total }).success).toBe(true);
  });

  it("reads a whitespace floor as unknown — not as the ground floor", () => {
    // Number("  ") is 0: before this, a blank-looking floor was saved as 0
    const r = details({ floor_number: "  ", total_floors: " " });
    expect(r.success).toBe(true);
    expect(r.data?.floor_number).toBeUndefined();
    expect(r.data?.total_floors).toBeUndefined();
  });

  it("names the field when a floor is not a whole number", () => {
    expect(issue(details({ floor_number: "2.5" }))).toEqual({
      path: "floor_number",
      message: "Floor must be a whole number",
    });
    expect(issue(details({ total_floors: "-1" }))?.path).toBe("total_floors");
  });

  it("reports every refused field, the floor rule included, not only the first", () => {
    const r = details({ covered_area_sqm: "0", floor_number: "9", total_floors: "3" });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join("."))).toEqual(["covered_area_sqm", "floor_number"]);
  });

  it("leaves unrelated zeros alone: veranda, parking and bedrooms can be 0", () => {
    const r = details({ veranda_sqm: "0", parking_spaces: "0", bedrooms: "0", wc: "0" });
    expect(r.success).toBe(true);
  });
});
