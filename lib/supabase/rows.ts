/**
 * The rows of a list answer — a list read, or the rows a write returned with
 * `.select()` — or a thrown, labelled failure. `[]` is the only "none".
 *
 * For code that CATCHES its failures and reports them its own way (an action's
 * steps, a route's own failure path). `unwrapRows` is for a server component:
 * it routes a clock-skewed token with `redirect()`, which a surrounding
 * try/catch would swallow.
 *
 * An answer with no rows array is not "none" (T-null-answer-guard): postgrest-js
 * reports an OK answer with an empty body, a 404 with an empty body (as 204)
 * and a `null` body even under a 500 as `data: null, error: null`, and a 500
 * whose body is `0` as a FALSY error that `if (error)` lets through (measured,
 * 2.110.2). Read as "none", a hollow answer once let a GDPR erasure find no
 * retention basis and destroy the KYC documents the law requires keeping
 * (T-erasure-null-answers).
 */
export function rowsOf<T>(res: { data: T[] | null; error: unknown; status?: number }, label: string): T[] {
  if (res.error) {
    const message = (res.error as { message?: unknown }).message;
    // a bodiless failure (an empty 500, 503, 504) carries an EMPTY message
    throw new Error(`${label}: ${typeof message === "string" && message ? message : `HTTP ${res.status ?? "error"}`}`);
  }
  if (!Array.isArray(res.data)) throw new Error(`${label}: the answer held no rows (HTTP ${res.status ?? "?"})`);
  return res.data;
}
