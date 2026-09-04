import { z } from "zod";

/**
 * What a website may post to the enquiry door (0084).
 *
 * The DATABASE function enforces these limits too, and deliberately: this
 * schema exists to give a site developer a useful 400 instead of a silent
 * false, not to be the security boundary. If the two ever disagree the
 * function wins, which is the right way round.
 *
 * Caps match 0084 exactly — 200 / 320 / 40 / 5000 / 40.
 */
export const publicEnquirySchema = z.object({
  org: z.string().trim().min(1, "An `org` slug is required.").max(80),
  name: z.string().trim().min(1, "A name is required.").max(200),
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.email("That email address is not valid.").max(320).optional(),
  ),
  phone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(40).optional(),
  ),
  message: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(5000).optional(),
  ),
  /** A listing reference the enquiry is about, e.g. PAF0001. */
  property_reference: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(40).optional(),
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
