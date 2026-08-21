import { z } from "zod";
import { MANDATE_TYPES } from "@/lib/validators/mandates";
import {
  PERMIT_STATUSES,
  TITLE_DEED_STATUSES,
  VAT_STATUSES,
} from "@/lib/validators/properties";

/**
 * A party's standard terms (migration 0038).
 *
 * The operator's opening request: choosing a developer should fill the form
 * rather than leaving somebody to retype what that developer always works on.
 *
 * EVERY FIELD IS OPTIONAL, and an absent field means "no opinion" — which is
 * what lets the office fallback show through underneath. A stored zero or empty
 * string would be an opinion, and would shadow the layer below it.
 */
/**
 * Sentinel for "no standard" in a Select — Radix forbids an empty SelectItem
 * value, the same reason `AREA_NONE` exists in the properties validator. It is
 * handled HERE rather than in the action so the two cannot disagree about what
 * clearing a field means.
 */
export const TERM_NONE = "__none__";

const blank = (v: unknown) => (v === "" || v === null || v === TERM_NONE ? undefined : v);

export const partyDefaultsSchema = z.object({
  // mandate terms
  commission_pct: z.preprocess(
    blank,
    z.coerce.number().min(0, "Commission must be 0–100%").max(100, "Commission must be 0–100%").optional(),
  ),
  mandate_type: z.preprocess(blank, z.enum(MANDATE_TYPES).optional()),
  mandate_months: z.preprocess(
    blank,
    z.coerce.number().int().min(1, "At least 1 month").max(120, "At most 120 months").optional(),
  ),
  renewal_reminder_days: z.preprocess(
    blank,
    z.coerce.number().int().min(1).max(365).optional(),
  ),
  // property terms
  vat_status: z.preprocess(blank, z.enum(VAT_STATUSES).optional()),
  title_deed_status: z.preprocess(blank, z.enum(TITLE_DEED_STATUSES).optional()),
  permit_status: z.preprocess(blank, z.enum(PERMIT_STATUSES).optional()),
  district_id: z.preprocess(
    blank,
    z.string().refine((v) => z.guid().safeParse(v).success, "Pick a district").optional(),
  ),
  area_id: z.preprocess(
    blank,
    z.string().refine((v) => z.guid().safeParse(v).success, "Pick an area").optional(),
  ),
});

export type PartyDefaults = z.infer<typeof partyDefaultsSchema>;

/** The office-wide fallback, from `cyprus_config.default_mandate_terms`. */
export const officeDefaultsSchema = partyDefaultsSchema;

/**
 * Contact types for whom standard terms make sense.
 *
 * A buyer has no commission rate and no usual VAT treatment; showing them the
 * form would suggest otherwise.
 */
export const PARTY_TYPES = ["owner", "developer", "seller", "landlord"] as const;

export function isPartyContact(contactTypes: string[] | null | undefined): boolean {
  return (contactTypes ?? []).some((t) => (PARTY_TYPES as readonly string[]).includes(t));
}

/**
 * Merge the layers, most specific first.
 *
 * `unit ← project ← party ← office` in the audit's terms; here the caller has
 * already reduced that to the two that apply on a blank form — the party's own
 * terms, then the office's. A field the party has no opinion on falls through;
 * a field NEITHER has stays undefined, and the form leaves it blank rather than
 * inventing a value.
 *
 * `undefined` is the only thing that falls through. A stored 0 commission is a
 * real answer — some referral arrangements are zero — and must not be replaced
 * by the office's 3%.
 */
export function resolvePartyDefaults(
  party: PartyDefaults | null | undefined,
  office: PartyDefaults | null | undefined,
): PartyDefaults {
  const resolved: Record<string, unknown> = { ...(office ?? {}) };
  for (const [key, value] of Object.entries(party ?? {})) {
    if (value !== undefined && value !== null) resolved[key] = value;
  }
  return resolved as PartyDefaults;
}

/**
 * Which layer each resolved value came from, so the form can say so.
 *
 * A prefilled field that does not explain itself is a field people distrust and
 * retype — which would defeat the entire point.
 */
export function defaultsProvenance(
  party: PartyDefaults | null | undefined,
  office: PartyDefaults | null | undefined,
): Record<string, "party" | "office"> {
  const source: Record<string, "party" | "office"> = {};
  for (const key of Object.keys(office ?? {})) {
    if ((office as Record<string, unknown>)[key] !== undefined) source[key] = "office";
  }
  for (const [key, value] of Object.entries(party ?? {})) {
    if (value !== undefined && value !== null) source[key] = "party";
  }
  return source;
}
