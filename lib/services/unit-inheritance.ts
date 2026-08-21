/**
 * What a new unit takes from its project (BACKLOG audit finding 5).
 *
 * Doc 02 §C1 says units inherit from their parent "unless overridden". The
 * implementation inherited five columns — district, area, address, postal code,
 * transaction type — so on a 60-unit project the developer, the VAT treatment,
 * the deed and permit status, the delivery date and the coordinates were either
 * typed sixty times or left blank forever. Blank was what actually happened.
 *
 * Pure and tested on purpose: the SET of inherited columns is the thing that is
 * easy to get wrong, and two of the ways to get it wrong are dangerous rather
 * than merely annoying. See the two exclusions below.
 */

/** Project columns a unit copies at creation. Order mirrors the table. */
export const INHERITED_UNIT_FIELDS = [
  "transaction_type",
  "district_id",
  "area_id",
  "address",
  "postal_code",
  "location",
  "sea_distance_m",
  "amenities_notes",
  "currency",
  "vat_status",
  "energy_class",
  "features",
  "title_deed_status",
  "permit_status",
  "construction_status",
  "delivery_date",
  "developer_contact_id",
  "owner_contact_id",
  "assigned_agent_id",
] as const;

export type InheritedUnitField = (typeof INHERITED_UNIT_FIELDS)[number];

/**
 * The same columns as a LITERAL select string, plus the five a child creator
 * needs for itself. `property_type` is in that second group, NOT in
 * INHERITED_UNIT_FIELDS: a unit picks its own type, but a phase takes the
 * project's (a phase of an apartment project is apartments), so the creator
 * reads it without it being drift-tracked. It has to be a literal: Supabase infers the row type from the
 * string, and a runtime `.join()` collapses it to `GenericStringError` — the
 * same reason `mandateEmbed` returns a literal union rather than `string`.
 *
 * A literal can drift from the array above, so a test asserts it does not.
 */
export const UNIT_PARENT_SELECT =
  "id, org_id, kind, reference, property_type, transaction_type, district_id, area_id, address, postal_code, location, sea_distance_m, amenities_notes, currency, vat_status, energy_class, features, title_deed_status, permit_status, construction_status, delivery_date, developer_contact_id, owner_contact_id, assigned_agent_id";

/**
 * The unit-side select for the drift check: what the matrix renders, plus every
 * inheritable column and `inherited_fields` so a project and its units can be
 * compared. A LITERAL for the same reason as UNIT_PARENT_SELECT — a built
 * string collapses the inferred row type to GenericStringError — and pinned by
 * the same test.
 */
export const UNIT_ROW_SELECT =
  "id, reference, unit_number, block, property_type, bedrooms, covered_area_sqm, asking_price, status, floor_number, inherited_fields, transaction_type, district_id, area_id, address, postal_code, location, sea_distance_m, amenities_notes, currency, vat_status, energy_class, features, title_deed_status, permit_status, construction_status, delivery_date, developer_contact_id, owner_contact_id, assigned_agent_id";

/**
 * Columns a unit must NOT inherit, with the reason, because "why is this
 * missing" is the question a future reader will have.
 *
 * `visibility` is the dangerous one. A project set to `public` would mint units
 * that are already published — straight past the quality-score gate that every
 * other publish goes through (`updatePropertySection`, doc 02 §A8). A brand-new
 * unit has no photos, no description and no price, so inheriting `public` would
 * publish an empty record. The column defaults to `private`; leave it alone.
 *
 * `status` is market truth about one specific unit, not about the project, and
 * `createUnit` sets it to `available` explicitly.
 *
 * The area and price columns are the unit's own by definition — inheriting a
 * project's `asking_price` onto every unit would be worse than leaving it null,
 * because a wrong number reads as a real one.
 */
export const DELIBERATELY_NOT_INHERITED = {
  visibility: "would publish an empty unit past the quality gate",
  status: "per-unit market truth; createUnit sets it to available",
  asking_price: "the unit's own; a wrong price reads as a real one",
  covered_area_sqm: "the unit's own",
  bedrooms: "the unit's own",
  bathrooms: "the unit's own",
  title: "the unit's own, derived from its number",
  reference: "generated from the parent reference plus the unit label",
  quality_score: "derived state, recomputed from the unit's own fields",
} as const;

/** The subset of a project row this module needs. */
export type ProjectRow = Partial<Record<InheritedUnitField, unknown>>;

/**
 * Build the inherited half of a unit insert.
 *
 * A null on the project stays null on the unit — inheriting "unknown" is
 * correct, and skipping nulls would make the unit's blank look like a decision
 * somebody made rather than a gap nobody has filled yet.
 */
export function resolveInheritedUnitFields(
  project: ProjectRow,
): Record<string, unknown> {
  const inherited: Record<string, unknown> = {};
  for (const field of INHERITED_UNIT_FIELDS) {
    inherited[field] = project[field] ?? null;
  }
  return inherited;
}

/** Which inherited columns actually carried a value — for the created event. */
export function inheritedFieldsWithValues(project: ProjectRow): InheritedUnitField[] {
  return INHERITED_UNIT_FIELDS.filter(
    (f) => project[f] !== null && project[f] !== undefined,
  );
}

/* ---------- drift: where a project and its units disagree ---------- */

export interface FieldDrift {
  field: InheritedUnitField;
  /** Units still inheriting this field whose value differs from the project's. */
  count: number;
}

/** Row shape the drift check needs from each unit. */
export type UnitRowForDrift = ProjectRow & { inherited_fields?: string[] | null };

/**
 * Compare values the way the database would, not the way JavaScript would.
 * `features` is a text[], so `["a","b"] !== ["a","b"]` by reference; and null
 * vs undefined must read as the same "no value".
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * Which project fields have drifted away from the units that still inherit them.
 *
 * This is what turns copy-on-create from a trap into a workflow: change the
 * project's VAT status and the units page can say, truthfully, "58 units still
 * inherit this and disagree" — leaving alone the 2 somebody set deliberately,
 * because editing a field removes it from that unit's `inherited_fields`.
 *
 * A unit that does NOT list the field is invisible here by design. That is the
 * whole point: it has an opinion, and a sync must not overwrite it.
 */
export function computeInheritanceDrift(
  project: ProjectRow,
  units: UnitRowForDrift[],
): FieldDrift[] {
  const drift: FieldDrift[] = [];
  for (const field of INHERITED_UNIT_FIELDS) {
    const count = units.filter(
      (u) => (u.inherited_fields ?? []).includes(field) && !sameValue(u[field], project[field]),
    ).length;
    if (count > 0) drift.push({ field, count });
  }
  return drift;
}

/**
 * Which inherited fields a unit edit has just claimed as its own.
 *
 * Only fields that ACTUALLY CHANGED count. The details form posts twenty-odd
 * columns on every save, so dropping everything it touched would opt a unit out
 * of inheritance the first time anybody opened the tab and pressed Save.
 */
export function fieldsClaimedByEdit(
  currentInherited: string[] | null | undefined,
  changedFields: string[],
): string[] {
  const claimed = new Set(changedFields);
  return (currentInherited ?? []).filter(
    (f) => !claimed.has(f),
  );
}
