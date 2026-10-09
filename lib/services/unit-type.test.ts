import { describe, expect, it } from "vitest";
import { describeType, priceFromType, type UnitType } from "./unit-type";

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

describe("priceFromType is exact — the figure the stamp (0142) writes", () => {
  it("a half rounds UP, as round(covered × rate, −2) does", () => {
    // in floating point 64.35 × 1000 / 100 is 643.4999…, which rounded DOWN to €64.300
    expect(priceFromType(type({ covered_area_sqm: 64.35, price_per_sqm: 1000 }))).toBe(64400);
    expect(priceFromType(type({ covered_area_sqm: "16.15", price_per_sqm: "1000.00" }))).toBe(16200);
    expect(priceFromType(type({ covered_area_sqm: 64.6, price_per_sqm: 250 }))).toBe(16200);
    // and a value just under a half still rounds down
    expect(priceFromType(type({ covered_area_sqm: 64.34, price_per_sqm: 1000 }))).toBe(64300);
  });

  it("agrees with integer arithmetic over a grid of areas and rates (two decimals each)", () => {
    // area and rate as the numeric(10,2) columns hold them: hundredths
    const disagreements: string[] = [];
    for (let a = 1; a <= 20000; a += 7) {
      for (const r of [100, 2941, 15050, 100000, 294135, 333333]) {
        const cents = BigInt(a) * BigInt(r); // area × rate × 10^4
        const unit = BigInt(1000000); // €100 at scale 10^4
        const q = cents / unit;
        const want = Number((cents % unit) * BigInt(2) >= unit ? q + BigInt(1) : q) * 100;
        const got = priceFromType(type({ covered_area_sqm: (a / 100).toFixed(2), price_per_sqm: (r / 100).toFixed(2) }));
        if (got !== want) disagreements.push(`${a / 100} × ${r / 100}: ${got} ≠ ${want}`);
      }
    }
    expect(disagreements).toEqual([]);
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
