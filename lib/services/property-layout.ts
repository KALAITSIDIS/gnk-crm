/**
 * The Details tab, laid out for the kind of property it describes (F07).
 *
 * WHY. T1.3 built the tab as one dwelling layout — rooms, floors, energy
 * class, a residential features grid — and appended a "Land / planning" panel
 * at the very end for land. A plot of land therefore opened on bedrooms and
 * bathrooms, and its planning zone, density, frontage and utilities sat below
 * the furniture checkboxes. A development opened on rooms its units carry.
 *
 * THE TRAP, AND WHY THIS IS A MODULE. The Details save writes every column of
 * the section on every submit (`detailsUpdates` in lib/validators/properties.ts):
 * a field the form does not render arrives absent, and absent is written as
 * null. Simply not rendering bedrooms for land would erase a stored bedroom
 * count on the next unrelated save — and the public feed and the portal
 * dialects publish that count. So nothing here is ever "hidden": a group that
 * does not suit the property is COLLAPSED — rendered inside a native
 * `<details>`, whose inputs still post — and opened whenever it holds a value.
 * The land panel is the one exception, and it is not hidden either: it is not
 * WRITTEN for a non-land row, by the same rule in `detailsUpdates`.
 *
 * `lib/services/property-layout.test.ts` makes that a structural guarantee:
 * for every property type and kind, the fields laid out here are exactly the
 * columns the save writes — a field may move between groups, never disappear.
 *
 * Pure, no zod, no React, no "@/" value imports: the client form and the
 * server page both read it.
 */

/** Every field the Details tab renders, named as the form posts it. */
export const DETAILS_FIELDS = [
  // the listing's state
  "status",
  "visibility",
  "transaction_type",
  // where it is
  "area_id",
  "address",
  "postal_code",
  "sea_distance_m",
  /** latitude + longitude + location_approx: the map point (MapLocationFields) */
  "location",
  "amenities_notes",
  // what it costs
  "asking_price",
  "min_acceptable_price",
  "owner_net_price",
  "rent_price_month",
  "vat_status",
  // areas and rooms
  "covered_area_sqm",
  "plot_area_sqm",
  "veranda_sqm",
  "roof_garden_sqm",
  "basement_sqm",
  "bedrooms",
  "bathrooms",
  "wc",
  "parking_spaces",
  // the building
  "floor_number",
  "total_floors",
  "year_built",
  "energy_class",
  // build and handover
  "construction_status",
  "delivery_date",
  /** one array, posted whole — never split across groups */
  "features",
  "internal_notes",
  // land: written for land rows only (detailsUpdates)
  "planning_zone_code",
  "building_density_pct",
  "coverage_ratio_pct",
  "max_floors",
  "max_height_m",
  "road_frontage_m",
  "water_available",
  "electricity_available",
  "constraints_notes",
] as const;

export type DetailsField = (typeof DETAILS_FIELDS)[number];

/** The land panel's fields — rendered, and written, only when the type is land. */
export const LAND_DETAILS_FIELDS = [
  "planning_zone_code",
  "building_density_pct",
  "coverage_ratio_pct",
  "max_floors",
  "max_height_m",
  "road_frontage_m",
  "water_available",
  "electricity_available",
  "constraints_notes",
] as const satisfies readonly DetailsField[];

/**
 * built: a dwelling or commercial premises, laid out exactly as before F07.
 * land: a plot — planning first, the dwelling fields set aside.
 * container: a project or phase — its units carry the rooms and the prices.
 */
export type PropertyProfile = "built" | "land" | "container";

export function propertyProfile(p: {
  property_type: string | null | undefined;
  kind: string | null | undefined;
}): PropertyProfile {
  // the container rule first: a land subdivision project is still a project
  // (its plots are its units) — it gets the land groups on top, see below
  if (p.kind === "project" || p.kind === "phase") return "container";
  if (p.property_type === "land") return "land";
  return "built";
}

export type DetailsGroupId =
  | "listing"
  | "location"
  | "pricing"
  | "areas_rooms"
  | "build_handover"
  | "features"
  | "internal_notes"
  | "plot_planning"
  | "access_utilities"
  | "constraints"
  | "site"
  | "building_accommodation";

export interface DetailsGroup {
  id: DetailsGroupId;
  /** null for the untitled block at the top (status, visibility, transaction) */
  heading: string | null;
  fields: readonly DetailsField[];
  /**
   * Set aside for this kind of property, and why — rendered inside a NATIVE
   * `<details>` (its inputs still post), never left out. null: shown open.
   */
  collapsed: string | null;
  /** one line under the heading, or null */
  note: string | null;
}

export interface DetailsLayout {
  profile: PropertyProfile;
  /** the land groups are present (type land, any kind) */
  isLand: boolean;
  /** in render order; a collapsed group sits where it is listed */
  groups: DetailsGroup[];
}

const group = (
  id: DetailsGroupId,
  heading: string | null,
  fields: readonly DetailsField[],
  extra: { collapsed?: string; note?: string } = {},
): DetailsGroup => ({
  id,
  heading,
  fields,
  collapsed: extra.collapsed ?? null,
  note: extra.note ?? null,
});

const LISTING = group("listing", null, ["status", "visibility", "transaction_type"]);
const LOCATION = group("location", "Location", [
  "area_id",
  "address",
  "postal_code",
  "sea_distance_m",
  "location",
  "amenities_notes",
]);
const FEATURES = group("features", "Features", ["features"]);
const INTERNAL_NOTES = group("internal_notes", "Internal notes", ["internal_notes"]);

/** The price inputs, the one the listing leads with first. Every one is always rendered. */
function pricing(transactionType: string | null | undefined): DetailsGroup {
  return group(
    "pricing",
    "Pricing",
    transactionType === "rent"
      ? ["rent_price_month", "asking_price", "min_acceptable_price", "owner_net_price", "vat_status"]
      : ["asking_price", "min_acceptable_price", "owner_net_price", "rent_price_month", "vat_status"],
  );
}

const PLANNING_FIELDS = [
  "planning_zone_code",
  "building_density_pct",
  "coverage_ratio_pct",
  "max_floors",
  "max_height_m",
] as const satisfies readonly DetailsField[];
const ACCESS_UTILITIES = group("access_utilities", "Access & utilities", [
  "road_frontage_m",
  "water_available",
  "electricity_available",
]);
const CONSTRAINTS = group("constraints", "Constraints", ["constraints_notes"]);

/** The dwelling fields, for a profile they do not describe. */
const ROOM_FIELDS = [
  "covered_area_sqm",
  "veranda_sqm",
  "roof_garden_sqm",
  "basement_sqm",
  "bedrooms",
  "bathrooms",
  "wc",
  "parking_spaces",
  "floor_number",
  "total_floors",
] as const satisfies readonly DetailsField[];

export function detailsLayout(p: {
  property_type: string | null | undefined;
  kind: string | null | undefined;
  transaction_type?: string | null;
}): DetailsLayout {
  const profile = propertyProfile(p);
  const isLand = p.property_type === "land";

  if (profile === "built") {
    // UNCHANGED CONTENT (F07): the groups and fields a dwelling always had
    return {
      profile,
      isLand: false,
      groups: [
        LISTING,
        LOCATION,
        pricing(p.transaction_type),
        group("areas_rooms", "Areas & rooms", [
          "covered_area_sqm",
          "plot_area_sqm",
          "veranda_sqm",
          "roof_garden_sqm",
          "basement_sqm",
          "bedrooms",
          "bathrooms",
          "wc",
          "parking_spaces",
          "floor_number",
          "total_floors",
          "year_built",
          "energy_class",
        ]),
        group("build_handover", "Build & handover", ["construction_status", "delivery_date"]),
        FEATURES,
        INTERNAL_NOTES,
      ],
    };
  }

  if (profile === "land") {
    const aside = "not usual for land";
    return {
      profile,
      isLand: true,
      groups: [
        LISTING,
        LOCATION,
        group("plot_planning", "Plot & planning", ["plot_area_sqm", ...PLANNING_FIELDS]),
        ACCESS_UTILITIES,
        CONSTRAINTS,
        pricing(p.transaction_type),
        FEATURES,
        group(
          "building_accommodation",
          "Building & accommodation",
          [...ROOM_FIELDS, "year_built", "energy_class"],
          { collapsed: aside },
        ),
        group("build_handover", "Build & handover", ["construction_status", "delivery_date"], {
          collapsed: aside,
        }),
        INTERNAL_NOTES,
      ],
    };
  }

  // container: a project or a phase
  return {
    profile,
    isLand,
    groups: [
      LISTING,
      // what a development is asked first — and what its units inherit
      // (INHERITED_UNIT_FIELDS: construction status, delivery date, energy
      // class). Year built sits with them: the build-conflict check reads the
      // three together.
      group(
        "build_handover",
        "Build & handover",
        ["construction_status", "delivery_date", "year_built", "energy_class"],
        { note: "A new unit takes its construction status, delivery date and energy class from here." },
      ),
      LOCATION,
      isLand
        ? group("site", "Site & planning", ["plot_area_sqm", ...PLANNING_FIELDS])
        : group("site", "Site", ["plot_area_sqm"]),
      ...(isLand ? [ACCESS_UTILITIES, CONSTRAINTS] : []),
      pricing(p.transaction_type),
      FEATURES,
      group("building_accommodation", "Building & accommodation", ROOM_FIELDS, {
        collapsed: "each unit carries its own",
      }),
      INTERNAL_NOTES,
    ],
  };
}

/** Every field of a layout, in render order. */
export function layoutFields(layout: DetailsLayout): DetailsField[] {
  return layout.groups.flatMap((g) => [...g.fields]);
}

/** A field's label on the Details tab — one place, so the form and its summaries agree. */
export function detailsFieldLabel(field: DetailsField, profile: PropertyProfile): string {
  if (profile === "container") {
    // the units carry the prices and the rooms; the one area a development
    // has is its site (2026-09-03 session; T-real-session-findings)
    if (field === "asking_price") return "From price (€)";
    if (field === "plot_area_sqm") return "Site plot (m²)";
  }
  return FIELD_LABELS[field];
}

const FIELD_LABELS: Record<DetailsField, string> = {
  status: "Status",
  visibility: "Visibility",
  transaction_type: "Transaction",
  area_id: "Area",
  address: "Address",
  postal_code: "Postal code",
  sea_distance_m: "Sea distance (m)",
  location: "Exact map location",
  amenities_notes: "Amenities notes",
  asking_price: "Asking price (€)",
  min_acceptable_price: "Min acceptable (€)",
  owner_net_price: "Owner net (€)",
  rent_price_month: "Rent (€/month)",
  vat_status: "VAT status",
  covered_area_sqm: "Covered (m²)",
  plot_area_sqm: "Plot (m²)",
  veranda_sqm: "Veranda (m²)",
  roof_garden_sqm: "Roof garden (m²)",
  basement_sqm: "Basement (m²)",
  bedrooms: "Bedrooms",
  bathrooms: "Bathrooms",
  wc: "WC",
  parking_spaces: "Parking spaces",
  floor_number: "Floor",
  total_floors: "Total floors",
  year_built: "Year built",
  energy_class: "Energy class",
  construction_status: "Construction status",
  delivery_date: "Expected delivery",
  features: "Features",
  internal_notes: "Internal notes",
  planning_zone_code: "Planning zone (e.g. Κα6)",
  building_density_pct: "Building density (%)",
  coverage_ratio_pct: "Coverage ratio (%)",
  max_floors: "Max floors",
  max_height_m: "Max height (m)",
  road_frontage_m: "Road frontage (m)",
  water_available: "Water available",
  electricity_available: "Electricity available",
  constraints_notes: "Constraints (archaeology, forestry…)",
};

/** Whether a stored value is there at all — blank text and an empty list are not. */
export function isRecorded(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** How a recorded value reads in a collapsed group's summary. */
function summaryValue(field: DetailsField, value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (field === "construction_status" && typeof value === "string") {
    return value.replace(/_/g, " ");
  }
  if (typeof value === "number" || typeof value === "string") return String(value);
  return "recorded";
}

/**
 * What a collapsed group already holds, as "Label value" pieces — said in its
 * summary so a stray value on a plot of land (a bedroom count the feed would
 * publish) is visible without opening anything.
 */
export function recordedValues(
  g: DetailsGroup,
  row: Readonly<Record<string, unknown>>,
  profile: PropertyProfile,
): string[] {
  return g.fields
    .filter((f) => isRecorded(row[f]))
    .map((f) => {
      const label = detailsFieldLabel(f, profile);
      const value = summaryValue(f, row[f]);
      // "Covered (m²)" reads "Covered 120 m²" here, the unit after the number
      const unit = /^(.*) \((m²|m)\)$/.exec(label);
      return unit ? `${unit[1]} ${value} ${unit[2]}` : `${label} ${value}`;
    });
}

// ---------------------------------------------------------------- overview --

const NUMBER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });

/** A stored number for display, or null — never a 0 standing in for unknown. */
function shown(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? NUMBER.format(n) : null;
}

function utility(v: boolean | null | undefined): string {
  return v === true ? "Yes" : v === false ? "No" : "not recorded";
}

/**
 * The land facts the Overview shows in place of "Bedrooms / Bathrooms" (F07):
 * the planning terms, the frontage and the utilities — what a buyer of a plot
 * asks first. An unknown value is a dash, never a zero or a "No".
 */
export function landOverviewFacts(p: {
  planning_zone_code: string | null;
  building_density_pct: number | string | null;
  coverage_ratio_pct: number | string | null;
  road_frontage_m: number | string | null;
  water_available: boolean | null;
  electricity_available: boolean | null;
}): [string, string][] {
  const density = shown(p.building_density_pct);
  const coverage = shown(p.coverage_ratio_pct);
  const planning = [
    p.planning_zone_code?.trim() || null,
    density === null ? null : `density ${density}%`,
    coverage === null ? null : `coverage ${coverage}%`,
  ]
    .filter((s): s is string => s !== null)
    .join(" · ");
  const frontage = shown(p.road_frontage_m);
  const utilities =
    p.water_available == null && p.electricity_available == null
      ? "—"
      : `Water: ${utility(p.water_available)} · Electricity: ${utility(p.electricity_available)}`;
  return [
    ["Planning", planning || "—"],
    ["Road frontage", frontage === null ? "—" : `${frontage} m`],
    ["Utilities", utilities],
  ];
}
