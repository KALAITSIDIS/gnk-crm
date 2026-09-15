import { z } from "zod";
import { zonedWallClockToUtc } from "@/lib/utils/tz";
import { COMM_CHANNELS, LEAD_SOURCES } from "@/lib/validators/contacts";

/**
 * The Add-lead form (doc 02 §C4), lifted out of the "use server" action file
 * so it is unit-testable (0098).
 *
 * `received_at` (audit LR-04): a call or a WhatsApp logged after the fact
 * carries WHEN it arrived — a `datetime-local` value in Cyprus wall-clock
 * time, converted by the action — so the response-time KPI measures the desk
 * and not the typing. Blank means now. The future is refused: a lead cannot
 * arrive tomorrow, and a typo there would make the clock read negative.
 */
const emptyToUndefined = (v: unknown) => (v === "" || v === null || v === "none" ? undefined : v);

// z.guid(), not z.uuid() — Zod 4 uuid() rejects seeded fixture ids (T3.2)
export const createLeadSchema = z.object({
  source: z.enum(LEAD_SOURCES),
  channel: z.preprocess(emptyToUndefined, z.enum(COMM_CHANNELS).optional()),
  message: z.preprocess(emptyToUndefined, z.string().max(5000).optional()),
  contact_id: z.preprocess(emptyToUndefined, z.guid().optional()),
  /** the listing the enquiry is about — the column existed since T2; the form never sent it until 0098 */
  property_id: z.preprocess(emptyToUndefined, z.guid().optional()),
  // New-enquirer capture (doc 02 §C4 "create contact"): a name plus optional
  // phone/email. Ignored when an existing contact_id is picked.
  new_contact_name: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  new_contact_phone: z.preprocess(emptyToUndefined, z.string().max(40).optional()),
  new_contact_email: z.preprocess(emptyToUndefined, z.string().email().max(200).optional()),
  received_at: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Received must be a date and a time")
      .refine(
        (v) => {
          try {
            // a minute of grace: the field is filled from a clock that ticks
            return zonedWallClockToUtc(v).getTime() <= Date.now() + 60_000;
          } catch {
            return false;
          }
        },
        { message: "Received cannot be in the future" },
      )
      .optional(),
  ),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
