import { describe, expect, it } from "vitest";
import { saveBuyerRequirementSchema } from "./buyer-requirements";
import { SELECT_NONE } from "./contacts";

const CONTACT = "11111111-1111-4111-8111-111111111111";
const DISTRICT = "22222222-2222-4222-8222-222222222222";

const base = { contact_id: CONTACT };
const parse = (over: Record<string, unknown> = {}) =>
  saveBuyerRequirementSchema.safeParse({ ...base, ...over });

describe("saveBuyerRequirementSchema — the empty-string trap", () => {
  it("leaves a blank budget UNSET rather than turning it into zero", () => {
    // THE BUG THIS GUARDS. An untouched number input posts "", and Number("")
    // is 0 — so a naive coercion gives a €0 ceiling, which matches nothing, and
    // the desk sees an empty result list with no explanation.
    const r = parse({ budget_min: "", budget_max: "" });
    expect(r.success).toBe(true);
    expect(r.data!.budget_max).toBeUndefined();
    expect(r.data!.budget_min).toBeUndefined();
  });

  it("leaves every optional numeric unset when blank, not zero", () => {
    const r = parse({
      bedrooms_min: "",
      bedrooms_max: "",
      bathrooms_min: "",
      covered_area_min_sqm: "",
      plot_area_min_sqm: "",
      max_sea_distance_m: "",
    });
    expect(r.success).toBe(true);
    for (const k of [
      "bedrooms_min",
      "bedrooms_max",
      "bathrooms_min",
      "covered_area_min_sqm",
      "plot_area_min_sqm",
      "max_sea_distance_m",
    ] as const) {
      expect(r.data![k], `${k} must be undefined, not 0`).toBeUndefined();
    }
  });

  it("still accepts a real zero when one is typed", () => {
    // 0 is a legitimate sea distance (beachfront). Blank and zero must differ.
    const r = parse({ max_sea_distance_m: "0" });
    expect(r.success).toBe(true);
    expect(r.data!.max_sea_distance_m).toBe(0);
  });

  it("treats the Radix clear sentinel as unset", () => {
    const r = parse({ vat_preference: SELECT_NONE });
    expect(r.success).toBe(true);
    expect(r.data!.vat_preference).toBeUndefined();
  });

  it("coerces numeric strings, because FormData has no numbers", () => {
    const r = parse({ budget_max: "300000", bedrooms_min: "2" });
    expect(r.success).toBe(true);
    expect(r.data!.budget_max).toBe(300000);
    expect(r.data!.bedrooms_min).toBe(2);
  });
});

describe("saveBuyerRequirementSchema — bands", () => {
  it("rejects a budget floor above its ceiling, on the right field", () => {
    const r = parse({ budget_min: "400000", budget_max: "300000" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(["budget_min"]);
    expect(r.error!.issues[0]!.message).toMatch(/cannot be above/i);
  });

  it("rejects a bedroom floor above its ceiling", () => {
    const r = parse({ bedrooms_min: "4", bedrooms_max: "2" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(["bedrooms_min"]);
  });

  it("allows a band with only one side set, and an equal band", () => {
    expect(parse({ budget_max: "300000" }).success).toBe(true);
    expect(parse({ budget_min: "300000" }).success).toBe(true);
    expect(parse({ budget_min: "300000", budget_max: "300000" }).success).toBe(true);
    expect(parse({ bedrooms_min: "2", bedrooms_max: "2" }).success).toBe(true);
  });

  it("rejects a negative budget", () => {
    expect(parse({ budget_max: "-1" }).success).toBe(false);
  });
});

describe("saveBuyerRequirementSchema — arrays from FormData", () => {
  it("accepts repeated keys as an array and a lone value as a one-element array", () => {
    expect(parse({ property_types: ["villa", "apartment"] }).data!.property_types).toEqual([
      "villa",
      "apartment",
    ]);
    expect(parse({ property_types: "villa" }).data!.property_types).toEqual(["villa"]);
  });

  it("defaults a missing array to empty, which means NO OPINION not no match", () => {
    const r = parse();
    expect(r.success).toBe(true);
    expect(r.data!.property_types).toEqual([]);
    expect(r.data!.district_ids).toEqual([]);
    expect(r.data!.features_required).toEqual([]);
  });

  it("drops an unknown feature key instead of storing a criterion nothing can satisfy", () => {
    const r = parse({ features_required: ["sea_view", "teleporter", "private_pool"] });
    expect(r.success).toBe(true);
    expect(r.data!.features_required).toEqual(["sea_view", "private_pool"]);
  });

  it("rejects a district id that is not a guid", () => {
    expect(parse({ district_ids: ["not-a-guid"] }).success).toBe(false);
    expect(parse({ district_ids: [DISTRICT] }).success).toBe(true);
  });

  it("rejects an unknown property type", () => {
    expect(parse({ property_types: ["castle"] }).success).toBe(false);
  });
});

describe("saveBuyerRequirementSchema — checkboxes and defaults", () => {
  it("reads an unchecked box as false and 'on' as true", () => {
    expect(parse().data!.title_deed_required).toBe(false);
    expect(parse({ title_deed_required: "on" }).data!.title_deed_required).toBe(true);
  });

  it("defaults the transaction type to sale", () => {
    expect(parse().data!.transaction_type).toBe("sale");
  });

  it("requires a contact — a requirement with no buyer is not a requirement", () => {
    const r = saveBuyerRequirementSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});
