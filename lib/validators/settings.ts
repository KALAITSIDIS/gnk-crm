import { z } from "zod";

/** Roles an admin can hand out in Phase 1 (portal roles are later phases). */
export const INVITABLE_ROLES = ["admin", "agent", "listing_manager"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

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

export const cyprusConfigSchema = z.object({
  key: z.string().trim().min(1).max(60),
  value_json: z.string().min(2, "Config JSON is required"),
  verified_at: z
    .string()
    .optional()
    .transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)),
  source_note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || undefined),
});
