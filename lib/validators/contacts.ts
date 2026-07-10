import { z } from "zod";

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

const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const optText = (max: number) => z.preprocess(emptyToUndefined, z.string().max(max).optional());

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
    psychology: z.preprocess(emptyToUndefined, z.enum(PSYCHOLOGY_PROFILES).optional()),
    consent_marketing: z
      .string()
      .optional()
      .transform((v) => v === "on" || v === "true"),
    notes: optText(5000),
  })
  .refine((d) => d.first_name || d.last_name || d.company_name, {
    message: "Give at least a first name, last name or company name",
    path: ["first_name"],
  });

export type CreateContactInput = z.infer<typeof createContactSchema>;

export const CONTACTS_PAGE_SIZE = 25;
