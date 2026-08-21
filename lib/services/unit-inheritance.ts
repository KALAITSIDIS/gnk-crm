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
 * The same columns as a LITERAL select string, plus the four `createUnit` needs
 * for itself. It has to be a literal: Supabase infers the row type from the
 * string, and a runtime `.join()` collapses it to `GenericStringError` — the
 * same reason `mandateEmbed` returns a literal union rather than `string`.
 *
 * A literal can drift from the array above, so a test asserts it does not.
 */
export const UNIT_PARENT_SELECT =
  "id, org_id, kind, reference, transaction_type, district_id, area_id, address, postal_code, location, sea_distance_m, amenities_notes, currency, vat_status, energy_class, features, title_deed_status, permit_status, construction_status, delivery_date, developer_contact_id, owner_contact_id, assigned_agent_id";

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
