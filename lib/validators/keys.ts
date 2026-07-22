import { z } from "zod";

export const KEY_STATUSES = ["in_office", "checked_out", "with_owner", "lost"] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

// z.guid(), not z.uuid() — Zod 4 uuid() rejects seeded fixture ids (T3.2)
const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v && z.guid().safeParse(v).success ? v : undefined));

const optionalNote = z
  .string()
  .trim()
  .max(1000, "Keep it under 1000 characters")
  .optional()
  .transform((v) => v || undefined);

const optionalHolderName = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => v || undefined);

export const registerKeySchema = z.object({
  property_id: z.guid("Select a property"),
  key_code: z.string().trim().min(1, "Key code is required").max(50),
  description: optionalNote,
});

export const updateKeySchema = z.object({
  key_id: z.guid("Missing key"),
  key_code: z.string().trim().min(1, "Key code is required").max(50),
  description: optionalNote,
});

export const checkoutKeySchema = z
  .object({
    key_id: z.guid("Missing key"),
    holder_profile_id: optionalUuid,
    holder_name: optionalHolderName,
    note: optionalNote,
  })
  .refine((d) => d.holder_profile_id || d.holder_name, {
    message: "Pick a staff member or type the holder's name",
    path: ["holder_name"],
  });

export const returnKeySchema = z.object({
  key_id: z.guid("Missing key"),
  note: optionalNote,
});

export const transferKeySchema = z.object({
  key_id: z.guid("Missing key"),
  holder_name: optionalHolderName,
  note: optionalNote,
});

export const markLostKeySchema = z.object({
  key_id: z.guid("Missing key"),
  note: optionalNote,
});

/**
 * /keys list filters (audit 2026-07-22, PERF-2). These moved from client
 * useState into the URL when the register was paginated: a filter that only
 * searches the rows already on screen silently stops finding keys once the
 * register is longer than one page.
 */
export const KEY_SCOPES = ["all", ...KEY_STATUSES] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

export const keyFiltersSchema = z.object({
  status: z.enum(KEY_SCOPES).catch("all").default("all"),
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
});
export type KeyFilters = z.infer<typeof keyFiltersSchema>;

/** PostgREST `.or()` needs commas/parens escaped out of the search term. */
export function sanitizeSearchTerm(q: string): string {
  return q.replace(/[,()\\]/g, " ").trim();
}
