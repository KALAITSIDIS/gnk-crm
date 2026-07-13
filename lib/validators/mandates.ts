import { z } from "zod";

export const MANDATE_TYPES = ["exclusive", "open", "verbal"] as const;
export type MandateType = (typeof MANDATE_TYPES)[number];

export const MANDATE_STATUSES = ["draft", "active", "expired", "terminated"] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

/** Admin status actions; `expired` is cron-only (expire_mandates). */
export const MANDATE_TRANSITIONS: Record<string, readonly MandateStatus[]> = {
  draft: ["active", "terminated"],
  active: ["terminated"],
  expired: [],
  terminated: [],
};

// z.guid(), not z.uuid() — Zod 4 uuid() rejects seeded fixture ids (T3.2)
const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v && z.guid().safeParse(v).success ? v : undefined));

const optionalDate = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v || !v.trim()) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Date must be YYYY-MM-DD" });
      return z.NEVER;
    }
    return v;
  });

const optionalNote = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .optional()
    .transform((v) => v || undefined);

export const saveMandateSchema = z
  .object({
    mandate_id: optionalUuid, // present = update
    property_id: z.guid("Missing property"),
    type: z.enum(MANDATE_TYPES),
    owner_contact_id: optionalUuid,
    commission_pct: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (!v || !v.trim()) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Commission must be 0–100%" });
          return z.NEVER;
        }
        return n;
      }),
    commission_notes: optionalNote(2000),
    start_date: optionalDate,
    expiry_date: optionalDate,
    renewal_reminder_days: z.coerce
      .number()
      .int()
      .min(1, "At least 1 day")
      .max(365, "At most 365 days")
      .default(30),
    notes: optionalNote(4000),
  })
  .refine(
    (d) => !d.start_date || !d.expiry_date || d.expiry_date > d.start_date,
    { message: "Expiry must be after the start date", path: ["expiry_date"] },
  );
