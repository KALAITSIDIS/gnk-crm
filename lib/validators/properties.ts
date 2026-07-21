import { z } from "zod";

export const PROPERTY_TYPES = [
  "apartment",
  "villa",
  "townhouse",
  "house",
  "land",
  "shop",
  "office",
  "building",
  "hotel",
  "warehouse",
  "mixed_use",
  "other",
] as const;

export const TRANSACTION_TYPES = ["sale", "rent", "sale_or_rent"] as const;

export const PROPERTY_STATUSES = [
  "draft",
  "available",
  "reserved",
  "under_offer",
  "sold",
  "rented",
  "withdrawn",
] as const;

export const VISIBILITY_LEVELS = [
  "public",
  "private",
  "vip",
  "partner",
  "off_market",
  "coming_soon",
  "archived",
] as const;

export const MANDATE_FILTERS = ["active", "expired", "none"] as const;

/** Properties are never deleted (doc 04: properties DELETE ❌). The retire path
 *  is status `withdrawn` and/or visibility `archived` — either one alone means
 *  the listing is off the working list. */
export const RETIRED_PROPERTY_STATUS = "withdrawn" satisfies (typeof PROPERTY_STATUSES)[number];
export const RETIRED_PROPERTY_VISIBILITY = "archived" satisfies (typeof VISIBILITY_LEVELS)[number];

/**
 * Which columns a Restore should write. Kept pure and here (not in the
 * "use server" actions file, which may only export async functions) so the
 * two rules that are easy to get wrong stay pinned by tests:
 *
 * - visibility returns to `private`, never `public` — un-archiving must not
 *   republish a listing; that is an explicit Details-tab decision behind the
 *   quality-score gate.
 * - `withdrawn` is the OTHER retire marker, so it flips back to `available`;
 *   leaving it set would drop the row straight back into the Archived list.
 *   Every other status is market truth (a sold property stays sold) and is
 *   left alone.
 */
export function resolveRestoreUpdates(current: {
  status: (typeof PROPERTY_STATUSES)[number];
  visibility: (typeof VISIBILITY_LEVELS)[number];
}): { status?: (typeof PROPERTY_STATUSES)[number]; visibility?: "private" } {
  const updates: { status?: (typeof PROPERTY_STATUSES)[number]; visibility?: "private" } = {};
  if (current.visibility === RETIRED_PROPERTY_VISIBILITY) updates.visibility = "private";
  if (current.status === RETIRED_PROPERTY_STATUS) updates.status = "available";
  return updates;
}

export const PROPERTY_SCOPES = ["active", "archived", "all"] as const;
export type PropertyScope = (typeof PROPERTY_SCOPES)[number];

export type PropertyScopeMode = "exclude-retired" | "only-retired" | "none";

/**
 * How the list query should treat retired rows. An explicit status/visibility
 * filter that targets a retired value wins over the default `active` scope —
 * otherwise picking "Withdrawn" from the status filter would return nothing.
 */
export function resolvePropertyScope(filters: {
  scope: PropertyScope;
  status?: (typeof PROPERTY_STATUSES)[number];
  visibility?: (typeof VISIBILITY_LEVELS)[number];
}): PropertyScopeMode {
  if (
    filters.status === RETIRED_PROPERTY_STATUS ||
    filters.visibility === RETIRED_PROPERTY_VISIBILITY
  ) {
    return "none";
  }
  if (filters.scope === "archived") return "only-retired";
  if (filters.scope === "all") return "none";
  return "exclude-retired";
}

const optionalEnum = <T extends readonly string[]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v && (values as readonly string[]).includes(v) ? (v as T[number]) : undefined,
    );

// z.guid(), not z.uuid(): Postgres' uuid type accepts any 32-hex-digit value,
// while Zod 4's uuid() enforces RFC 4122 variant bits and silently rejects
// fixture ids like the seeded 11111111-… admin — which nulled fields on save.
const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v && z.guid().safeParse(v).success ? v : undefined));

const optionalInt = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  });

const optionalNumber = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  });

/** Parsed from URL searchParams — invalid values silently drop to undefined. */
export const propertyFiltersSchema = z.object({
  q: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  district: optionalUuid,
  area: optionalUuid,
  type: optionalEnum(PROPERTY_TYPES),
  transaction: optionalEnum(TRANSACTION_TYPES),
  status: optionalEnum(PROPERTY_STATUSES),
  visibility: optionalEnum(VISIBILITY_LEVELS),
  beds: optionalInt,
  price_min: optionalNumber,
  price_max: optionalNumber,
  mandate: optionalEnum(MANDATE_FILTERS),
  scope: z
    .string()
    .optional()
    .transform((v) =>
      v && (PROPERTY_SCOPES as readonly string[]).includes(v) ? (v as PropertyScope) : "active",
    ),
  view: z
    .string()
    .optional()
    .transform((v) => (v === "cards" ? "cards" : "table")),
  page: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 ? n : 1;
    }),
});

export type PropertyFilters = z.infer<typeof propertyFiltersSchema>;

export const PROPERTIES_PAGE_SIZE = 25;

/**
 * Create wizard (T1.2). Units/phases are created from their project's units
 * page (T1.6), not here — the wizard offers standalone and project.
 */
export const CREATABLE_KINDS = ["standalone", "project"] as const;

export const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

export const createPropertySchema = z.object({
  kind: z.enum(CREATABLE_KINDS),
  property_type: z.enum(PROPERTY_TYPES),
  transaction_type: z.enum(TRANSACTION_TYPES).default("sale"),
  district_id: z.string().uuid("Pick a district"),
  area_id: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  title_en: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  address: z.preprocess(emptyToUndefined, z.string().max(300).optional()),
  asking_price: z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive("Price must be positive").optional(),
  ),
  rent_price_month: z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive("Rent must be positive").optional(),
  ),
  bedrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  bathrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  covered_area_sqm: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  plot_area_sqm: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  internal_notes: z.preprocess(emptyToUndefined, z.string().max(5000).optional()),
});

export type CreatePropertyInput = z.infer<typeof createPropertySchema>;

/* ---------- T1.3 detail-page section schemas ---------- */

export const TITLE_DEED_STATUSES = ["separate", "pending", "shared", "none", "unknown"] as const;
export const PERMIT_STATUSES = ["full", "pending", "partial", "none", "unknown"] as const;
export const VAT_STATUSES = [
  "new_vat",
  "resale_no_vat",
  "reduced_rate_eligible",
  "unknown",
] as const;
export const ENERGY_CLASSES = ["A", "B+", "B", "C", "D", "E", "F", "G", "none"] as const;

const optNumber = z.preprocess(
  emptyToUndefined,
  z.coerce.number().min(0, "Must be ≥ 0").optional(),
);
const optLat = z.preprocess(
  emptyToUndefined,
  z.coerce.number().min(-90, "Latitude out of range").max(90, "Latitude out of range").optional(),
);
const optLng = z.preprocess(
  emptyToUndefined,
  z.coerce.number().min(-180, "Longitude out of range").max(180, "Longitude out of range").optional(),
);
const optInt = z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional());
const optText = (max: number) => z.preprocess(emptyToUndefined, z.string().max(max).optional());
// checkboxes are binary in the form, so an absent value means "no", not
// "unknown" — the action only applies land-panel checkboxes to land rows
const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true");

/** Sentinel for the clearable Area select — Radix SelectItem forbids "". */
export const AREA_NONE = "__none__";

export const detailsSectionSchema = z.object({
  status: z.enum(PROPERTY_STATUSES),
  visibility: z.enum(VISIBILITY_LEVELS),
  transaction_type: z.enum(TRANSACTION_TYPES),
  area_id: z.preprocess(
    (v) => (v === "" || v === null || v === AREA_NONE ? undefined : v),
    z.string().uuid().optional(),
  ),
  address: optText(300),
  postal_code: optText(20),
  latitude: optLat,
  longitude: optLng,
  sea_distance_m: optInt,
  amenities_notes: optText(2000),
  asking_price: optNumber,
  min_acceptable_price: optNumber,
  owner_net_price: optNumber,
  rent_price_month: optNumber,
  vat_status: z.enum(VAT_STATUSES),
  covered_area_sqm: optNumber,
  plot_area_sqm: optNumber,
  veranda_sqm: optNumber,
  roof_garden_sqm: optNumber,
  basement_sqm: optNumber,
  bedrooms: optInt,
  bathrooms: optInt,
  wc: optInt,
  parking_spaces: optInt,
  has_storage: checkbox,
  floor_number: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
  total_floors: optInt,
  year_built: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1800).max(2100).optional()),
  energy_class: z.preprocess(
    emptyToUndefined,
    z
      .enum(ENERGY_CLASSES)
      .optional()
      .transform((v) => (v === "none" ? undefined : v)),
  ),
  features: z.array(z.string()).default([]),
  internal_notes: optText(5000),
  // land panel (only meaningful when property_type = land)
  planning_zone_code: optText(20),
  building_density_pct: optNumber,
  coverage_ratio_pct: optNumber,
  max_floors: optInt,
  max_height_m: optNumber,
  road_frontage_m: optNumber,
  water_available: checkbox,
  electricity_available: checkbox,
  constraints_notes: optText(2000),
}).refine((d) => (d.latitude === undefined) === (d.longitude === undefined), {
  message: "Enter both latitude and longitude, or clear both",
  path: ["latitude"],
});

export const legalSectionSchema = z.object({
  title_deed_status: z.enum(TITLE_DEED_STATUSES),
  permit_status: z.enum(PERMIT_STATUSES),
  share_of_land: optText(100),
  encumbrances_notes: optText(2000),
});

const multilang = z.object({
  en: optText(10000),
  el: optText(10000),
  ru: optText(10000),
});

export const marketingSectionSchema = z.object({
  title: multilang,
  short_description: multilang,
  public_description: multilang,
});
