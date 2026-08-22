import { describe, expect, it } from "vitest";
import { describeType, priceFromType, stampOf, type UnitType } from "./unit-type";

const type = (over: Partial<UnitType> = {}): UnitType => ({
  id: "t1",
  code: "A1",
  name: "Two-bed corner",
  bedrooms: 2,
  bathrooms: 1,
  covered_area_sqm: 85,
  veranda_sqm: 20,
  price_per_sqm: 3000,
  ...over,
});

describe("priceFromType", () => {
  it("prices covered area at the rate", () => {
    expect(priceFromType(type())).toBe(255000); // 85 × 3000
  });

  it("does NOT price the veranda", () => {
    // how a desk prices a veranda varies by project; inventing a convention
    // here would put a wrong number on a quote
    expect(priceFromType(type({ veranda_sqm: 200 }))).toBe(255000);
  });

  it("rounds to the €100 a price is quoted at", () => {
    expect(priceFromType(type({ covered_area_sqm: 85, price_per_sqm: 2941 }))).toBe(250000);
  });

  it("says nothing when it cannot say", () => {
    expect(priceFromType(type({ price_per_sqm: null }))).toBeNull();
    expect(priceFromType(type({ covered_area_sqm: null }))).toBeNull();
    expect(priceFromType(type({ price_per_sqm: 0 }))).toBeNull();
  });

  it("reads the numeric strings postgres returns", () => {
    expect(priceFromType(type({ covered_area_sqm: "85.00", price_per_sqm: "3000.00" }))).toBe(
      255000,
    );
  });
});

describe("stampOf", () => {
  it("writes the layout onto the unit", () => {
    expect(stampOf(type(), null)).toEqual({
      bedrooms: 2,
      bathrooms: 1,
      covered_area_sqm: 85,
      veranda_sqm: 20,
      asking_price: 255000,
    });
  });

  it("CLEARS a field the type leaves blank — a stamp, not a merge", () => {
    // stamping A1 onto a unit should make it an A1, not an A1 with the previous
    // layout's bathroom count still attached
    const s = stampOf(type({ bathrooms: null, veranda_sqm: null }), null);
    expect(s.bathrooms).toBeNull();
    expect(s.veranda_sqm).toBeNull();
  });

  it("LEAVES AN EXISTING PRICE ALONE when the type has no rate", () => {
    // a layout template says what the flat is, not what it is worth today —
    // wiping a price nobody asked to change would be destructive
    const s = stampOf(type({ price_per_sqm: null }), 260000);
    expect(s.asking_price).toBe(260000);
  });

  it("overwrites an existing price when the type CAN compute one", () => {
    expect(stampOf(type(), 999999).asking_price).toBe(255000);
  });

  it("leaves an unpriced unit unpriced when the type has no rate either", () => {
    expect(stampOf(type({ price_per_sqm: null }), null).asking_price).toBeNull();
  });
});

describe("describeType", () => {
  it("reads as one line in a picker", () => {
    expect(describeType(type())).toBe("A1 · Two-bed corner · 2 bed · 85 m² · €255.000");
  });

  it("degrades to whatever it knows", () => {
    expect(describeType(type({ name: null, bedrooms: null, price_per_sqm: null }))).toBe(
      "A1 · 85 m²",
    );
  });
});
