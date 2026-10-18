import { z } from "zod";
import { PORTAL_IDS, portalById } from "@/lib/services/portals/registry";

export const portalIdSchema = z.enum(PORTAL_IDS);

export type PortalSettingsForm =
  | { success: true; data: { portal: (typeof PORTAL_IDS)[number]; settings: Record<string, string> } }
  | { success: false; error: string };

/**
 * The settings form carries `portal` plus that portal's own fields; each
 * portal's FORM schema decides — stricter than the one the feed parses stored
 * settings with, so a new typo is refused at the desk while a stored one
 * cannot take a feed down (registry.ts settingsFormSchema).
 */
export function portalSettingsForm(raw: Record<string, unknown>): PortalSettingsForm {
  const id = portalIdSchema.safeParse(raw.portal);
  if (!id.success) return { success: false, error: "Unknown portal." };
  const def = portalById(id.data)!;
  const parsed = def.settingsFormSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid settings." };
  return { success: true, data: { portal: id.data, settings: parsed.data } };
}
