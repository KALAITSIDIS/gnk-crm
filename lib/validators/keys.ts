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

/**
 * The longest search the register runs, after trimming — counted as a
 * JavaScript string's length (UTF-16 code units), which is what Chromium's
 * `maxLength` on the search box counts too. A longer one reaching the server (a
 * linked or hand-typed URL, an export request) is REFUSED in these words, never
 * truncated or dropped: either would show a different search's results as if
 * they were this one's. (The box itself cuts a longer PASTE to 100, in plain
 * sight — the browser's defined behaviour for the limit; the cut text is what
 * is searched and shown.) T-keys-search-length
 */
export const KEY_SEARCH_MAX = 100;
export const KEY_SEARCH_TOO_LONG = `That search is too long — ${KEY_SEARCH_MAX} characters at most. Nothing was searched.`;
/** A search of only the characters the search leaves out — the same rule: refused, never the whole register. */
export const KEY_SEARCH_NOTHING = "That search has nothing to search for — commas, brackets and backslashes are left out of a search. Nothing was searched.";

export const keyFiltersSchema = z.object({
  status: z.enum(KEY_SCOPES).catch("all").default("all"),
  q: z
    .string()
    .trim()
    .max(KEY_SEARCH_MAX, KEY_SEARCH_TOO_LONG)
    .optional()
    .transform((v) => v || undefined),
});
export type KeyFilters = z.infer<typeof keyFiltersSchema>;

/** PostgREST `.or()` needs commas/parens escaped out of the search term. */
export function sanitizeSearchTerm(q: string): string {
  return q.replace(/[,()\\]/g, " ").trim();
}
