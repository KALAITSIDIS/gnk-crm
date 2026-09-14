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

export interface PortalSettingField {
  key: string;
  label: string;
  placeholder?: string;
}

export interface PortalDefinition {
  id: PortalId;
  name: string;
  dialect: Dialect;
  /** one line for the settings page */
  audience: string;
  /** `pending`: the portal's format is not public; no renderer, cannot be enabled */
  spec: "public" | "pending";
  requirements: {
    minPhotos: number;
    needsCoords: boolean;
    /** which of the CRM's three languages the dialect can carry */
    languages: readonly ("en" | "el" | "ru")[];
  };
  /** setting keys without which the enable switch refuses */
  requiredSettings: readonly string[];
  settingsFields: readonly PortalSettingField[];
  settingsSchema: z.ZodType<Record<string, string>>;
  /** words for the desk, not a schedule the CRM runs */
  pullCadence: string;
  docsUrl: string;
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
  email: optionalText(200),
});

const kyeroPortal = (
  id: PortalId,
  name: string,
  audience: string,
  pullCadence: string,
  docsUrl: string,
  minPhotos = 1,
): PortalDefinition => ({
  id,
  name,
  dialect: "kyero",
  audience,
  spec: "public",
  requirements: { minPhotos, needsCoords: false, languages: ["en", "ru"] },
  requiredSettings: [],
  settingsFields: KYERO_CONTACT_FIELDS,
  settingsSchema: kyeroSettingsSchema,
  pullCadence,
  docsUrl,
});

const pendingPortal = (
  id: PortalId,
  name: string,
  dialect: Dialect,
  audience: string,
  docsUrl: string,
): PortalDefinition => ({
  id,
  name,
  dialect,
  audience,
  spec: "pending",
  requirements: { minPhotos: 1, needsCoords: false, languages: ["en"] },
  requiredSettings: [],
  settingsFields: [],
  settingsSchema: z.object({}),
  pullCadence: "unknown until the portal's specification arrives",
  docsUrl,
});

export const PORTALS: readonly PortalDefinition[] = [
  kyeroPortal(
    "jamesedition",
    "JamesEdition",
    "Luxury buyers worldwide. Quality review on price and imagery; at least two photos.",
    "three times a day (00:11, 08:11, 16:11 UTC)",
    "https://docs.jamesedition.com/docs/",
    2,
  ),
  kyeroPortal(
    "aplaceinthesun",
    "A Place in the Sun",
    "British buyers of holiday and retirement homes.",
    "daily",
    "https://www.aplaceinthesun.com/advertise/website/list-your-properties",
  ),
  kyeroPortal(
    "properstar",
    "Properstar (ListGlobally)",
    "Syndicated to 100+ portals in 60+ countries.",
    "daily",
    "https://help.properstar.com/knowledge/our-crms-compatibility",
  ),
  kyeroPortal(
    "uk_provider",
    "Rightmove, Zoopla & OnTheMarket (via feed provider)",
    "British buyers. One feed to a registered provider, which pushes to whichever UK memberships you hold — the CRM cannot pick one of them per listing.",
    "the provider's own schedule",
    "https://www.rightmove.co.uk/overseas-property/advertise/estate-agent.html",
  ),
  // Milestone 2 turns these two into `spec: "public"` with their renderers.
  pendingPortal("rera", "RERA.cy", "rera", "Cyprus domestic (a private marketplace).", "https://xml.rera.cy/import-specification.html"),
  pendingPortal("thribee", "Thribee (Trovit, Mitula, Nestoria, Nuroa)", "trovit", "Property search engines; free.", "https://help.thribee.com/"),
  pendingPortal("bazaraki", "Bazaraki Pro", "bazaraki", "Cyprus domestic. XML spec is given to Pro accounts only.", "https://pro.bazaraki.com/"),
  pendingPortal("prian", "Prian.ru", "prian", "Russian-speaking buyers. Format on request from adv@prian.ru.", "https://prian.ru/about/"),
];

export function portalById(id: string): PortalDefinition | null {
  return PORTALS.find((p) => p.id === id) ?? null;
}
