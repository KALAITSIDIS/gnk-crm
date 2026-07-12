import { z } from "zod";

export const VIEWING_STATUSES = ["scheduled", "completed", "cancelled", "no_show"] as const;
export type ViewingStatus = (typeof VIEWING_STATUSES)[number];

/** Preset durations offered in the create dialog (minutes). */
export const VIEWING_DURATIONS = [15, 30, 45, 60, 90, 120] as const;

// z.guid(), not z.uuid(): Postgres accepts any 32-hex uuid but Zod 4's uuid()
// enforces RFC-4122 variant bits and rejects seeded fixture ids (see T3.2).
const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v && z.guid().safeParse(v).success ? v : undefined));

export const createViewingSchema = z.object({
  property_id: z.guid("Select a property"),
  contact_id: z.guid("Select a contact"),
  agent_id: z.guid("Select an agent"),
  deal_id: optionalUuid,
  // naive Cyprus wall-clock from a datetime-local input; converted in the action
  scheduled_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a date and time"),
  duration_min: z.coerce
    .number()
    .int()
    .min(5, "Too short")
    .max(480, "Too long"),
});
