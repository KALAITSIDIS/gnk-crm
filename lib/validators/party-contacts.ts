import { z } from "zod";
import { LISTING_SOURCES } from "@/lib/validators/properties";

/**
 * Inline owner/developer creation from the property wizard (audit WF-10).
 * Extracted from lib/actions/party-contacts.ts so the schema is testable —
 * the action file imports server-only modules vitest cannot load.
 */
export const createPartySchema = z.object({
  source: z.enum(LISTING_SOURCES),
  name: z.string().trim().min(2, "Name is required").max(200),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .transform((v) => v || undefined),
  // .email() to match createLead/createContact — this was the one entry path
  // that skipped format validation (2026-09-01 review): "n/a" typed here
  // became contacts.email = "n/a", then poisoned 0077's email dedup (a second
  // junk value refused as a "duplicate" of the first) and every export that
  // trusts the column. Empty first, so an untouched field stays undefined.
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().email("Enter a valid email").max(200).toLowerCase().optional(),
  ),
});
