import { z } from "zod";
import { FEATURE_KEYS } from "@/lib/constants/features";
import { SELECT_NONE } from "@/lib/validators/contacts";
import { PROPERTY_TYPES, TRANSACTION_TYPES, VAT_STATUSES } from "@/lib/validators/properties";

/**
 * Saved buyer searches (0043, T-B3).
 *
 * Mirrors `contacts.ts`'s coercion idiom deliberately, sentinel included: a
 * Radix Select cannot re-select an empty value, so a clearable select posts
 * SELECT_NONE and validation treats it as unset. Diverging here would mean two
 * ways to say "cleared" in one form.
 */

const emptyToUndefined = (v: unknown) =>
  v === "" || v === null || v === SELECT_NONE ? undefined : v;

/**
 * An untouched number input posts `""`, and `Number("")` is **0** — so a naive
 * `z.coerce.number()` turns a blank budget into a €0 ceiling that matches
 * nothing, and a blank bedroom floor into "at least 0 bedrooms", which is not
 * the same as no opinion. Every optional number here goes through this.
 */
const optNumber = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  z.number().min(0).finite().optional(),
);
const optInt = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  z.number().int().min(0).optional(),
);
const optText = (max: number) => z.preprocess(emptyToUndefined, z.string().max(max).optional());

/** Repeated form keys arrive as string[]; a single value arrives bare. */
const stringArray = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (Array.isArray(v) ? v.filter(Boolean) : v === undefined || v === "" ? [] : [v]),
    z.array(z.enum(values)).default([]),
  );

const guidArray = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter(Boolean) : v === undefined || v === "" ? [] : [v]),
  z.array(z.guid()).default([]),
);

/**
 * Feature keys, filtered to the known vocabulary rather than merely typed as
 * strings. `properties.features` is `z.array(z.string())`, but a REQUIREMENT is
 * different: an unknown key there is not cosmetic, it is a criterion that can
 * never be satisfied — the property side only ever holds keys from this same
 * list — so the requirement would silently score lower forever. Dropping the
 * unknown key is the honest behaviour, and features.ts already says never to
 * free-type these.
 */
const featureArray = z.preprocess((v) => {
  const raw = Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v];
  // FEATURE_KEYS is inferred as the narrow key union, so `.includes` will not
  // take a bare string; widen for the membership test only.
  const known = FEATURE_KEYS as readonly string[];
  return raw.filter((k) => typeof k === "string" && known.includes(k));
}, z.array(z.string()).default([]));

export const saveBuyerRequirementSchema = z
  .object({
    requirement_id: z.preprocess(emptyToUndefined, z.guid().optional()),
    contact_id: z.guid(),

    label: optText(120),
    transaction_type: z.enum(TRANSACTION_TYPES).default("sale"),

    property_types: stringArray(PROPERTY_TYPES),
    district_ids: guidArray,
    area_ids: guidArray,

    budget_min: optNumber,
    budget_max: optNumber,

    bedrooms_min: optInt,
    bedrooms_max: optInt,
    bathrooms_min: optInt,
    covered_area_min_sqm: optNumber,
    plot_area_min_sqm: optNumber,

    title_deed_required: z.preprocess((v) => v === "on" || v === true || v === "true", z.boolean()),
    vat_preference: z.preprocess(emptyToUndefined, z.enum(VAT_STATUSES).optional()),
    max_sea_distance_m: optInt,
    delivery_by: z.preprocess(emptyToUndefined, z.iso.date().optional()),
    features_required: featureArray,

    notes: optText(2000),
  })
  // The DB has matching CHECK constraints. These exist so the user sees a
  // sentence on the field instead of a Postgres constraint name in a toast —
  // the constraint is the backstop, not the first line of defence.
  .refine(
    (d) => d.budget_min === undefined || d.budget_max === undefined || d.budget_min <= d.budget_max,
    { message: "Minimum budget cannot be above the maximum", path: ["budget_min"] },
  )
  .refine(
    (d) =>
      d.bedrooms_min === undefined ||
      d.bedrooms_max === undefined ||
      d.bedrooms_min <= d.bedrooms_max,
    { message: "Minimum bedrooms cannot be above the maximum", path: ["bedrooms_min"] },
  );

export type SaveBuyerRequirementInput = z.infer<typeof saveBuyerRequirementSchema>;

export const archiveBuyerRequirementSchema = z.object({
  requirement_id: z.guid(),
  /** false archives, true restores — one action, both directions */
  is_active: z.preprocess((v) => v === "on" || v === true || v === "true", z.boolean()),
});

export const deleteBuyerRequirementSchema = z.object({
  requirement_id: z.guid(),
});
