import { z } from "zod";
import { isWellFormedShareToken } from "@/lib/services/share-links";

/**
 * What the proposal page posts when a buyer says "I'm interested" (0106).
 *
 * As with the website door, the DATABASE function decides everything that
 * matters — the link, the property, the org — and holds the same caps; this
 * schema exists to answer the page with a useful 400 and to keep junk away
 * from the meter. Caps match the door: 200 / 320 / 40 / 5000 / 40.
 */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const proposalInterestSchema = z.object({
  /** The share token from the page URL; only its digest ever reaches the database. */
  token: z.string().refine(isWellFormedShareToken, "That link is not valid."),
  property_reference: z.string().trim().min(1, "A property reference is required.").max(40),
  name: z.string().trim().min(1, "A name is required.").max(200),
  email: z.preprocess(blankToUndefined, z.email("That email address is not valid.").max(320).optional()),
  phone: z.preprocess(blankToUndefined, z.string().trim().max(40).optional()),
  message: z.preprocess(blankToUndefined, z.string().trim().max(5000).optional()),
  /** HONEYPOT — a person never sees it; anything here is accepted and dropped. */
  website: z.preprocess(blankToUndefined, z.string().max(200).optional()),
  /** Minted once per form by the page: a retry is the same lead. */
  idempotency_key: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{8,64}$/, "idempotency_key must be 8–64 letters, digits or dashes."),
});

export type ProposalInterestInput = z.infer<typeof proposalInterestSchema>;

/** A way to reply is the point of expressing interest. */
export function interestCompleteness(input: ProposalInterestInput): string | null {
  if (!input.email && !input.phone) return "An email address or a phone number is required.";
  return null;
}
