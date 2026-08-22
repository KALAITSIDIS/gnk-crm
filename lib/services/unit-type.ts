/**
 * Unit type templates (migration 0039).
 *
 * A real project sells four or five layouts repeated across every floor — "A1,
 * two-bed corner, 85 m²". Defining one and stamping it beats retyping beds,
 * baths and area per block and then pricing every unit by hand.
 *
 * A TYPE IS A STAMP, NOT A LINK. Applying it copies its values; the unit is not
 * bound to them afterwards, and there is deliberately no drift panel for types.
 * Bedrooms, area and price are in `DELIBERATELY_NOT_INHERITED` for the same
 * reason: two units of one layout can legitimately diverge.
 */

import { ROUND_TO } from "@/lib/services/price-uplift";

export interface UnitType {
  id: string;
  code: string;
  name: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  covered_area_sqm: number | string | null;
  veranda_sqm: number | string | null;
  price_per_sqm: number | string | null;
}

const num = (v: number | string | null): number | null => {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The asking price a type implies, or null when it cannot say.
 *
 * COVERED AREA ONLY. How a desk prices a veranda — half rate, quarter, not at
 * all — is a commercial decision that varies by project, and inventing a
 * convention here would put a wrong number on a quote. The veranda is recorded
 * on the type and shown on the unit; it just does not drive the price.
 *
 * Rounded to the same €100 the bulk uplift uses, and for the same reason: a
 * price is quoted at a round number, and 85 × 2941 is not one.
 */
export function priceFromType(type: Pick<UnitType, "covered_area_sqm" | "price_per_sqm">): number | null {
  const area = num(type.covered_area_sqm);
  const rate = num(type.price_per_sqm);
  if (area === null || rate === null || area <= 0 || rate <= 0) return null;
  return Math.round((area * rate) / ROUND_TO) * ROUND_TO;
}

export interface UnitTypeStamp {
  bedrooms: number | null;
  bathrooms: number | null;
  covered_area_sqm: number | null;
  veranda_sqm: number | null;
  asking_price: number | null;
}

/**
 * The columns applying a type writes onto a unit.
 *
 * A field the type leaves blank is written as null rather than skipped —
 * stamping "A1" onto a unit should make it an A1, not an A1 with whatever the
 * previous layout's bathroom count happened to be. That is the difference
 * between a stamp and a merge, and the surprising version is the merge.
 *
 * The price is the exception: a type with no rate leaves the unit's existing
 * price ALONE rather than clearing it. A layout template is a statement about
 * the flat, not about what it is worth today, and wiping a price nobody asked
 * to change would be destructive.
 */
export function stampOf(type: UnitType, currentPrice: number | string | null): UnitTypeStamp {
  const computed = priceFromType(type);
  return {
    bedrooms: type.bedrooms ?? null,
    bathrooms: type.bathrooms ?? null,
    covered_area_sqm: num(type.covered_area_sqm),
    veranda_sqm: num(type.veranda_sqm),
    asking_price: computed ?? num(currentPrice),
  };
}

/** A one-line description for the picker: "A1 · 2 bed · 85 m² · €250.000". */
export function describeType(type: UnitType): string {
  const parts = [type.code];
  if (type.name) parts.push(type.name);
  if (type.bedrooms !== null) parts.push(`${type.bedrooms} bed`);
  const area = num(type.covered_area_sqm);
  if (area !== null) parts.push(`${area} m²`);
  const price = priceFromType(type);
  if (price !== null) parts.push(`€${price.toLocaleString("de-DE")}`);
  return parts.join(" · ");
}
