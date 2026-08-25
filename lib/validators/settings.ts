import { z } from "zod";
import {
  FORM_BOUNDS,
  NUDGE_LABELS,
  NUDGE_THRESHOLD_KEYS,
  type NudgeThresholdKey,
} from "@/lib/services/nudge-thresholds";

/** Roles an admin can hand out in Phase 1 (portal roles are later phases). */
export const INVITABLE_ROLES = ["admin", "agent", "listing_manager"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** Deal pipeline types (doc 03 `deal_type` enum) — settings stage editors. */
export const DEAL_TYPES = ["sale", "rental", "antiparoxi", "advisory"] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const orgNameSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(200),
});

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email("Valid email required"),
  full_name: z.string().trim().min(2, "Full name is required").max(200),
  role: z.enum(INVITABLE_ROLES),
});

export const stageNameSchema = z.object({
  name: z.string().trim().min(1, "Stage name is required").max(60),
});

export const areaNameSchema = z.object({
  name: z.string().trim().min(1, "Area name is required").max(80),
});

/**
 * Nudge thresholds (0052). One coerced integer per sweep, bounded by
 * FORM_BOUNDS — the operational range, which is deliberately NARROWER than the
 * SQL guard in `nudge_threshold()`. SQL only has to refuse input that would
 * break a sweep; this has to refuse input that would be silly.
 */
export const nudgeThresholdsSchema = z.object(
  Object.fromEntries(
    NUDGE_THRESHOLD_KEYS.map((k) => [
      k,
      z.coerce
        .number({ message: `${NUDGE_LABELS[k].label} must be a number` })
        .int(`${NUDGE_LABELS[k].label} must be a whole number`)
        .min(FORM_BOUNDS[k].min, `${NUDGE_LABELS[k].label}: minimum ${FORM_BOUNDS[k].min}`)
        .max(FORM_BOUNDS[k].max, `${NUDGE_LABELS[k].label}: maximum ${FORM_BOUNDS[k].max}`),
    ]),
  ) as Record<NudgeThresholdKey, z.ZodNumber>,
);

export const cyprusConfigSchema = z.object({
  key: z.string().trim().min(1).max(60),
  value_json: z.string().min(2, "Config JSON is required"),
  verified_at: z
    .string()
    .optional()
    .transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)),
  // always present (defaulted), so an emptied field CLEARS the stored note —
  // the old `|| undefined` transform made a saved note impossible to remove
  source_note: z.string().trim().max(500).default(""),
});
