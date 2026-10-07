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
 *
 * The stamp itself is written by the database (`apply_unit_type`, migration
 * 0142) in one transaction: beds, baths, covered area and veranda copied — a
 * field the type leaves blank is written as null, a stamp and not a merge —
 * and the price set only when the type has a rate. A type with no rate leaves
 * each unit's price as the database holds it: a layout template is a
 * statement about the flat, not about what it is worth today.
 */

import { roundedProduct } from "@/lib/services/price-uplift";

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
 * price is quoted at a round number, and 85 × 2941 is not one. EXACT — a half
 * rounds up, as `round(covered × rate, −2)` does in 0142 — so the figure the
 * picker shows is the figure the stamp writes (in floating point, 64.35 × 1000
 * came out €64.300 instead of €64.400).
 */
export function priceFromType(type: Pick<UnitType, "covered_area_sqm" | "price_per_sqm">): number | null {
  const area = num(type.covered_area_sqm);
  const rate = num(type.price_per_sqm);
  if (area === null || rate === null || area <= 0 || rate <= 0) return null;
  return roundedProduct(type.covered_area_sqm!, type.price_per_sqm!);
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
