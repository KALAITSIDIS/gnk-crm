import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Unwrap a PostgREST list response inside a server component. A failed query
 * throws so the segment's error boundary (app/(app)/error.tsx, T5.7) renders
 * and Sentry hears about it — silently painting `data: null` as zeros would
 * make a broken dashboard indistinguishable from an empty one (doc 05 error
 * states; dashboard audit 2026-07-16).
 */
export function unwrapRows<T>(
  res: { data: T[] | null; error: PostgrestError | null },
  label: string,
): T[] {
  if (res.error) throw new Error(`Query failed (${label}): ${res.error.message}`);
  return res.data ?? [];
}
