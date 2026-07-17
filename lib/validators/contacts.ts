import { z } from "zod";
import { ACCOUNT_FEASIBILITY, KYC_ITEMS } from "@/lib/constants/checklists";
import { PROPERTY_TYPES } from "@/lib/validators/properties";

export const CONTACT_KINDS = ["person", "company"] as const;
export const TEMPERATURES = ["hot", "warm", "cold", "inactive", "vip"] as const;
export const CONTACT_TYPES = [
  "buyer",
  "seller",
  "owner",
  "developer",
  "investor",
  "partner_agent",
  "lawyer",
  "banker",
  "tenant",
  "landlord",
] as const;
export const LEAD_SOURCES = [
  "website",
  "referral",
  "facebook",
  "instagram",
  "portal",
  "partner",
  "walk_in",
  "whatsapp",
  "telegram",
  "phone",
  "email",
  "other",
] as const;
/** lead_status values that count as "open" — in the inbox, workable, closable. */
export const LEAD_OPEN_STATUSES = ["new", "contacted", "qualified"] as const;
export const PSYCHOLOGY_PROFILES = [
  "investor",
  "relocation",
  "luxury",
  "retirement",
  "holiday",
  "local_family",
  "other",
] as const;
export const CONTACT_LANGUAGES = ["en", "el", "ru"] as const;

export const COMM_CHANNELS = [
  "whatsapp",
  "telegram",
  "phone",
  "email",
  "sms",
  "in_person",
  "other",
] as const;

export const CONTACT_PURPOSES = [
  "own_use",
  "investment",
  "relocation",
  "holiday_home",
  "rental_income",
] as const;

/**
 * Radix Select cannot re-select an empty value, so clearable selects offer an
 * explicit "—" item carrying this sentinel; validation treats it as unset.
 */
export const SELECT_NONE = "__none__";

const emptyToUndefined = (v: unknown) =>
  v === "" || v === null || v === SELECT_NONE ? undefined : v;
const optText = (max: number) => z.preprocess(emptyToUndefined, z.string().max(max).optional());
const optNonNegNumber = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  z.number().min(0).finite().optional(),
);
const optNonNegInt = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  z.number().int().min(0).optional(),
);

export const createContactSchema = z
  .object({
    contact_kind: z.enum(CONTACT_KINDS).default("person"),
    first_name: optText(100),
    last_name: optText(100),
    company_name: optText(200),
    phone: optText(40),
    email: z.preprocess(
      emptyToUndefined,
      z.string().email("Enter a valid email").toLowerCase().optional(),
    ),
    telegram_username: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .max(64)
        .transform((v) => v.replace(/^@/, ""))
        .optional(),
    ),
    has_whatsapp: z
      .string()
      .optional()
      .transform((v) => v === "on" || v === "true"),
    languages: z.array(z.enum(CONTACT_LANGUAGES)).default([]),
    nationality: optText(80),
    contact_types: z.array(z.enum(CONTACT_TYPES)).default([]),
    temperature: z.enum(TEMPERATURES).default("warm"),
    source: z.preprocess(emptyToUndefined, z.enum(LEAD_SOURCES).optional()),
    source_detail: optText(200),
    preferred_channel: z.preprocess(emptyToUndefined, z.enum(COMM_CHANNELS).optional()),
    psychology: z.preprocess(emptyToUndefined, z.enum(PSYCHOLOGY_PROFILES).optional()),
    consent_marketing: z
      .string()
      .optional()
      .transform((v) => v === "on" || v === "true"),
    gdpr_notes: optText(2000),
    notes: optText(5000),
    /** Admin-only reassignment on the profile tab; ignored for other roles. */
    assigned_agent_id: z.preprocess(emptyToUndefined, z.guid().optional()),
  })
  .refine((d) => d.first_name || d.last_name || d.company_name, {
    message: "Give at least a first name, last name or company name",
    path: ["first_name"],
  });

export type CreateContactInput = z.infer<typeof createContactSchema>;

/** Preferences tab payload (doc 02 §C3). `areas` stores area IDs (DECISIONS). */
export const contactPreferencesSchema = z
  .object({
    areas: z.array(z.string().max(100)).max(100).default([]),
    budget_min: optNonNegNumber,
    budget_max: optNonNegNumber,
    bedrooms_min: optNonNegInt,
    property_types: z.array(z.enum(PROPERTY_TYPES)).default([]),
    purpose: z.preprocess(emptyToUndefined, z.enum(CONTACT_PURPOSES).optional()),
  })
  .refine(
    (d) => d.budget_min === undefined || d.budget_max === undefined || d.budget_min <= d.budget_max,
    { message: "Budget min is above budget max", path: ["budget_min"] },
  );

export type ContactPreferencesInput = z.infer<typeof contactPreferencesSchema>;

const kycItemSchema = z.object({
  done: z.boolean(),
  note: z.string().max(500).optional(),
  doc_link: z.string().max(500).optional(),
});

/** KYC checklist jsonb — only known item keys, each {done, note?, doc_link?}. */
export const kycStateSchema = z.strictObject(
  Object.fromEntries(KYC_ITEMS.map(([key]) => [key, kycItemSchema.optional()])) as Record<
    (typeof KYC_ITEMS)[number][0],
    z.ZodOptional<typeof kycItemSchema>
  >,
);

export const bankingReadinessSchema = z.object({
  nationality_risk_note: z.string().max(500).optional(),
  funds_origin_country: z.string().max(200).optional(),
  bank_pre_check_done: z.literal(true).optional(),
  account_feasibility: z.enum(ACCOUNT_FEASIBILITY).optional(),
});

export const CONTACTS_PAGE_SIZE = 25;
