/**
 * GDPR Article 17 erasure planning for contacts — pure, no I/O.
 *
 * Kept separate from the server action because the AML branch is the part that
 * must never silently change: it decides whether a passport scan is destroyed
 * or retained. Every rule here is unit-tested.
 *
 * Erasure is a REDACTION. Event payloads are hash-chained and viewing slips are
 * immutable commission evidence, so neither is touched; Cyprus AML additionally
 * requires customer due-diligence records to outlive the relationship by five
 * years. See docs/superpowers/specs/2026-07-21-gdpr-contact-erasure-design.md.
 */

/** Cyprus AML: CDD records kept 5 years past the end of the relationship. */
export const AML_RETENTION_YEARS = 5;

export const LEAD_MESSAGE_REDACTED = "[erased at the contact's request]";

/** Field groups reported on the audit event — categories, never values. */
export const ERASED_FIELD_GROUPS = [
  "notes",
  "profiling",
  // 0055: the buyer's criteria used to live in `contacts.preferences` and were
  // cleared with the rest of the profiling layer. The column is gone and the
  // criteria are ROWS now (`buyer_requirements`, 0043), so erasure deletes
  // those rows instead — dropping the column must not quietly narrow what
  // Article 17 reaches.
  "saved_searches",
  "contact_channels",
  "demographics",
  "marketing_consent",
  "banking_readiness",
] as const;

export interface ErasureContactInput {
  id: string;
  display_name: string | null;
  erased_at: string | null;
}

/**
 * An AML relationship exists once the contact has actually transacted or been
 * taken through a viewing/mandate — the trigger for customer due diligence. A
 * pure enquirer never created one, so nothing must be retained for them.
 */
export interface AmlSignals {
  dealCount: number;
  viewingSlipCount: number;
  mandateCount: number;
}

export function hasAmlRelationship(signals: AmlSignals): boolean {
  return signals.dealCount > 0 || signals.viewingSlipCount > 0 || signals.mandateCount > 0;
}

/** Columns written to `contacts`. Identity fields are deliberately absent. */
export interface ErasurePatch {
  notes: null;
  gdpr_notes: string;
  psychology: null;
  source_detail: null;
  telegram_username: null;
  additional_phones: string[];
  nationality: null;
  languages: string[];
  banking_readiness: Record<string, never>;
  has_whatsapp: false;
  consent_marketing: false;
  consent_at: null;
  temperature: "inactive";
  is_archived: true;
  erased_at: string;
  erased_by: string;
  retention_until: string | null;
  kyc?: Record<string, never>;
}

export interface ErasurePlan {
  patch: ErasurePatch;
  /** true when KYC documents + files must be destroyed (no AML basis to keep) */
  deleteDocuments: boolean;
  retentionUntil: string | null;
}

function addYears(iso: string, years: number): string {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/**
 * CY-03 (2026-09-02): the anchor for the 5-year AML clock is the END OF THE
 * RELATIONSHIP, not the erasure date — the file header always said so, the
 * code silently used `now` as a proxy (found by the 2026-09-01 review).
 *
 * The anchor is the LATEST end-signal (deal won/lost, slip signature,
 * mandate expiry), CLAMPED to `now`: a future mandate expiry means the
 * relationship was still ongoing, and the erasure itself ends it — which is
 * also the fallback when no end-signal exists at all (exactly the old
 * behavior, so a contact with only open deals keeps erasure-date anchoring).
 * A long-past anchor can land retention_until BEFORE today — then the duty
 * has already lapsed and /settings/retention immediately offers the purge,
 * which is CY-03's point: records were being kept five years too long.
 */
export function resolveRetentionAnchor(candidates: (string | null)[], now: string): string {
  const ends = candidates
    .filter((c): c is string => Boolean(c && !Number.isNaN(Date.parse(c))))
    .map((c) => new Date(c).toISOString());
  if (ends.length === 0) return now;
  const latest = ends.sort()[ends.length - 1];
  return latest < now ? latest : now;
}

export function planContactErasure(input: {
  amlBasis: boolean;
  actorId: string;
  /** ISO timestamp; injected so the plan is deterministic under test */
  now: string;
  /**
   * End-of-relationship signals gathered by the action (deal won_at/lost_at,
   * slip signed_at, mandate expiry_date) — nulls welcome. See
   * resolveRetentionAnchor for the clamping rule.
   */
  relationshipEndCandidates: (string | null)[];
}): ErasurePlan {
  const { amlBasis, actorId, now, relationshipEndCandidates } = input;
  const retentionUntil = amlBasis
    ? addYears(resolveRetentionAnchor(relationshipEndCandidates, now), AML_RETENTION_YEARS)
    : null;

  const patch: ErasurePatch = {
    notes: null,
    gdpr_notes: `Personal data erased ${now.slice(0, 10)} under GDPR Art.17. See the contact's event log for the record of what was erased and retained.`,
    psychology: null,
    source_detail: null,
    telegram_username: null,
    additional_phones: [],
    nationality: null,
    languages: ["en"],
    banking_readiness: {},
    has_whatsapp: false,
    consent_marketing: false,
    consent_at: null,
    // never resurface on a hot-buyer or marketing surface again
    temperature: "inactive",
    is_archived: true,
    erased_at: now,
    erased_by: actorId,
    retention_until: retentionUntil,
  };

  // Where records are retained the KYC checklist IS the due-diligence record,
  // so it survives; with no AML basis there is nothing to justify keeping it.
  if (!amlBasis) patch.kyc = {};

  return { patch, deleteDocuments: !amlBasis, retentionUntil };
}

/** Audit payload — categories and counts only, never the erased values. */
export function buildErasureEventPayload(input: {
  amlBasis: boolean;
  retentionUntil: string | null;
  leadsRedacted: number;
  /** 0055: saved searches removed — counted so the audit says how many */
  requirementsDeleted: number;
  documentsDeleted: number;
  documentsRetained: number;
}): Record<string, unknown> {
  return {
    fields_cleared: [
      ...ERASED_FIELD_GROUPS,
      ...(input.amlBasis ? [] : ["kyc_checklist"]),
    ],
    aml_basis: input.amlBasis,
    retention_until: input.retentionUntil,
    leads_redacted: input.leadsRedacted,
    saved_searches_deleted: input.requirementsDeleted,
    documents_deleted: input.documentsDeleted,
    documents_retained: input.documentsRetained,
    identity_retained: true,
    untouched: ["events", "viewing_slips", "evidence_reports", "deals"],
  };
}
