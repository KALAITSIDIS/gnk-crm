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

/* ---------- numbers as Cyprus writes them (2026-09-23) ----------
 *
 * The importer used to strip every comma before Number(), so a Greek-style
 * `85,5` m² became 855 — ten times too large, silently — `1.200,50` became
 * 1.2005, and a cell with a symbol (`€250,000`) became a blank. Both
 * conventions are in daily use in Cyprus: the Greek one (decimal comma, dot
 * for thousands — what Excel writes under Greek regional settings) and the
 * English one (decimal dot, comma for thousands). Both are read; a cell that
 * could mean two different numbers, or is not a number at all, is REFUSED
 * with its column named, never guessed and never blanked.
 *
 * - "amount" (prices, areas, lengths): a single separator followed by
 *   exactly three digits is a THOUSANDS separator (1.200 = 1,200 = 1200) —
 *   nobody writes a price or an area to three decimal places; otherwise a
 *   single separator is the decimal mark (85,5 = 85.5). With both marks, the
 *   last one is the decimal (1.200,50 = 1,200.50).
 * - "decimal" (coordinates, percentages): these never carry thousands, so a
 *   single separator is always the decimal mark — 34.775 is a latitude, not
 *   34775.
 * - "integer" (rooms, floors, year): read as an amount, and a fraction is
 *   refused rather than truncated (2,5 bedrooms used to import as 25).
 */
export type NumberKind = "amount" | "decimal" | "integer";

/** Every numeric column of properties_import.csv (pinned to doc 09 by numbers.test.ts). */
export const PROPERTY_NUMBER_COLUMNS = {
  latitude: "decimal",
  longitude: "decimal",
  asking_price: "amount",
  owner_net_price: "amount",
  rent_price_month: "amount",
  covered_area_sqm: "amount",
  plot_area_sqm: "amount",
  veranda_sqm: "amount",
  bedrooms: "integer",
  bathrooms: "integer",
  parking_spaces: "integer",
  floor_number: "integer",
  total_floors: "integer",
  year_built: "integer",
  building_density_pct: "decimal",
  coverage_ratio_pct: "decimal",
  max_floors: "integer",
  road_frontage_m: "amount",
  mandate_commission_pct: "decimal",
} as const satisfies Record<string, NumberKind>;

/** Every numeric column of contacts_import.csv (pinned to doc 09 by numbers.test.ts). */
export const CONTACT_NUMBER_COLUMNS = {
  budget_min: "amount",
  budget_max: "amount",
  pref_bedrooms_min: "integer",
} as const satisfies Record<string, NumberKind>;

export type ParsedNumber = { value: number | null; error?: undefined } | { value?: undefined; error: string };

const HOW_TO_WRITE: Record<NumberKind, string> = {
  amount: "write digits with at most one decimal mark, e.g. 250000, 250.000, 250,000 or 85,5",
  decimal: "write it with one decimal mark, e.g. 34.7754 or 34,7754",
  integer: "write a whole number, e.g. 2",
};

/** Whole thousands groups: 1.234.567 / 1,234 — a first group of 1-3 digits, then groups of exactly 3. */
const GROUPED: Record<"," | ".", RegExp> = {
  ",": /^[1-9]\d{0,2}(,\d{3})+$/,
  ".": /^[1-9]\d{0,2}(\.\d{3})+$/,
};
const groupedBy = (mark: string): RegExp => GROUPED[mark as "," | "."];

/** A cell as a number, null when blank, or why it cannot be read. */
export function parseNumberCell(raw: string | undefined, kind: NumberKind): ParsedNumber {
  if (raw === undefined) return { value: null };
  // spaces (incl. no-break and thin) only ever group thousands; a typographic
  // minus is a minus
  const s = raw.trim().replace(/[\s\u00a0\u202f\u2009]/g, "").replace(/^\u2212/, "-");
  if (s === "") return { value: null };
  const refuse = (): ParsedNumber => ({ error: `cannot read "${raw.trim()}" as a number — ${HOW_TO_WRITE[kind]}` });

  const m = /^([+-]?)([\d.,]+)$/.exec(s);
  if (!m || !/\d/.test(m[2])) return refuse();
  const sign = m[1] === "-" ? -1 : 1;
  const body = m[2];
  const commas = (body.match(/,/g) ?? []).length;
  const dots = (body.match(/\./g) ?? []).length;

  let digits: string; // canonical "1234.5"
  if (commas === 0 && dots === 0) {
    digits = body;
  } else if (commas > 0 && dots > 0) {
    if (kind === "decimal") return refuse(); // coordinates and percentages carry no thousands
    const decimalMark = body.lastIndexOf(",") > body.lastIndexOf(".") ? "," : ".";
    const groupMark = decimalMark === "," ? "." : ",";
    const at = body.lastIndexOf(decimalMark);
    const whole = body.slice(0, at);
    const fraction = body.slice(at + 1);
    if (fraction === "" || !/^\d+$/.test(fraction) || !groupedBy(groupMark).test(whole)) return refuse();
    digits = `${whole.split(groupMark).join("")}.${fraction}`;
  } else {
    const mark = commas > 0 ? "," : ".";
    const count = commas + dots;
    if (count > 1) {
      // several of one mark can only be thousands groups
      if (kind === "decimal") return refuse();
      if (!groupedBy(mark).test(body)) return refuse();
      digits = body.split(mark).join("");
    } else {
      const [whole, fraction] = body.split(mark) as [string, string];
      if (fraction === "") return refuse();
      const thousands = kind !== "decimal" && fraction.length === 3 && /^[1-9]\d{0,2}$/.test(whole);
      digits = thousands ? `${whole}${fraction}` : `${whole === "" ? "0" : whole}.${fraction}`;
    }
  }

  const n = sign * Number(digits);
  if (!Number.isFinite(n)) return refuse();
  if (kind === "integer" && !Number.isInteger(n)) {
    return { error: `"${raw.trim()}" must be a whole number — a fraction is not rounded or truncated` };
  }
  return { value: n };
}

/**
 * Every numeric column of a row at once: the values (null for a blank or
 * absent cell) and one `column: why` per unreadable cell — ALL of them, so
 * one report pass fixes the whole row.
 */
export function parseNumberColumns<K extends string>(
  row: Record<string, string | undefined>,
  columns: Record<K, NumberKind>,
): { values: Record<K, number | null>; errors: string[] } {
  const values = {} as Record<K, number | null>;
  const errors: string[] = [];
  for (const column of Object.keys(columns) as K[]) {
    const parsed = parseNumberCell(row[column], columns[column]);
    if (parsed.error !== undefined) {
      errors.push(`${column}: ${parsed.error}`);
      values[column] = null;
    } else {
      values[column] = parsed.value;
    }
  }
  return { values, errors };
}

/**
 * The file's delimiter, read from its header line: `;` when it has more
 * semicolons than commas outside quotes. Excel under Greek regional settings
 * (decimal comma) saves "CSV" with semicolons between cells; a header never
 * holds either character inside a column name.
 */
export function delimiterOf(headerLine: string): "," | ";" {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  for (const c of headerLine) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === ",") commas++;
    else if (!inQuotes && c === ";") semicolons++;
  }
  return semicolons > commas ? ";" : ",";
}
