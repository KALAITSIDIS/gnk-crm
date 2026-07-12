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

const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

/** Terminal statuses an agent can move a scheduled viewing into (T4.3). */
export const VIEWING_STATUS_ACTIONS = ["completed", "cancelled", "no_show"] as const;
export type ViewingStatusAction = (typeof VIEWING_STATUS_ACTIONS)[number];

const optionalNote = z
  .string()
  .trim()
  .max(2000, "Keep it under 2000 characters")
  .optional()
  .transform((v) => v || undefined);

export const viewingFeedbackSchema = z.object({
  viewing_id: z.guid("Missing viewing"),
  rating: z.coerce.number().int().min(1, "Pick a rating").max(5),
  liked: optionalNote,
  disliked: optionalNote,
  comment: optionalNote,
});

export interface ViewingFeedback {
  rating: number;
  liked?: string;
  disliked?: string;
  comment?: string;
}

export const signSlipSchema = z.object({
  viewing_id: z.guid("Missing viewing"),
  signer_name: z.string().trim().min(2, "Signer name is required").max(200),
  signature_data: z
    .string()
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Please add a signature"),
  lat: z.preprocess(emptyToUndefined, z.coerce.number().min(-90).max(90).optional()),
  lng: z.preprocess(emptyToUndefined, z.coerce.number().min(-180).max(180).optional()),
});

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
