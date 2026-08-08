import type { PostgrestError } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { isClockSkewRejection, SESSION_CLOCK_PATH } from "@/lib/supabase/clock-skew";

/**
 * Unwrap a PostgREST list response inside a server component. A failed query
 * throws so the segment's error boundary (app/(app)/error.tsx, T5.7) renders
 * and Sentry hears about it — silently painting `data: null` as zeros would
 * make a broken dashboard indistinguishable from an empty one (doc 05 error
 * states; dashboard audit 2026-07-16).
 *
 * One error is routed instead of thrown: a token PostgREST will not accept
 * (`PGRST303`) fails EVERY query on EVERY route, so the boundary's "Try again"
 * cannot clear it — see lib/supabase/clock-skew.ts. This is the chokepoint for
 * all 47 call sites, which is why the check lives here rather than per page.
 */
export function unwrapRows<T>(
  res: { data: T[] | null; error: PostgrestError | null },
  label: string,
): T[] {
  if (res.error) {
    // `redirect` throws NEXT_REDIRECT, so this returns nothing and must come
    // before the generic throw. No call site wraps unwrapRows in try/catch —
    // one that did would swallow the redirect and show the boundary instead.
    if (isClockSkewRejection(res.error)) redirect(SESSION_CLOCK_PATH);
    throw new Error(`Query failed (${label}): ${res.error.message}`);
  }
  return res.data ?? [];
}
