import { z } from "zod";
import { internationalPhoneDigits } from "./phone";

/**
 * THE ONE DEFINITION of each external portal (spec 2026-09-14 §Registry).
 *
 * Not a table: the set of portals the code can serialise for is a fact about
 * the code, and a row that named a dialect no renderer exists for would be a
 * lie the desk could enable. `portal_connections.portal` stores these ids as
 * text; the 0095 check constraint pins the shape and registry.test.ts pins
 * the list, so a typo cannot silently create a portal.
 */
export const DIALECTS = ["kyero", "rera", "trovit", "bazaraki", "prian"] as const;
export type Dialect = (typeof DIALECTS)[number];

export const PORTAL_IDS = [
  "jamesedition",
  "aplaceinthesun",
  "properstar",
  "uk_provider",
  "rera",
  "thribee",
  "bazaraki",
  "prian",
] as const;
export type PortalId = (typeof PORTAL_IDS)[number];

/**
 * Migration 0095 pins the same regex as a CHECK constraint; the RLS suite
 * cross-checks the two.
 */
export const PORTAL_ID_PATTERN = /^[a-z_]{2,40}$/;

export interface PortalSettingField {
  key: string;
  label: string;
  placeholder?: string;
}

export interface PortalDefinition {
  readonly id: PortalId;
  readonly name: string;
  readonly dialect: Dialect;
  /** one line for the settings page */
  readonly audience: string;
  /**
   * `pending`: no renderer exists in this build, so the enable switch
   * refuses it — either the portal's format is not public (Bazaraki, Prian)
   * or its renderer waits on what `pendingReason` names.
   */
  readonly spec: "public" | "pending";
  /** why a pending portal cannot be enabled yet, in the desk's words; null for a public one */
  readonly pendingReason: string | null;
  readonly requirements: {
    readonly minPhotos: number;
    /** the smallest JPEG the portal accepts (its documented rule); absent = no stated minimum */
    readonly minImage?: { readonly width: number; readonly height: number };
    readonly needsCoords: boolean;
    /** which of the CRM's three languages the dialect can carry */
    readonly languages: readonly ("en" | "el" | "ru")[];
    /** CRM property types the PORTAL refuses even though its dialect can name them */
    readonly excludedPropertyTypes?: readonly string[];
    /** the desk sentence for `type_not_accepted` */
    readonly excludedTypesNote?: string;
  };
  /**
   * The portal's own moderation, which runs AFTER the feed and never reports
   * back to the CRM. Used only for advisories — never to keep a listing out.
   */
  readonly moderation?: {
    /** sale listings below this, per currency, are refused */
    readonly minSalePrice?: Readonly<Record<string, number>>;
  };
  /** setting keys without which the enable switch refuses */
  readonly requiredSettings: readonly string[];
  readonly settingsFields: readonly PortalSettingField[];
  /** what the FEED parses stored settings with — lenient, so a typo cannot take a feed down */
  readonly settingsSchema: z.ZodObject<Record<string, z.ZodType<string>>>;
  /** what a SAVE parses the form with — stricter, so new typos are refused at the desk */
  readonly settingsFormSchema: z.ZodObject<Record<string, z.ZodType<string>>>;
  /** words for the desk, not a schedule the CRM runs */
  readonly pullCadence: string;
  /**
   * Hours without a request, while the portal is enabled with listings
   * selected, after which Settings → Portals calls the feed stale. Three
   * missed pulls for a portal with a stated schedule; null when unknown.
   */
  readonly staleAfterHours: number | null;
  /** where the desk can see whether the portal accepted or published a listing — the CRM cannot */
  readonly publicationCheck: string;
  readonly docsUrl: string;
}

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

/** A phone field the save refuses unless it rewrites to 00 + country code (phone.ts). */
const phoneField = (label: string) =>
  z
    .string()
    .trim()
    .max(40)
    .refine(
      (v) => v === "" || internationalPhoneDigits(v) !== null,
      `${label}: enter it with the country code, e.g. +357 26 000000, or leave it blank`,
    )
    .optional()
    .default("");

/** Kyero v3.7–3.9 contact nodes, emitted per property. */
const KYERO_CONTACT_FIELDS: readonly PortalSettingField[] = [
  { key: "contact_number", label: "Contact phone", placeholder: "+357 26 000000" },
  { key: "whatsapp_number", label: "WhatsApp number", placeholder: "+357 99 000000" },
  { key: "email", label: "Enquiry e-mail", placeholder: "sales@example.com" },
];
const kyeroEmail = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid e-mail address or leave it blank")
  .optional()
  .default("");
export const kyeroSettingsSchema = z.object({
  contact_number: optionalText(40),
  whatsapp_number: optionalText(40),
  email: kyeroEmail,
});
export const kyeroSettingsFormSchema = z.object({
  contact_number: phoneField("Contact phone"),
  whatsapp_number: phoneField("WhatsApp number"),
  email: kyeroEmail,
});
export type KyeroSettings = z.infer<typeof kyeroSettingsSchema>;

/** No settings to fill in for a portal whose enable switch can never be flipped. */
const EMPTY_SETTINGS = z.object({} as Record<string, z.ZodType<string>>);

const kyeroPortal = (o: {
  id: PortalId;
  name: string;
  audience: string;
  pullCadence: string;
  staleAfterHours: number | null;
  publicationCheck: string;
  docsUrl: string;
  minPhotos?: number;
  minImage?: { width: number; height: number };
  excludedPropertyTypes?: readonly string[];
  excludedTypesNote?: string;
  moderation?: PortalDefinition["moderation"];
}): PortalDefinition => ({
  id: o.id,
  name: o.name,
  dialect: "kyero",
  audience: o.audience,
  spec: "public",
  pendingReason: null,
  requirements: {
    minPhotos: o.minPhotos ?? 1,
    ...(o.minImage ? { minImage: o.minImage } : {}),
    needsCoords: false,
    languages: ["en", "ru"],
    ...(o.excludedPropertyTypes ? { excludedPropertyTypes: o.excludedPropertyTypes } : {}),
    ...(o.excludedTypesNote ? { excludedTypesNote: o.excludedTypesNote } : {}),
  },
  ...(o.moderation ? { moderation: o.moderation } : {}),
  requiredSettings: [],
  settingsFields: KYERO_CONTACT_FIELDS,
  settingsSchema: kyeroSettingsSchema,
  settingsFormSchema: kyeroSettingsFormSchema,
  pullCadence: o.pullCadence,
  staleAfterHours: o.staleAfterHours,
  publicationCheck: o.publicationCheck,
  docsUrl: o.docsUrl,
});

const pendingPortal = (o: {
  id: PortalId;
  name: string;
  dialect: Dialect;
  audience: string;
  pendingReason: string;
  docsUrl: string;
  requirements: PortalDefinition["requirements"];
}): PortalDefinition => ({
  id: o.id,
  name: o.name,
  dialect: o.dialect,
  audience: o.audience,
  spec: "pending",
  pendingReason: o.pendingReason,
  requirements: o.requirements,
  requiredSettings: [],
  settingsFields: [],
  settingsSchema: EMPTY_SETTINGS,
  settingsFormSchema: EMPTY_SETTINGS,
  pullCadence: "unknown until the portal's renderer exists",
  staleAfterHours: null,
  publicationCheck: "",
  docsUrl: o.docsUrl,
});

/**
 * JamesEdition's documented rules (docs.jamesedition.com, help.jamesedition.com,
 * read 2026-10-18): Kyero is accepted; ≥ 2 photos of at least 800×600;
 * residential only ("commercial properties are prohibited"); moderation
 * refuses sale listings under EUR 450,000 / GBP 400,000 / USD 490,000; the
 * Business Account's Listings page shows Pending review, Refused (with the
 * reason) or Published. Land is residential there (property_type "Land").
 */
export const PORTALS: readonly PortalDefinition[] = [
  kyeroPortal({
    id: "jamesedition",
    name: "JamesEdition",
    audience: "Luxury buyers worldwide. Quality review on price and imagery.",
    pullCadence: "three times a day (00:11, 08:11, 16:11 UTC)",
    staleAfterHours: 24,
    publicationCheck:
      "JamesEdition Business Account → Listings shows each advert as Pending review, Refused (hover for the reason) or Published.",
    docsUrl: "https://docs.jamesedition.com/docs/",
    minPhotos: 2,
    minImage: { width: 800, height: 600 },
    excludedPropertyTypes: ["shop", "office", "warehouse", "building", "hotel"],
    excludedTypesNote: "JamesEdition takes residential property only — commercial listings are refused.",
    moderation: { minSalePrice: { EUR: 450_000, GBP: 400_000, USD: 490_000 } },
  }),
  kyeroPortal({
    id: "aplaceinthesun",
    name: "A Place in the Sun",
    audience: "British buyers of holiday and retirement homes.",
    pullCadence: "daily",
    staleAfterHours: 72,
    publicationCheck: "A Place in the Sun's agent account shows which adverts are live.",
    docsUrl: "https://www.aplaceinthesun.com/advertise/website/list-your-properties",
  }),
  kyeroPortal({
    id: "properstar",
    name: "Properstar (ListGlobally)",
    audience: "Syndicated to 100+ portals in 60+ countries.",
    pullCadence: "daily",
    staleAfterHours: 72,
    publicationCheck: "The Properstar / ListGlobally account shows which adverts each partner portal accepted.",
    docsUrl: "https://help.properstar.com/knowledge/our-crms-compatibility",
  }),
  kyeroPortal({
    id: "uk_provider",
    name: "Rightmove, Zoopla & OnTheMarket (via feed provider)",
    audience:
      "British buyers. One feed to a registered provider, which pushes to whichever UK memberships you hold — the CRM cannot pick one of them per listing.",
    pullCadence: "the provider's own schedule",
    staleAfterHours: null,
    publicationCheck: "The feed provider's dashboard, and each UK portal's agent account, show what went live.",
    docsUrl: "https://www.rightmove.co.uk/overseas-property/advertise/estate-agent.html",
  }),
  pendingPortal({
    id: "rera",
    name: "RERA.cy",
    dialect: "rera",
    audience: "Cyprus domestic (a private marketplace).",
    pendingReason:
      "RERA's v2 format is public, but going live needs a RERA account with import permissions and RERA's approval of a test feed, a numeric listing id the CRM does not have yet, and RERA's answer on how a feed with no listings removes them.",
    docsUrl: "https://xml.rera.cy/import-specification.html",
    // RERA v2 requires exact pin_map coordinates on every listing; approximate
    // locations stay out (its show_approximate_location is feed-wide, display only)
    requirements: { minPhotos: 1, minImage: { width: 800, height: 600 }, needsCoords: true, languages: ["en"] },
  }),
  pendingPortal({
    id: "thribee",
    name: "Thribee (Trovit, Mitula, Nestoria, Nuroa)",
    dialect: "trovit",
    audience: "Property search engines; free.",
    pendingReason: "Its renderer is scheduled for a later milestone.",
    docsUrl: "https://help.thribee.com/",
    // the CRM's floor, not the portal's rule; replaced when its renderer arrives
    requirements: { minPhotos: 1, needsCoords: false, languages: ["en"] },
  }),
  pendingPortal({
    id: "bazaraki",
    name: "Bazaraki Pro",
    dialect: "bazaraki",
    audience: "Cyprus domestic.",
    pendingReason:
      "Bazaraki publishes no feed format. Its XML spec, its category and location id lists and its feed checker come with a Pro business account.",
    docsUrl: "https://pro.bazaraki.com/",
    // the CRM's floor, not the portal's rule; replaced when its format arrives
    requirements: { minPhotos: 1, needsCoords: false, languages: ["en"] },
  }),
  pendingPortal({
    id: "prian",
    name: "Prian.ru",
    dialect: "prian",
    audience: "Russian-speaking buyers.",
    pendingReason: "Its format is sent on request from adv@prian.ru.",
    docsUrl: "https://prian.ru/about/",
    // the CRM's floor, not the portal's rule; replaced when its format arrives
    requirements: { minPhotos: 1, needsCoords: false, languages: ["en"] },
  }),
];

export function portalById(id: string): PortalDefinition | null {
  return PORTALS.find((p) => p.id === id) ?? null;
}
