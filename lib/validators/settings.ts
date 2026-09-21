import { z } from "zod";
import { LEAD_ROUTING_MODES } from "@/lib/services/lead-routing";
import {
  FORM_BOUNDS,
  NUDGE_LABELS,
  NUDGE_THRESHOLD_KEYS,
  type NudgeThresholdKey,
} from "@/lib/services/nudge-thresholds";
import { ESCALATION_FORM_BOUNDS } from "@/lib/services/lead-escalation";

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

/**
 * Lead routing (0098). `agents` arrives as every checked box's value; a member
 * ticked twice (a double-rendered form) is one member. Round-robin over nobody
 * is refused here with a sentence — the database would accept it and simply
 * assign nobody, which is not what a person who picked round-robin meant.
 */
export const leadRoutingSchema = z
  .object({
    mode: z.enum(LEAD_ROUTING_MODES, { message: "Choose off or round-robin" }),
    agents: z
      .array(z.guid("Each member must be a profile id"))
      .default([])
      .transform((a) => [...new Set(a)]),
  })
  .refine((d) => d.mode !== "round_robin" || d.agents.length > 0, {
    message: "Pick at least one member for round-robin, or switch it off.",
    path: ["agents"],
  });

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

/**
 * Lead escalation (0107). A checkbox posts "on" or nothing; the recipient and
 * day boxes post every checked value; the time inputs are disabled — and so
 * absent — when hours are off. The bounds are the FORM's, deliberately
 * narrower than the SQL reader's (lib/services/lead-escalation.ts): SQL
 * refuses what would break the sweep, this refuses what would be silly.
 * Switching escalation on with nobody to tell is refused here with a
 * sentence; the sweep would mint rows the worker then cancels one by one as
 * no_recipient, which is not what a person who ticked "on" meant.
 */
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const checkbox = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());
const B = ESCALATION_FORM_BOUNDS;

export const leadEscalationSchema = z
  .object({
    enabled: checkbox,
    after_minutes: z.coerce
      .number({ message: "The wait must be a number of minutes" })
      .int("The wait must be a whole number of minutes")
      .min(B.after_minutes.min, `The wait: minimum ${B.after_minutes.min} minutes`)
      .max(B.after_minutes.max, `The wait: maximum ${B.after_minutes.max} minutes`),
    max_age_hours: z.coerce
      .number({ message: "The age limit must be a number of hours" })
      .int("The age limit must be a whole number of hours")
      .min(B.max_age_hours.min, `The age limit: minimum ${B.max_age_hours.min} hour`)
      .max(B.max_age_hours.max, `The age limit: maximum ${B.max_age_hours.max} hours`),
    recipients: z
      .array(z.guid("Each recipient must be a profile id"))
      .default([])
      .transform((a) => [...new Set(a)]),
    hours_enabled: checkbox,
    days: z
      .array(z.coerce.number().int().min(1).max(7))
      .default([])
      .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
    start: z.string().regex(HHMM, "Working hours need a start time (HH:MM)").optional(),
    end: z.string().regex(HHMM, "Working hours need an end time (HH:MM)").optional(),
  })
  .refine((d) => !d.enabled || d.recipients.length > 0, {
    message: "Tick at least one person to tell, or leave escalation off.",
    path: ["recipients"],
  })
  .refine((d) => !d.hours_enabled || d.days.length > 0, {
    message: "Pick at least one working day, or count clock time instead.",
    path: ["days"],
  })
  .refine((d) => !d.hours_enabled || Boolean(d.start && d.end && d.start < d.end), {
    message: "Working hours must start before they end.",
    path: ["end"],
  });
