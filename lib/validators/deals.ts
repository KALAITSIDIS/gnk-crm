import { z } from "zod";

export const OFFER_STATUSES = [
  "submitted",
  "countered",
  "accepted",
  "rejected",
  "withdrawn",
  "expired",
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/**
 * Allowed offer status transitions (doc 02 §C5). Terminal states have none —
 * a decided offer is never reopened; record a new offer instead. Enforced
 * server-side in updateOfferStatus.
 */
export const OFFER_TRANSITIONS: Record<OfferStatus, readonly OfferStatus[]> = {
  submitted: ["countered", "accepted", "rejected", "withdrawn", "expired"],
  countered: ["accepted", "rejected", "withdrawn", "expired"],
  accepted: [],
  rejected: [],
  withdrawn: [],
  expired: [],
};

/** Statuses that stamp decided_at when entered. */
export const DECIDED_STATUSES: readonly OfferStatus[] = [
  "accepted",
  "rejected",
  "withdrawn",
  "expired",
];

// z.guid(), not z.uuid(): Postgres' uuid type accepts any 32-hex-digit value,
// while Zod 4's uuid() enforces RFC 4122 variant bits and silently rejects
// fixture ids like the seeded 11111111-… admin — which nulled fields on save.
const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v && z.guid().safeParse(v).success ? v : undefined));

const optionalMoney = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v || !v.trim()) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 999_999_999_999) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Value must be a positive amount" });
      return z.NEVER;
    }
    return n;
  });

const requiredMoney = z
  .string({ message: "Amount is required" })
  .transform((v, ctx) => {
    const n = Number(v);
    if (!v.trim() || !Number.isFinite(n) || n <= 0 || n > 999_999_999_999) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Amount must be a positive number" });
      return z.NEVER;
    }
    return n;
  });

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

export const dealDetailsSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  property_id: optionalUuid,
  buyer_contact_id: optionalUuid,
  seller_contact_id: optionalUuid,
  agent_id: optionalUuid,
  expected_value: optionalMoney,
});

export const dealCommissionSchema = z.object({
  // MANUAL plain text by design (doc 01 guardrail 8) — never structured splits
  commission_split_notes: z
    .string()
    .trim()
    .max(4000, "Keep notes under 4000 characters")
    .optional(),
});

export const saveOfferSchema = z.object({
  offer_id: optionalUuid,
  deal_id: z.guid("Missing deal"),
  contact_id: optionalUuid,
  amount: requiredMoney,
  terms: z
    .string()
    .trim()
    .max(2000, "Keep terms under 2000 characters")
    .optional()
    .transform((v) => v || undefined),
  valid_until: optionalDate,
});
