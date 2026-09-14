import { z } from "zod";
import { PORTAL_IDS, portalById } from "@/lib/services/portals/registry";

export const portalIdSchema = z.enum(PORTAL_IDS);

export type PortalSettingsForm =
  | { success: true; data: { portal: (typeof PORTAL_IDS)[number]; settings: Record<string, string> } }
  | { success: false; error: string };

/** The settings form carries `portal` plus that portal's own fields; each portal's zod schema decides. */
export function portalSettingsForm(raw: Record<string, unknown>): PortalSettingsForm {
  const id = portalIdSchema.safeParse(raw.portal);
  if (!id.success) return { success: false, error: "Unknown portal." };
  const def = portalById(id.data)!;
  const parsed = def.settingsSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid settings." };
  return { success: true, data: { portal: id.data, settings: parsed.data } };
}
