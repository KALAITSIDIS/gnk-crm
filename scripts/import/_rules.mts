/**
 * The importers' pure rules (audit 2026-09-15, LST-02 and LST-10), kept
 * apart from `_shared.mts` so they can be unit-tested without a Supabase
 * client or a file on disk. Only node built-ins and the app's dependency-free
 * measurement rules: this runs under plain Node with type stripping, the same
 * as every script in this directory.
 */
import { basename, extname } from "node:path";
// Relative and WITH the extension (tests/unit/scripts-run-under-node.test.ts).
import { measurementProblem, type MeasurementField } from "../../lib/validators/property-measurements.ts";

/**
 * The columns docs/09_DATA_IMPORT_TEMPLATES.md describes. `_rules.test.ts`
 * pins both lists to the doc's tables in both directions, because a template
 * that drifts from its own documentation is how a misspelt header becomes
 * "normal": the importer reads only these names, so anything else in a file
 * would import as blank without a word.
 */
export const KNOWN_CONTACT_COLUMNS = [
  "first_name",
  "last_name",
  "company_name",
  "phone",
  "email",
  "telegram_username",
  "has_whatsapp",
  "languages",
  "nationality",
  "contact_types",
  "temperature",
  "source",
  "psychology",
  "budget_min",
  "budget_max",
  "pref_areas",
  "pref_bedrooms_min",
  "pref_property_types",
  "consent_marketing",
  "consent_at",
  "notes",
] as const;

export const KNOWN_PROPERTY_COLUMNS = [
  "reference",
  "kind",
  "parent_reference",
  "property_type",
  "transaction_type",
  "status",
  "visibility",
  "district_code",
  "area",
  "address",
  "latitude",
  "longitude",
  "title_en",
  "title_el",
  "title_ru",
  "description_en",
  "description_el",
  "description_ru",
  "asking_price",
  "owner_net_price",
  "rent_price_month",
  "vat_status",
  "covered_area_sqm",
  "plot_area_sqm",
  "veranda_sqm",
  "bedrooms",
  "bathrooms",
  "parking_spaces",
  "floor_number",
  "total_floors",
  "year_built",
  "features",
  "title_deed_status",
  "permit_status",
  "registration_no",
  "plot_no",
  "sheet_plan",
  "registry_municipality",
  "planning_zone_code",
  "building_density_pct",
  "coverage_ratio_pct",
  "max_floors",
  "road_frontage_m",
  "owner_phone",
  "owner_name",
  "mandate_type",
  "mandate_commission_pct",
  "mandate_expiry",
  "internal_notes",
  // read by scripts/import/media.mts from the same file, after the rows
  "photo_folder",
] as const;

/** Header names the template does not know, in file order; a blank cell is named as such. */
export function unknownColumns(header: readonly string[], known: readonly string[]): string[] {
  const set = new Set<string>(known);
  return header.filter((h) => !set.has(h)).map((h) => (h === "" ? "(blank)" : h));
}

const CONTAINER_KINDS = new Set(["project", "phase"]);

/**
 * What a row is WRITTEN with. A row requested public cannot be public at
 * insert: its score does not exist until the row and its mandate do. It
 * lands private and `publishDecision` settles it afterwards. A container
 * (project or phase) imports as coming_soon at most — the empty-container
 * refusal of 2026-09-02, which the importer used to walk straight past.
 */
export function insertVisibilityFor(requested: string, kind: string): string {
  if (requested !== "public") return requested;
  return CONTAINER_KINDS.has(kind) ? "coming_soon" : "private";
}

/**
 * Whether a row that asked to be public may become so, now that it has a
 * score. The note is written into the report row, so a refusal is an
 * instruction ("complete it in the app") rather than a silent downgrade.
 */
export function publishDecision(input: {
  requested: string;
  kind: string;
  score: number;
  threshold: number;
}): { publish: boolean; note: string | null } {
  if (input.requested !== "public") return { publish: false, note: null };
  if (CONTAINER_KINDS.has(input.kind)) {
    return {
      publish: false,
      note: `a ${input.kind} cannot be imported public — coming_soon at most; publish it from the app once its units exist`,
    };
  }
  if (input.score < input.threshold) {
    return {
      publish: false,
      note: `score ${input.score} is below the publish threshold of ${input.threshold} — left private; complete it in the app and publish there`,
    };
  }
  return { publish: true, note: null };
}

/**
 * The batch every row of a run is stamped with — in each `imported` event's
 * payload and in the report's file name — so a whole run can be found, and
 * reversed, by one name. Sortable by construction: the run time first.
 */
export function batchIdFor(file: string, now: Date, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
  return `${stamp}-${basename(file, extname(file))}`;
}

/**
 * Why an import row's areas or floors cannot be stored (LST-07, 2026-09-23),
 * as `column: message`, or null. The same rules the app's forms apply, read
 * from the ONE definition — the importer used to write any finite number,
 * so a 0 m² area or floor 9 of 3 landed through the one path that skipped
 * every form. Applied to the parsed values before the row's first side
 * effect, so a refused row creates no area and no owner contact, and the
 * dry run reports it exactly as the live run would. Migration 0113's CHECKs
 * refuse the same rows at the insert; this says which column and why.
 */
export function measurementRefusal(values: Record<MeasurementField, number | null>): string | null {
  const problem = measurementProblem(values);
  return problem ? `${problem.field}: ${problem.message}` : null;
}
