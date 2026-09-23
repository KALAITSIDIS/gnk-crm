import { parseWebsiteEnquiry } from "./lead-contact";
import { formatPhone, normalizePhone } from "./phone";

/**
 * "Possible existing contact" on an unlinked website enquiry — the
 * deterministic half (T-enquiry-contact-suggestions). Pure: no I/O.
 *
 * A website enquiry carries the visitor's e-mail and phone in the header the
 * door writes (parseWebsiteEnquiry). They are UNVERIFIED — anyone can type
 * anyone's address — so a match here is evidence for a person to weigh, never
 * proof, and nothing is linked, merged or created without a confirmation.
 *
 * Matching is exact after the normalisation every contact write already
 * applies: an e-mail lower-cased and trimmed, a phone as E.164 through
 * normalizePhone (default region CY), compared with `phone_e164` and with the
 * numbers parked in `additional_phones`. No names, no similarity, no scores:
 * a threshold is a number nobody can defend later (the property duplicate
 * guard's rule, BACKLOG).
 *
 * The wording lives here too, so a test pins it and the components only
 * render it (the desk-alert convention).
 */

/** Earlier enquiries shown per candidate. The query fetches one more, to know there are more. */
export const SUGGESTION_HISTORY_LIMIT = 3;
/** Candidates shown per enquiry. Unique indexes make more than two rare: only `additional_phones` repeats. */
export const SUGGESTION_CANDIDATE_LIMIT = 5;
/** Candidate rows one inbox page may fetch; past it the lookup is reported unavailable, never partial. */
export const SUGGESTION_LOOKUP_LIMIT = 100;

export interface EnquiryMatchKeys {
  email: string | null;
  phoneE164: string | null;
}

export type EnquiryKeysResult =
  | { kind: "keys"; keys: EnquiryMatchKeys }
  /** the header could not be read: redacted, desk-typed, or not the door's block */
  | { kind: "unreadable" }
  /** the header was read but holds no e-mail or phone that could match anything */
  | { kind: "no_identifiers" };

/**
 * The shape of an address worth looking up. Stored contact e-mails passed
 * `z.email()` on the way in; anything with whitespace, quotes, commas,
 * parentheses or a backslash could not be one — and would have to be escaped
 * inside a PostgREST filter, which is the other reason to refuse it here.
 */
const MATCHABLE_EMAIL = /^[^\s"(),\\@]+@[^\s"(),\\@]+$/;
/** RFC 5321's longest address. The door takes 320; a longer one is refused here, not sent in a URL. */
const MAX_EMAIL = 254;
/** What normalizePhone emits; checked again because the value goes into a filter string. */
const E164 = /^\+\d+$/;

export function normalizeEmailForMatch(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL && MATCHABLE_EMAIL.test(email) ? email : null;
}

/**
 * What a website enquiry can be matched on. A redacted message yields nothing:
 * erased details are never rebuilt. Every key returned is one the lookup
 * really searches — a key it could not search must never read as "no match".
 */
export function enquiryMatchKeys(message: string | null | undefined): EnquiryKeysResult {
  const person = parseWebsiteEnquiry(message);
  if (!person) return { kind: "unreadable" };
  const email = normalizeEmailForMatch(person.email);
  const e164 = person.phone ? (normalizePhone(person.phone)?.e164 ?? null) : null;
  const phoneE164 = e164 && E164.test(e164) ? e164 : null;
  if (!email && !phoneE164) return { kind: "no_identifiers" };
  return { kind: "keys", keys: { email, phoneE164 } };
}

export interface SuggestionHistoryItem {
  id: string;
  received_at: string;
  status: string;
  assigned_agent_id: string | null;
  /** null for an enquiry about no listing in particular */
  property: { id: string; reference: string } | null;
}

/** A contact row as the lookup returns it, with its most recent linked enquiries. */
export interface CandidateRow {
  id: string;
  display_name: string | null;
  email: string | null;
  phone_e164: string | null;
  additional_phones: string[] | null;
  /** newest first, at most SUGGESTION_HISTORY_LIMIT + 1 */
  history: SuggestionHistoryItem[];
}

export interface MatchEvidence {
  email: boolean;
  /** which of the contact's numbers is the enquiry's */
  phone: "primary" | "additional" | null;
}

export type MatchedOn = "email_and_phone" | "email" | "phone";

export function matchEvidence(
  keys: EnquiryMatchKeys,
  contact: Pick<CandidateRow, "email" | "phone_e164" | "additional_phones">,
): MatchEvidence {
  // Stored addresses are lower-case — every contact write path lower-cases
  // (createLead's since this task) and hosted holds none that is not — so the
  // lookup's exact `email in (…)` is enough; the comparison here mirrors it.
  const email = Boolean(keys.email && contact.email && contact.email === keys.email);
  let phone: MatchEvidence["phone"] = null;
  if (keys.phoneE164) {
    if (contact.phone_e164 === keys.phoneE164) phone = "primary";
    else if ((contact.additional_phones ?? []).includes(keys.phoneE164)) phone = "additional";
  }
  return { email, phone };
}

export function matchedOn(evidence: MatchEvidence): MatchedOn | null {
  if (evidence.email && evidence.phone) return "email_and_phone";
  if (evidence.email) return "email";
  if (evidence.phone) return "phone";
  return null;
}

export interface Suggestion {
  contact: { id: string; name: string };
  evidence: MatchEvidence;
  matchedOn: MatchedOn;
  /** newest first, at most SUGGESTION_HISTORY_LIMIT */
  history: SuggestionHistoryItem[];
  /** older linked enquiries exist and are not shown */
  moreHistory: boolean;
}

export interface SuggestionSet {
  candidates: Suggestion[];
  /** more contacts matched than SUGGESTION_CANDIDATE_LIMIT */
  moreCandidates: boolean;
  /**
   * The e-mail and the phone point at DIFFERENT contacts and no contact
   * carries both — the case that must never be settled by picking one.
   */
  split: { emailMatches: string[]; phoneMatches: string[] } | null;
}

const RANK = (e: MatchEvidence): number =>
  e.email && e.phone ? 0 : e.email ? 1 : e.phone === "primary" ? 2 : 3;

export function buildSuggestions(keys: EnquiryMatchKeys, rows: readonly CandidateRow[]): SuggestionSet {
  const matched: Suggestion[] = [];
  for (const row of rows) {
    const evidence = matchEvidence(keys, row);
    const on = matchedOn(evidence);
    if (!on) continue;
    matched.push({
      contact: { id: row.id, name: row.display_name?.trim() || "Unnamed contact" },
      evidence,
      matchedOn: on,
      history: row.history.slice(0, SUGGESTION_HISTORY_LIMIT),
      moreHistory: row.history.length > SUGGESTION_HISTORY_LIMIT,
    });
  }

  matched.sort(
    (a, b) =>
      RANK(a.evidence) - RANK(b.evidence) ||
      a.contact.name.localeCompare(b.contact.name, "en", { sensitivity: "base" }) ||
      (a.contact.id < b.contact.id ? -1 : a.contact.id > b.contact.id ? 1 : 0),
  );

  const byEmail = matched.filter((s) => s.evidence.email);
  const byPhone = matched.filter((s) => s.evidence.phone);
  const split =
    byEmail.length > 0 && byPhone.length > 0 && !matched.some((s) => s.matchedOn === "email_and_phone")
      ? { emailMatches: byEmail.map((s) => s.contact.name), phoneMatches: byPhone.map((s) => s.contact.name) }
      : null;

  return {
    candidates: matched.slice(0, SUGGESTION_CANDIDATE_LIMIT),
    moreCandidates: matched.length > SUGGESTION_CANDIDATE_LIMIT,
    split,
  };
}

// ---------------------------------------------------------------------------
// Wording — pinned by enquiry-contact-match.test.ts; components only render it.

export function suggestionHeading(count: number): string {
  return count === 1 ? "Possible existing contact" : `${count} possible existing contacts`;
}

export function reasonLabel(evidence: MatchEvidence): string {
  const another = evidence.phone === "additional" ? " (another number on the contact)" : "";
  if (evidence.email && evidence.phone) return `Same e-mail and phone${another}`;
  if (evidence.email) return "Same e-mail";
  return `Same phone${another}`;
}

/**
 * The evidence, line by line, for the confirmation dialog: what the enquiry
 * gave, and whether this contact has it. A key the contact does NOT share is
 * said too — "same phone, different e-mail" is exactly what a person needs to
 * see before deciding. The contact's own values are not repeated: the dialog
 * links to the contact.
 */
export function evidenceLines(keys: EnquiryMatchKeys, evidence: MatchEvidence): string[] {
  const lines: string[] = [];
  if (keys.email) {
    lines.push(
      evidence.email
        ? `E-mail ${keys.email} — the same as this contact's e-mail.`
        : `E-mail ${keys.email} — not this contact's e-mail.`,
    );
  }
  if (keys.phoneE164) {
    const phone = formatPhone(keys.phoneE164);
    lines.push(
      evidence.phone === "primary"
        ? `Phone ${phone} — the same as this contact's phone.`
        : evidence.phone === "additional"
          ? `Phone ${phone} — one of this contact's other numbers.`
          : `Phone ${phone} — not one of this contact's numbers.`,
    );
  }
  return lines;
}

const names = (list: string[]) => list.join(" and ");

/** The sentence under the heading when one candidate is not the whole story. */
export function ambiguityNote(set: SuggestionSet): string | null {
  if (set.split) {
    return `The e-mail matches ${names(set.split.emailMatches)}, but the phone matches ${names(set.split.phoneMatches)}. They may be different people — check before linking.`;
  }
  if (set.candidates.length > 1) {
    return "More than one contact shares this enquiry's e-mail or phone — check which one this is before linking.";
  }
  return null;
}

export const SUGGESTION_CAUTION = "A shared e-mail or phone suggests, but does not prove, that this is the same person.";
export const SUGGESTION_MORE_HISTORY = `Showing the ${SUGGESTION_HISTORY_LIMIT} most recent only.`;
export const SUGGESTION_NO_HISTORY = "No enquiries are linked to this contact yet.";
export const SUGGESTION_MORE_CANDIDATES =
  "More contacts match than are shown — search Contacts before linking.";

/** The one-line summary of a candidate's recent enquiries, shown before they are opened. */
export function historySummary(count: number, more: boolean, latest: string | null): string {
  if (count === 0) return SUGGESTION_NO_HISTORY;
  const n = more ? `${count}+` : String(count);
  return `${n} recent ${count === 1 && !more ? "enquiry" : "enquiries"}${latest ? ` · latest ${latest}` : ""}`;
}

/** One sentence for each state that is not a list of candidates. */
export const SUGGESTION_STATE_TEXT = {
  // "active": archived, merged and erased contacts are deliberately not offered
  no_match: "No active contact has this enquiry's e-mail or phone.",
  unavailable: "Could not check for an existing contact — refresh to try again.",
  no_identifiers: "No usable e-mail or phone in this enquiry to match against contacts.",
  unreadable: "This enquiry's details could not be read — link the contact by hand.",
} as const;
