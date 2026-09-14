import { z } from "zod";

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
   * or its renderer is scheduled for a later milestone (RERA, Thribee).
   */
  readonly spec: "public" | "pending";
  readonly requirements: {
    readonly minPhotos: number;
    readonly needsCoords: boolean;
    /** which of the CRM's three languages the dialect can carry */
    readonly languages: readonly ("en" | "el" | "ru")[];
  };
  /** setting keys without which the enable switch refuses */
  readonly requiredSettings: readonly string[];
  readonly settingsFields: readonly PortalSettingField[];
  readonly settingsSchema: z.ZodObject<Record<string, z.ZodType<string>>>;
  /** words for the desk, not a schedule the CRM runs */
  readonly pullCadence: string;
  readonly docsUrl: string;
}

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

/** Kyero v3.7–3.9 contact nodes, emitted per property. */
const KYERO_CONTACT_FIELDS: readonly PortalSettingField[] = [
  { key: "contact_number", label: "Contact phone", placeholder: "+357 26 000000" },
  { key: "whatsapp_number", label: "WhatsApp number", placeholder: "+357 99 000000" },
  { key: "email", label: "Enquiry e-mail", placeholder: "sales@example.com" },
];
const kyeroSettingsSchema = z.object({
  contact_number: optionalText(40),
  whatsapp_number: optionalText(40),
  email: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid e-mail address or leave it blank")
    .optional()
    .default(""),
});

/** No settings to fill in for a portal whose enable switch can never be flipped. */
const EMPTY_SETTINGS = z.object({} as Record<string, z.ZodType<string>>);

const kyeroPortal = (o: {
  id: PortalId;
  name: string;
  audience: string;
  pullCadence: string;
  docsUrl: string;
  minPhotos?: number;
}): PortalDefinition => ({
  id: o.id,
  name: o.name,
  dialect: "kyero",
  audience: o.audience,
  spec: "public",
  requirements: { minPhotos: o.minPhotos ?? 1, needsCoords: false, languages: ["en", "ru"] },
  requiredSettings: [],
  settingsFields: KYERO_CONTACT_FIELDS,
  settingsSchema: kyeroSettingsSchema,
  pullCadence: o.pullCadence,
  docsUrl: o.docsUrl,
});

const pendingPortal = (o: {
  id: PortalId;
  name: string;
  dialect: Dialect;
  audience: string;
  docsUrl: string;
  requirements: PortalDefinition["requirements"];
}): PortalDefinition => ({
  id: o.id,
  name: o.name,
  dialect: o.dialect,
  audience: o.audience,
  spec: "pending",
  requirements: o.requirements,
  requiredSettings: [],
  settingsFields: [],
  settingsSchema: EMPTY_SETTINGS,
  pullCadence: "unknown until the portal's renderer exists",
  docsUrl: o.docsUrl,
});

export const PORTALS: readonly PortalDefinition[] = [
  kyeroPortal({
    id: "jamesedition",
    name: "JamesEdition",
    audience: "Luxury buyers worldwide. Quality review on price and imagery.",
    pullCadence: "three times a day (00:11, 08:11, 16:11 UTC)",
    docsUrl: "https://docs.jamesedition.com/docs/",
    minPhotos: 2,
  }),
  kyeroPortal({
    id: "aplaceinthesun",
    name: "A Place in the Sun",
    audience: "British buyers of holiday and retirement homes.",
    pullCadence: "daily",
    docsUrl: "https://www.aplaceinthesun.com/advertise/website/list-your-properties",
  }),
  kyeroPortal({
    id: "properstar",
    name: "Properstar (ListGlobally)",
    audience: "Syndicated to 100+ portals in 60+ countries.",
    pullCadence: "daily",
    docsUrl: "https://help.properstar.com/knowledge/our-crms-compatibility",
  }),
  kyeroPortal({
    id: "uk_provider",
    name: "Rightmove, Zoopla & OnTheMarket (via feed provider)",
    audience:
      "British buyers. One feed to a registered provider, which pushes to whichever UK memberships you hold — the CRM cannot pick one of them per listing.",
    pullCadence: "the provider's own schedule",
    docsUrl: "https://www.rightmove.co.uk/overseas-property/advertise/estate-agent.html",
  }),
  // Milestone 2 turns these two into `spec: "public"` with their renderers.
  pendingPortal({
    id: "rera",
    name: "RERA.cy",
    dialect: "rera",
    audience: "Cyprus domestic (a private marketplace).",
    docsUrl: "https://xml.rera.cy/import-specification.html",
    // RERA requires pin_map coordinates and takes English, translating itself
    requirements: { minPhotos: 1, needsCoords: true, languages: ["en"] },
  }),
  pendingPortal({
    id: "thribee",
    name: "Thribee (Trovit, Mitula, Nestoria, Nuroa)",
    dialect: "trovit",
    audience: "Property search engines; free.",
    docsUrl: "https://help.thribee.com/",
    // the CRM's floor, not the portal's rule; replaced when its renderer arrives
    requirements: { minPhotos: 1, needsCoords: false, languages: ["en"] },
  }),
  // Format arrives from the portal; see docsUrl.
  pendingPortal({
    id: "bazaraki",
    name: "Bazaraki Pro",
    dialect: "bazaraki",
    audience: "Cyprus domestic. XML spec is given to Pro accounts only.",
    docsUrl: "https://pro.bazaraki.com/",
    // the CRM's floor, not the portal's rule; replaced when its format arrives
    requirements: { minPhotos: 1, needsCoords: false, languages: ["en"] },
  }),
  pendingPortal({
    id: "prian",
    name: "Prian.ru",
    dialect: "prian",
    audience: "Russian-speaking buyers. Format on request from adv@prian.ru.",
    docsUrl: "https://prian.ru/about/",
    // the CRM's floor, not the portal's rule; replaced when its format arrives
    requirements: { minPhotos: 1, needsCoords: false, languages: ["en"] },
  }),
];

export function portalById(id: string): PortalDefinition | null {
  return PORTALS.find((p) => p.id === id) ?? null;
}
