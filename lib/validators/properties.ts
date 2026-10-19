import { z } from "zod";
// Relative and WITH the extension: this module is now reachable from the
// standalone scripts (via lib/services/container-units.ts), which run under
// plain Node where neither "@/" nor a missing extension resolves.
import { MAX_FLOOR, MAX_GENERATED_UNITS, MAX_PER_FLOOR } from "../services/unit-generator.ts";
import { AREA_LABELS, areaProblem, floorProblem } from "./property-measurements.ts";
import { hasStorageRoom } from "../constants/features.ts";
import type { Database } from "@/lib/supabase/database.types";

type PropertyUpdate = Database["public"]["Tables"]["properties"]["Update"];

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

/** Hierarchy level. Declared HERE, above propertyFiltersSchema: the schema
 *  reads it at module-evaluation time, so a later `const` is a TDZ crash. */
export const PROPERTY_KINDS = ["standalone", "project", "phase", "unit"] as const;

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

/**
 * DB-01: sold/rented assert a CLOSED transaction, and leaving one is a
 * REGRESSION — supported (a fallen-through sale genuinely relists; the
 * new-listing alert even covers it) but admin-only and separately evented,
 * because the flip is externally visible in the public feed and silently
 * erases the sale from the velocity chart. Kept pure and here so the rule is
 * pinned by tests, not re-derived in two actions. sold ↔ rented moves stay
 * unguarded: both still assert a closed transaction.
 */
const CLOSED_PROPERTY_STATUSES: readonly string[] = ["sold", "rented"];
export function isStatusRegression(from: string, to: string): boolean {
  return CLOSED_PROPERTY_STATUSES.includes(from) && !CLOSED_PROPERTY_STATUSES.includes(to);
}

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

/**
 * The highest bedroom count the "Beds ≥" filter takes. `bedrooms` is int4: a
 * value past 2,147,483,647 reached PostgREST and came back 400 22003 / 22P02,
 * the error boundary on the list and the map and the export's 500 (BACKLOG
 * "A Beds filter past int4 crashes the properties list and map"). No listing
 * has a hundred bedrooms; a larger value is dropped like any other invalid
 * filter, and the input carries the same `max`.
 */
export const MAX_BEDS_FILTER = 99;

const optionalBeds = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= MAX_BEDS_FILTER ? n : undefined;
  });

const optionalNumber = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  });

/**
 * What the list's `kind` parameter may say: one kind, or `all` (F04). Absent
 * is the default — every kind but units (see `resolvePropertyKindScope`).
 * Declared above the schema, which reads it at module-evaluation time.
 */
export const PROPERTY_KIND_FILTERS = [...PROPERTY_KINDS, "all"] as const;
export type PropertyKindFilter = (typeof PROPERTY_KIND_FILTERS)[number];

/**
 * How the list may be ordered (A03). `newest` is the default and emits exactly
 * the order the list always had — `created_at desc, id` — so a URL without
 * `sort` lists what it always listed, in the same order. Every other sort puts
 * unknown values last and ends on `id`, so paging stays a partition
 * (T-list-page-order). See `applyPropertyListOrder`.
 */
export const PROPERTY_SORTS = [
  "newest",
  "updated",
  "price_asc",
  "price_desc",
  "plot_asc",
  "plot_desc",
  "score_asc",
  "score_desc",
  "reference",
  "reference_desc",
] as const;
export type PropertySort = (typeof PROPERTY_SORTS)[number];
export const DEFAULT_PROPERTY_SORT = "newest" satisfies PropertySort;

/**
 * Every URL parameter that NARROWS the list — the one list of them (A03). The
 * parser reads exactly these plus `PROPERTY_PRESENTATION_KEYS`; the filter
 * bar's Clear button shows when any of them is set; the export's audit vetting
 * must name each of them (`q` excepted: it is recorded only as used). A new
 * filter joins here, and the unit test that compares this list with the
 * schema's keys fails until it does.
 */
export const PROPERTY_FILTER_KEYS = [
  "q",
  "district",
  "area",
  "type",
  "transaction",
  "status",
  "visibility",
  "beds",
  "price_min",
  "price_max",
  "plot_min",
  "plot_max",
  "density_min",
  "mandate",
  "kind",
  "scope",
] as const;
export type PropertyFilterKey = (typeof PROPERTY_FILTER_KEYS)[number];

/** How the rows are shown, not which rows: kept by Clear, never audited as a filter. */
export const PROPERTY_PRESENTATION_KEYS = ["view", "sort", "page"] as const;

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
  beds: optionalBeds,
  price_min: optionalNumber,
  price_max: optionalNumber,
  // Land (A03): plot area and building density, on the columns the land panel
  // edits (plot_area_sqm, building_density_pct). A row whose value is unknown
  // never matches a bound — SQL null semantics, and the inputs say so.
  plot_min: optionalNumber,
  plot_max: optionalNumber,
  density_min: optionalNumber,
  mandate: optionalEnum(MANDATE_FILTERS),
  kind: optionalEnum(PROPERTY_KIND_FILTERS),
  scope: z
    .string()
    .optional()
    .transform((v) =>
      v && (PROPERTY_SCOPES as readonly string[]).includes(v) ? (v as PropertyScope) : "active",
    ),
  view: z
    .string()
    .optional()
    // Absent means AUTO (audit CRM-06): cards on a phone, the table from the
    // tablet breakpoint up. A phone used to get the twelve-column table with
    // everything past the title off the right edge. An explicit value is
    // honoured on every screen.
    .transform((v) => (v === "cards" ? "cards" : v === "table" ? "table" : "auto")),
  // an unknown sort is the default one, like any other invalid parameter
  sort: z
    .string()
    .optional()
    .transform((v): PropertySort =>
      v && (PROPERTY_SORTS as readonly string[]).includes(v) ? (v as PropertySort) : DEFAULT_PROPERTY_SORT,
    ),
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

export type PropertyKindMode = "exclude-units" | "none";

/**
 * How the list should treat UNITS (BACKLOG audit finding 3).
 *
 * A unit is inventory inside a project, not a listing in its own right. One
 * 60-unit project is two and a half pages of the default 25-row list, so
 * showing units by default buries every standalone listing the desk actually
 * works — and does the same to the CSV export and the map, which share this
 * module.
 *
 * Units are therefore hidden unless asked for, and reached through their
 * project's units matrix. Exactly the shape of `resolvePropertyScope` above,
 * including its escape hatch: an explicit `kind=unit` wins over the default,
 * because a filter that returns nothing when you pick it is a broken filter.
 *
 * The default is VISIBLE IN THE UI — the select reads "Listings & developments
 * (no units)", and the list header counts the units it is leaving out with a
 * link to them. A default that silently removes rows is a trap; one the user
 * can see and change is a choice.
 *
 * `kind=all` (F04) is the explicit "every kind": no kind predicate at all, so
 * the list, the export and the map can hold the same rows a by-status count
 * of every record does. An explicit single kind narrows on its own.
 */
export function resolvePropertyKindScope(filters: { kind?: PropertyKindFilter }): PropertyKindMode {
  return filters.kind === undefined ? "exclude-units" : "none";
}

/* ---------- parties: who owns it, who built it, who works it ---------- */

/** Kinds that can carry a developer. A standalone listing belongs to a private
 *  owner by definition — the field is not rendered for it (see below). */
export const DEVELOPER_KINDS = ["project", "phase", "unit"] as const;

/**
 * Parties section (BACKLOG audit findings 1 + 2). All three links are optional:
 * a draft listing legitimately has none, and the EntityPicker posts "" when it
 * is cleared, which `optionalUuid` turns into undefined → null on save.
 *
 * `assigned_agent_id` is NOT just another link. `properties_update` and
 * `property_media_insert` (0002) admit an agent only when it equals their own
 * id, so writing this column grants and revokes edit rights. That is why the
 * action limits the whole section to admin + listing manager: the UPDATE
 * with-check only tests `org_id`, so RLS would happily let an agent reassign
 * their own property to somebody else and lock themselves out of it.
 */
export const partiesSectionSchema = z.object({
  owner_contact_id: optionalUuid,
  developer_contact_id: optionalUuid,
  assigned_agent_id: optionalUuid,
});

export type PartiesSectionInput = z.infer<typeof partiesSectionSchema>;

export interface PartyUpdates {
  owner_contact_id: string | null;
  assigned_agent_id: string | null;
  developer_contact_id?: string | null;
}

/**
 * Which party columns a save should write.
 *
 * The developer field is only rendered for project/phase/unit, so for a
 * standalone listing it arrives ABSENT — and absent parses to undefined, which
 * would otherwise be written as null and silently clear a value the form never
 * showed. Same trap as the land panel in `updatePropertySection`, handled the
 * same way: a column the form did not render is a column the save does not
 * touch.
 */
export function resolvePartyUpdates(
  parsed: PartiesSectionInput,
  current: { kind: (typeof PROPERTY_KINDS)[number] },
): PartyUpdates {
  const updates: PartyUpdates = {
    owner_contact_id: parsed.owner_contact_id ?? null,
    assigned_agent_id: parsed.assigned_agent_id ?? null,
  };
  if ((DEVELOPER_KINDS as readonly string[]).includes(current.kind)) {
    updates.developer_contact_id = parsed.developer_contact_id ?? null;
  }
  return updates;
}

/**
 * Create wizard (T1.2). Units/phases are created from their project's units
 * page (T1.6), not here — the wizard offers standalone and project.
 */
export const CREATABLE_KINDS = ["standalone", "project"] as const;

export const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

/* ---------- measurements: areas and floors (LST-07, 2026-09-23) ----------
 * The rules live in ./property-measurements.ts; these are their Zod field
 * shapes, shared by the create wizard, the details form and the unit forms
 * (lib/actions/units.ts) so creation and editing cannot disagree again.
 *
 * Blank here includes WHITESPACE. `emptyToUndefined` leaves "  " to
 * z.coerce, which reads it as 0 — a blank floor became the ground floor and a
 * blank area a zero. Kept to these four fields rather than changed in
 * `emptyToUndefined`, which a hundred other fields share. */
const blankToUndefined = (v: unknown) =>
  v === null || (typeof v === "string" && v.trim() === "") ? undefined : v;

/** A known area, positive as stored; blank is unknown (undefined → null). */
export const measuredArea = (label: string) =>
  z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: `${label} must be a number` })
      .superRefine((n, ctx) => {
        const problem = areaProblem(label, n);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      })
      .optional(),
  );

/** The floor a property is on: 0 = ground, negative = basement; blank is unknown. */
export const measuredFloor = z.preprocess(
  blankToUndefined,
  z.coerce
    .number({ error: "Floor must be a whole number" })
    .int("Floor must be a whole number")
    .optional(),
);

/** Floors in the building; blank is unknown. Never negative (unchanged rule, now with a message). */
export const measuredTotalFloors = z.preprocess(
  blankToUndefined,
  z.coerce
    .number({ error: "Total floors must be a whole number" })
    .int("Total floors must be a whole number")
    .min(0, "Total floors cannot be negative")
    .optional(),
);

/**
 * Where a listing comes from (migration 0038's create-wizard half).
 *
 * The operator's framing, and the one the desk actually thinks in: a property
 * is either a private owner's, or a developer's. It decides which party column
 * gets written and which contacts the picker offers — and, through the party's
 * standard terms, what the rest of the record starts as.
 */
export const LISTING_SOURCES = ["owner", "developer"] as const;
export type ListingSource = (typeof LISTING_SOURCES)[number];

export const createPropertySchema = z.object({
  kind: z.enum(CREATABLE_KINDS),
  source: z.enum(LISTING_SOURCES).optional(),
  // whichever the source names; the action ignores the one it did not ask for
  owner_contact_id: optionalUuid,
  developer_contact_id: optionalUuid,
  property_type: z.enum(PROPERTY_TYPES),
  transaction_type: z.enum(TRANSACTION_TYPES).default("sale"),
  district_id: z.string().uuid("Pick a district"),
  area_id: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  title_en: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  address: z.preprocess(emptyToUndefined, z.string().max(300).optional()),
  // DB-05: entry-time capture — the wizard's registration duplicate warning
  // fires on this before a reference is ever burned
  registration_no: z.preprocess(emptyToUndefined, z.string().max(50).optional()),
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
  covered_area_sqm: measuredArea(AREA_LABELS.covered_area_sqm),
  plot_area_sqm: measuredArea(AREA_LABELS.plot_area_sqm),
  internal_notes: z.preprocess(emptyToUndefined, z.string().max(5000).optional()),

  /* ---- Project layout (2026-09-02) — wizard step 2 for a container. ----
   * A project was created with NO UNITS, scored 100/100 and went public; the
   * wizard had asked it for a villa's bedrooms and never mentioned units. Now a
   * project's step 2 asks how the DEVELOPMENT is laid out and creates the units
   * at the same time. Every field is optional: a blank count means "add them
   * later", and the action only generates when a real spec arrives. The
   * `gen_` prefix keeps these apart from the property's own columns above.
   * Kept a plain z.object (no refine) so nothing that extends this schema
   * breaks — the run ceiling for the floor grid is enforced in the action. */
  gen_layout: z.enum(["floors", "villas"]).optional(),
  gen_villa_count: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(MAX_GENERATED_UNITS).optional(),
  ),
  gen_villa_prefix: z.preprocess(emptyToUndefined, z.string().max(10).optional()),
  gen_block: z.preprocess(emptyToUndefined, z.string().max(20).optional()),
  gen_floor_from: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(MAX_FLOOR).optional(),
  ),
  gen_floor_to: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(MAX_FLOOR).optional(),
  ),
  gen_per_floor: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(MAX_PER_FLOOR).optional(),
  ),
  gen_bedrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  gen_bathrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  gen_covered_area_sqm: measuredArea(AREA_LABELS.covered_area_sqm),
  gen_plot_area_sqm: measuredArea(AREA_LABELS.plot_area_sqm),
  gen_base_price: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  gen_price_step: z.preprocess(emptyToUndefined, z.coerce.number().min(0).optional()),
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

/**
 * What each VAT status means, in words (F01). The stored values are
 * unchanged; the labels say whether VAT applies, so "Unknown" reads as a fact
 * not yet confirmed rather than as a fourth kind of sale. Whether a status
 * means VAT applies is decided in ONE place — `vatApplicability` in
 * lib/services/vat.ts — and these labels agree with it.
 */
export const VAT_STATUS_LABELS: Record<(typeof VAT_STATUSES)[number], string> = {
  new_vat: "New (VAT applies)",
  resale_no_vat: "Resale (no VAT)",
  reduced_rate_eligible: "Reduced rate eligible",
  unknown: "Unknown (not confirmed)",
};

/**
 * The property types that are a DWELLING — something a buyer can live in.
 * Two rules turn on it: a development's generated units carry its type only
 * when it is one of these (createProperty), and the reduced VAT rate, which
 * the config's own `applies_to` limits to a "first primary residence, new
 * property", is never offered for anything else (deriveVat, F01). Building,
 * mixed use and other are not here: a development of that type is judged by
 * its units, which are apartments or villas.
 */
export const DWELLING_TYPES = ["apartment", "villa", "townhouse", "house"] as const;

export function isDwellingType(t: string | null | undefined): boolean {
  return typeof t === "string" && (DWELLING_TYPES as readonly string[]).includes(t);
}

export const ENERGY_CLASSES = ["A", "B+", "B", "C", "D", "E", "F", "G", "none"] as const;

/**
 * Where an off-plan build has got to (BACKLOG audit finding 10).
 *
 * The column is `text`, not an enum, and rows created by the CSV importer or by
 * hand may hold anything. The form therefore offers this list AND keeps whatever
 * is already stored as an extra option — silently rewriting somebody's value to
 * the nearest listed one would be worse than an untidy dropdown.
 */
export const CONSTRUCTION_STATUSES = [
  "planning",
  "permit_applied",
  "permit_granted",
  "under_construction",
  "structure_complete",
  "finishing",
  "completed",
  "delivered",
] as const;

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

/**
 * Water and electricity on a plot: Yes, No, or NOT KNOWN (F07).
 *
 * They were checkboxes, and a checkbox has no third state: an unticked box
 * posts nothing, which parsed as "no". So every Details save of a land row —
 * a price change, a density change — turned a never-recorded utility into a
 * recorded "No", and its `updated` event logged a change nobody made. The
 * columns are nullable on purpose; the form now offers the three answers and
 * the parse keeps them apart:
 *   "yes" → true, "no" → false, "unknown" → null;
 *   "on" / "true" → true — a ticked box on a page rendered before F07;
 *   ABSENT → undefined, which `detailsUpdates` does not write: a stale page's
 *   unticked box, or a form that did not render the field, changes nothing.
 * The falses written before F07 are still stored, and this select shows them
 * as "No" (posting them back unchanged): see landOverviewFacts in
 * lib/services/property-layout.ts for that residue and who clears it.
 */
export const UTILITY_STATES = ["unknown", "yes", "no"] as const;
export type UtilityState = (typeof UTILITY_STATES)[number];

/** A stored utility as the form's select shows it — and therefore posts it back. */
export function utilityFormValue(v: boolean | null | undefined): UtilityState {
  return v === true ? "yes" : v === false ? "no" : "unknown";
}

const utilityAnswer = z
  .enum([...UTILITY_STATES, "on", "true", ""], { message: "Choose Yes, No or Not known" })
  .optional()
  .transform((v): boolean | null | undefined =>
    v === undefined
      ? undefined
      : v === "yes" || v === "on" || v === "true"
        ? true
        : v === "no"
          ? false
          : null,
  );

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
  // 0054: the point in the boxes is an area/district centroid, not a surveyed
  // point. A checkbox-style value, so an absent field means false.
  location_approx: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
  sea_distance_m: optInt,
  amenities_notes: optText(2000),
  asking_price: optNumber,
  min_acceptable_price: optNumber,
  owner_net_price: optNumber,
  rent_price_month: optNumber,
  vat_status: z.enum(VAT_STATUSES),
  // LST-07: the create wizard's rule (positive, blank = unknown) — this form
  // used the generic `optNumber` (≥ 0) since T1.3, so 0 m² saved on edit
  covered_area_sqm: measuredArea(AREA_LABELS.covered_area_sqm),
  plot_area_sqm: measuredArea(AREA_LABELS.plot_area_sqm),
  veranda_sqm: optNumber,
  roof_garden_sqm: optNumber,
  basement_sqm: optNumber,
  bedrooms: optInt,
  bathrooms: optInt,
  wc: optInt,
  parking_spaces: optInt,
  // No `has_storage` (F02, 0152): storage room is the Features key
  // STORAGE_FEATURE, and the action mirrors the column from `features`. A
  // stale form that still posts has_storage is ignored (zod strips it).
  floor_number: measuredFloor,
  total_floors: measuredTotalFloors,
  year_built: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1800).max(2100).optional()),
  energy_class: z.preprocess(
    emptyToUndefined,
    z
      .enum(ENERGY_CLASSES)
      .optional()
      .transform((v) => (v === "none" ? undefined : v)),
  ),
  features: z.array(z.string()).default([]),
  // audit finding 10: both columns existed since 0001 and no screen wrote them.
  // construction_status is free text in the schema, so it is validated as text
  // rather than an enum — see CONSTRUCTION_STATUSES for why.
  construction_status: optText(40),
  delivery_date: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Delivery date must be YYYY-MM-DD")
      .optional(),
  ),
  internal_notes: optText(5000),
  // land panel (only meaningful when property_type = land)
  planning_zone_code: optText(20),
  building_density_pct: optNumber,
  coverage_ratio_pct: optNumber,
  max_floors: optInt,
  max_height_m: optNumber,
  road_frontage_m: optNumber,
  water_available: utilityAnswer,
  electricity_available: utilityAnswer,
  constraints_notes: optText(2000),
})
  .refine((d) => (d.latitude === undefined) === (d.longitude === undefined), {
    message: "Enter both latitude and longitude, or clear both",
    path: ["latitude"],
  })
  // LST-07: floor 9 of a 3-floor building saved here. The save writes both
  // columns every time (absent → null), so checking what was posted IS
  // checking the row it leaves; 0113's CHECK holds the same line for every
  // other writer.
  .superRefine((d, ctx) => {
    const problem = floorProblem(d.floor_number, d.total_floors);
    if (problem) ctx.addIssue({ code: "custom", path: ["floor_number"], message: problem });
  });

export type DetailsSectionInput = z.infer<typeof detailsSectionSchema>;

/**
 * Which columns a Details save writes, and with what (F07; extracted from
 * `updatePropertySection`, where it was written inline since T1.3).
 *
 * EVERY column here is written on every save — absent parses to undefined and
 * is written as null. That is what lets a blank box clear a value, and it is
 * also the trap: a field the form does not render is a field this erases. The
 * Details tab is laid out per kind of property (lib/services/property-layout.ts)
 * and never leaves a field out — a group that does not suit the property is
 * collapsed into a native <details>, whose inputs still post — and
 * lib/services/property-layout.test.ts holds the two together: for every type
 * and kind, the fields laid out are exactly the columns written here.
 *
 * The land panel is the one conditional block, by the same rule as
 * `resolvePartyUpdates`: a column the form did not render is a column the save
 * does not touch. It is rendered for land rows only, so only land rows take
 * it. Within it, a utility that was not posted is not written either (see
 * UTILITY_STATES).
 *
 * The map point and its approximate flag are not here: they are compared
 * against the stored point first (an unchanged point is never rewritten), so
 * the action handles them.
 */
export function detailsUpdates(
  d: DetailsSectionInput,
  current: { property_type: string },
): PropertyUpdate {
  const updates: PropertyUpdate = {
    status: d.status,
    visibility: d.visibility,
    transaction_type: d.transaction_type,
    area_id: d.area_id ?? null,
    address: d.address ?? null,
    postal_code: d.postal_code ?? null,
    sea_distance_m: d.sea_distance_m ?? null,
    amenities_notes: d.amenities_notes ?? null,
    asking_price: d.asking_price ?? null,
    min_acceptable_price: d.min_acceptable_price ?? null,
    owner_net_price: d.owner_net_price ?? null,
    rent_price_month: d.rent_price_month ?? null,
    vat_status: d.vat_status,
    covered_area_sqm: d.covered_area_sqm ?? null,
    plot_area_sqm: d.plot_area_sqm ?? null,
    veranda_sqm: d.veranda_sqm ?? null,
    roof_garden_sqm: d.roof_garden_sqm ?? null,
    basement_sqm: d.basement_sqm ?? null,
    bedrooms: d.bedrooms ?? null,
    bathrooms: d.bathrooms ?? null,
    wc: d.wc ?? null,
    parking_spaces: d.parking_spaces ?? null,
    // F02: storage room has one value, the Features key. The column is its
    // mirror (0152's trigger derives it for every writer); written here as
    // well so the `updated` event records it moving with `features`, and so
    // this save is right on a database without the trigger.
    has_storage: hasStorageRoom(d.features),
    floor_number: d.floor_number ?? null,
    total_floors: d.total_floors ?? null,
    year_built: d.year_built ?? null,
    energy_class: d.energy_class ?? null,
    features: d.features,
    construction_status: d.construction_status ?? null,
    delivery_date: d.delivery_date ?? null,
    internal_notes: d.internal_notes ?? null,
  };
  if (current.property_type === "land") {
    Object.assign(updates, {
      planning_zone_code: d.planning_zone_code ?? null,
      building_density_pct: d.building_density_pct ?? null,
      coverage_ratio_pct: d.coverage_ratio_pct ?? null,
      max_floors: d.max_floors ?? null,
      max_height_m: d.max_height_m ?? null,
      road_frontage_m: d.road_frontage_m ?? null,
      ...(d.water_available !== undefined ? { water_available: d.water_available } : {}),
      ...(d.electricity_available !== undefined
        ? { electricity_available: d.electricity_available }
        : {}),
      constraints_notes: d.constraints_notes ?? null,
    } satisfies PropertyUpdate);
  }
  return updates;
}

export const legalSectionSchema = z.object({
  title_deed_status: z.enum(TITLE_DEED_STATUSES),
  permit_status: z.enum(PERMIT_STATUSES),
  share_of_land: optText(100),
  encumbrances_notes: optText(2000),
  // DLS identity (0077, DB-05) — free text as the deed prints them
  registration_no: optText(50),
  plot_no: optText(50),
  sheet_plan: optText(50),
  registry_municipality: optText(100),
});

const multilang = z.object({
  en: optText(10000),
  el: optText(10000),
  ru: optText(10000),
});

export const marketingSectionSchema = z.object({
  title: multilang,
  short_description: multilang,
  /* The firm's own judgement, not a summary — see 0085. Same multilang cap as
     the others: it is public text and the site renders it verbatim. */
  adviser_view: multilang,
  public_description: multilang,
});
