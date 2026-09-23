/**
 * What an `updated` event may say about a field that moved (audit SEC-03,
 * DECISIONS T-updated-event-shape-only).
 *
 * Events are hash-chained and never updated, and erasure leaves them alone by
 * design, so a value written into a payload outlives every request to erase or
 * rectify it. Until 2026-09-23 the section saves logged `{ from, to }` for
 * every field they changed — a corrected name, e-mail or phone entered the
 * chain twice, and so did every note. The actions still build that diff (they
 * read it: the consent event, the status regression, the renewal tasks); what
 * they LOG goes through `changesForChain`, which keeps from/to for the fields
 * the caller allows and replaces the rest with their shape: whether each side
 * held a value, and for an object the names of the sub-fields that moved. The
 * chain still proves that the field changed, when and by whom; the row holds
 * the value, where erasure and correction can reach it.
 *
 * `keys` are the column's own sub-field names (the KYC items, the banking
 * readiness fields, the language codes of a multilingual text) — schema words.
 * Do not mark as shape-only a jsonb column whose KEYS are data.
 */
import { changedValue } from "@/lib/utils/diff";

export type FieldChange = { from: unknown; to: unknown };
export type ShapeOnlyChange = { from_set: boolean; to_set: boolean; keys?: string[] };
export type ChainChange = FieldChange | ShapeOnlyChange;

export function changesForChain(
  changed: Record<string, FieldChange>,
  shapeOnly: (field: string) => boolean,
): Record<string, ChainChange> {
  return Object.fromEntries(
    Object.entries(changed).map(([field, change]) => [
      field,
      shapeOnly(field) ? shapeOf(change) : change,
    ]),
  );
}

function shapeOf({ from, to }: FieldChange): ShapeOnlyChange {
  const shape: ShapeOnlyChange = { from_set: isSet(from), to_set: isSet(to) };
  if (isPlainObject(from) || isPlainObject(to)) {
    const before = isPlainObject(from) ? from : {};
    const after = isPlainObject(to) ? to : {};
    shape.keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => changedValue(before[key], after[key]))
      .sort();
  }
  return shape;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSet(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true;
}

/** A note is text somebody typed — about a person as often as not. */
export const isNoteField = (field: string) => field === "notes" || field.endsWith("_notes");

/**
 * The contact columns whose values an event may carry: the desk's own
 * classification of the contact and its work state, never the person. An
 * ALLOW-list, because the contact row IS the person — a column added later
 * records shape only until somebody decides otherwise.
 *
 * Left out on purpose: the identifiers (names, company name, phones, e-mail,
 * Telegram handle), the typed text (notes, GDPR notes, source detail), what
 * erasure clears as the person's profile (languages, nationality, psychology),
 * and the KYC checklist and banking readiness, which hold typed notes,
 * document links and a country. `consent_marketing` stays: SEC-06 writes the
 * flip as its own `consent_changed` event anyway, because consent has to be
 * demonstrable.
 */
const CONTACT_VALUE_FIELDS: ReadonlySet<string> = new Set([
  "contact_kind",
  "contact_types",
  "temperature",
  "source",
  "preferred_channel",
  "has_whatsapp",
  "consent_marketing",
  "consent_at",
  "assigned_agent_id",
]);

export const contactShapeOnly = (field: string) => !CONTACT_VALUE_FIELDS.has(field);
