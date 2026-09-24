import { z } from "zod";
import { isWellFormedShareToken } from "@/lib/services/share-links";
import { oneLine } from "@/lib/validators/single-line";

/**
 * What the proposal page posts when a buyer says "I'm interested" (0106).
 *
 * As with the website door, the DATABASE function decides everything that
 * matters — the link, the property, the org — and holds the same caps; this
 * schema exists to answer the page with a useful 400 and to keep junk away
 * from the meter. Caps match the door: 200 / 320 / 40 / 5000 / 40.
 *
 * A REJECTION IS A CODE, NOT A SENTENCE (audit 2026-09-22, finding 2). The
 * page is read in the visitor's language — English, Greek or Russian, as
 * the proposal was made — and until now a 400 handed it zod's English
 * message, which the page showed as it was. The route now answers with a
 * stable `code` and the `field` it concerns, and the page picks the sentence
 * (lib/services/proposal-interest-copy.ts). The English text kept here is
 * the API's `error` field, for a caller that is not the page.
 */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const proposalInterestSchema = z.object({
  /** The share token from the page URL; only its digest ever reaches the database. */
  token: z.string().refine(isWellFormedShareToken),
  // name, phone and reference are one line each in the header 0106 writes
  // (T-enquiry-identity-single-line, 0114) — checked before the caps
  property_reference: z
    .string()
    .trim()
    .refine(...oneLine("The property reference must be on one line."))
    .min(1)
    .max(40),
  name: z
    .string()
    .trim()
    .refine(...oneLine("The name must be on one line."))
    .min(1)
    .max(200),
  email: z.preprocess(blankToUndefined, z.email().max(320).optional()),
  phone: z.preprocess(
    blankToUndefined,
    z.string().trim().refine(...oneLine("The phone number must be on one line.")).max(40).optional(),
  ),
  message: z.preprocess(blankToUndefined, z.string().trim().max(5000).optional()),
  /** HONEYPOT — a person never sees it; anything here is accepted and dropped. */
  website: z.preprocess(blankToUndefined, z.string().max(200).optional()),
  /** Minted once per form by the page: a retry is the same lead. */
  idempotency_key: z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/),
});

export type ProposalInterestInput = z.infer<typeof proposalInterestSchema>;

/**
 * Every way this door refuses a body, as a stable word. The first nine are
 * what a VISITOR can cause with the form and each has a sentence in every
 * locale; the rest are what only the PAGE can get wrong (its token, its
 * reference, its key) and land on the page's generic sentence.
 *
 * `name_line_break` / `phone_line_break` (T-enquiry-identity-single-line):
 * the page's own inputs drop LF and CR (Chromium inserts a space), so a
 * visitor meets these only by pasting one of the rarer separators (NEL,
 * U+2028, …); a script meets them easily. They say what is wrong rather than
 * "required", which is what the mapping below would have said.
 */
export const PROPOSAL_INTEREST_ERROR_CODES = [
  "name_required",
  "name_too_long",
  "name_line_break",
  "email_invalid",
  "email_too_long",
  "phone_too_long",
  "phone_line_break",
  "message_too_long",
  "contact_required",
  "invalid_token",
  "property_reference_invalid",
  "idempotency_key_invalid",
  "invalid_request",
] as const;
export type ProposalInterestErrorCode = (typeof PROPOSAL_INTEREST_ERROR_CODES)[number];

/** The form control a code concerns; `contact` is the e-mail/phone pair; null is the form as a whole. */
export type ProposalInterestField = "name" | "email" | "phone" | "message" | "contact" | null;

export interface ProposalInterestProblem {
  code: ProposalInterestErrorCode;
  field: ProposalInterestField;
}

/** The API's own English words for each code — never zod's. */
export const PROPOSAL_INTEREST_ERROR_TEXT: Record<ProposalInterestErrorCode, string> = {
  name_required: "A name is required.",
  name_too_long: "The name is too long (200 characters at most).",
  name_line_break: "The name must be on one line — remove the line break.",
  email_invalid: "That email address is not valid.",
  email_too_long: "The email address is too long (320 characters at most).",
  phone_too_long: "The phone number is too long (40 characters at most).",
  phone_line_break: "The phone number must be on one line — remove the line break.",
  message_too_long: "The message is too long (5000 characters at most).",
  contact_required: "An email address or a phone number is required.",
  invalid_token: "That link is not valid.",
  property_reference_invalid: "A property reference is required.",
  idempotency_key_invalid: "idempotency_key must be 8–64 letters, digits or dashes.",
  invalid_request: "Invalid request.",
};

/**
 * The shape of a zod issue this mapping reads — the code, the path and, for a
 * refinement, the `reason` the schema gave it; nothing version-specific.
 */
type IssueLike = { code: string; path: ReadonlyArray<PropertyKey>; params?: Record<string, unknown> };

/**
 * One issue → one code and field. Reads the field from the path and the
 * kind of failure from zod's code: `too_big` is always "too long", a
 * `line_break` refinement is "one line"; anything else on a required field is
 * "required", on the e-mail "not valid". A field this door does not ask a
 * visitor for is the page's own mistake.
 */
export function interestProblemFromIssue(issue: IssueLike): ProposalInterestProblem {
  const field = String(issue.path[0] ?? "");
  const tooLong = issue.code === "too_big";
  const lineBreak = issue.code === "custom" && issue.params?.reason === "line_break";
  switch (field) {
    case "name":
      return { code: tooLong ? "name_too_long" : lineBreak ? "name_line_break" : "name_required", field: "name" };
    case "email":
      return { code: tooLong ? "email_too_long" : "email_invalid", field: "email" };
    case "phone":
      if (lineBreak) return { code: "phone_line_break", field: "phone" };
      return tooLong ? { code: "phone_too_long", field: "phone" } : { code: "invalid_request", field: null };
    case "message":
      return tooLong ? { code: "message_too_long", field: "message" } : { code: "invalid_request", field: null };
    case "token":
      return { code: "invalid_token", field: null };
    case "property_reference":
      return { code: "property_reference_invalid", field: null };
    case "idempotency_key":
      return { code: "idempotency_key_invalid", field: null };
    default:
      return { code: "invalid_request", field: null };
  }
}

/**
 * The problem to report for a rejected parse: the FIRST issue, which zod
 * lists in the schema's order — the order a person reads the form — so a
 * blank name is reported before a mistyped address beneath it.
 */
export function interestProblem(issues: ReadonlyArray<IssueLike>): ProposalInterestProblem {
  const first = issues[0];
  return first ? interestProblemFromIssue(first) : { code: "invalid_request", field: null };
}

/** A way to reply is the point of expressing interest. */
export function interestCompleteness(input: ProposalInterestInput): ProposalInterestProblem | null {
  if (!input.email && !input.phone) return { code: "contact_required", field: "contact" };
  return null;
}
