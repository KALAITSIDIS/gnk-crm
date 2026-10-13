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
 * every list read that uses it, which is why the check lives here rather than
 * per page.
 *
 * A list read answers with an ARRAY — `[]` when nothing matched. An answer with
 * no array is not "nothing matched" (T-null-answer-guard): postgrest-js reports
 * an OK answer with an empty body, a 404 with an empty body (as 204) and a body
 * of `null` — even under a 500 — as `data: null, error: null` (measured,
 * 2.110.2). This returned [] for all of them: "No keys registered", a "none"
 * mandate badge, a units page short of its units, where the read had failed.
 */
export function unwrapRows<T>(
  res: { data: T[] | null; error: PostgrestError | null; status?: number },
  label: string,
): T[] {
  if (res.error) {
    // `redirect` throws NEXT_REDIRECT, so this returns nothing and must come
    // before the generic throw. No call site wraps unwrapRows in try/catch —
    // one that did would swallow the redirect and show the boundary instead.
    if (isClockSkewRejection(res.error)) redirect(SESSION_CLOCK_PATH);
    // a bodiless failure (an empty 500, 503, 504) carries an EMPTY message
    throw new Error(`Query failed (${label}): ${res.error.message || `HTTP ${res.status ?? "error"}`}`);
  }
  if (!Array.isArray(res.data)) {
    throw new Error(`Query failed (${label}): the answer held no rows (HTTP ${res.status ?? "?"})`);
  }
  return res.data;
}

/**
 * The count's twin of `unwrapRows`, for a `{ count: "exact" }` read (usually
 * `head: true`). A failed count throws to the same boundary — `count ?? 0`
 * would paint a failure as a genuine zero ("0 registered" over a register that
 * has keys). A response with NO count fails too: postgrest-js answers a HEAD
 * request's 404 with `status: 204, error: null, count: null` (measured
 * 2026-10-12), and parses an uncounted `Content-Range: 0-24/*` as NaN — so an
 * error check alone would still read those as zero, or as "NaN registered".
 *
 * A HEAD failure has no body, so its error message is empty and carries no
 * PostgREST code — the status names it instead, and the clock-skew route can
 * fire only for a counted GET.
 */
export function unwrapCount(
  res: { count: number | null; error: PostgrestError | null; status?: number },
  label: string,
): number {
  if (res.error) {
    if (isClockSkewRejection(res.error)) redirect(SESSION_CLOCK_PATH);
    throw new Error(`Query failed (${label}): ${res.error.message || `HTTP ${res.status ?? "error"}`}`);
  }
  if (typeof res.count !== "number" || !Number.isFinite(res.count)) {
    throw new Error(`Query failed (${label}): no count returned (HTTP ${res.status ?? "?"})`);
  }
  return res.count;
}
