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

const optionalEnum = <T extends readonly string[]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v && (values as readonly string[]).includes(v) ? (v as T[number]) : undefined,
    );

const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v && z.string().uuid().safeParse(v).success ? v : undefined));

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
