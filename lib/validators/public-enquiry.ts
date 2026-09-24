import { z } from "zod";
import { cleanEnquiryMeta } from "@/lib/services/enquiry-meta";
import { oneLine } from "@/lib/validators/single-line";

/**
 * What a website may post to the enquiry door (0084).
 *
 * The DATABASE function enforces these limits too, and deliberately: this
 * schema exists to give a site developer a useful 400 instead of a silent
 * false, not to be the security boundary. If the two ever disagree the
 * function wins, which is the right way round.
 *
 * Caps match 0084 exactly — 200 / 320 / 40 / 5000 / 40. Name, phone and
 * reference are one line each (0114); the e-mail needs no rule of its own,
 * because an address with a line break in it is not an address.
 */
export const publicEnquirySchema = z.object({
  org: z.string().trim().min(1, "An `org` slug is required.").max(80),
  name: z
    .string()
    .trim()
    .refine(...oneLine("The name must be on one line — remove the line break."))
    .min(1, "A name is required.")
    .max(200),
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.email("That email address is not valid.").max(320).optional(),
  ),
  phone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .trim()
      .refine(...oneLine("The phone number must be on one line — remove the line break."))
      .max(40)
      .optional(),
  ),
  message: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(5000).optional(),
  ),
  /** A listing reference the enquiry is about, e.g. PAF0001. */
  property_reference: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .trim()
      .refine(...oneLine("The `property_reference` must be on one line — remove the line break."))
      .max(40)
      .optional(),
  ),
  /**
   * HONEYPOT. A field a person never sees and never fills; a bot that fills
   * every input fills this one too. Anything here and the submission is
   * accepted as far as the caller can tell, and dropped. Cheap, and it costs
   * a real visitor nothing.
   */
  website: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().max(200).optional(),
  ),
  /**
   * Minted by the site per form (0096): a repeated post with the same key
   * answers with the same lead instead of making a second one. Random, not
   * personal. The database refuses any other shape; this says why first.
   */
  idempotency_key: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{8,64}$/, "idempotency_key must be 8–64 letters, digits or dashes.")
      .optional(),
  ),
  /**
   * The site's structured brief and provenance (0098): budget band, area,
   * type, timing, deed position, the page it was posted from, campaign
   * parameters, a consent version. Cleaned here against the same allowlist
   * the database function holds — a useful 400-side copy, not the boundary —
   * so what reaches p_meta is already string-only, trimmed and capped. A
   * value that is not an object is treated as absent rather than refused: the
   * brief is optional, and a site that sends nothing is still a site.
   */
  meta: z.preprocess(
    (v) => (v && typeof v === "object" && !Array.isArray(v) ? cleanEnquiryMeta(v) : undefined),
    z.record(z.string(), z.string()).optional(),
  ),
});

export type PublicEnquiryInput = z.infer<typeof publicEnquirySchema>;

/**
 * An enquiry needs a way to reply and something to reply about. Kept out of
 * the object schema so each half can carry its own sentence — a site
 * developer reading a 400 should not have to guess which rule they broke.
 */
export function enquiryCompleteness(input: PublicEnquiryInput): string | null {
  if (!input.email && !input.phone) return "An email address or a phone number is required.";
  if (!input.message && !input.property_reference) {
    return "Either a message or a `property_reference` is required.";
  }
  return null;
}
