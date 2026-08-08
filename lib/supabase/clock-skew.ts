/**
 * PostgREST refuses an access token whose `iat` is ahead of its clock, and the
 * user gets the T5.7 boundary ("Couldn't load properties") on every route until
 * the token is replaced. Seen on production 2026-07-19, 2026-07-21 and
 * 2026-08-03, and locally when the Docker VM clock drifted while the host clock
 * was fine.
 *
 * **PostgREST already tolerates about 30 seconds of this.** Measured against a
 * real instance 2026-08-08: a hand-signed token is accepted at `iat` +0s, +5s,
 * +10s and +20s, and rejected from +31s with `401` / `PGRST303`. That number is
 * why there is no retry here — anything actually rejected is more than half a
 * minute ahead, so a retry would have to sleep 30+ seconds to land past the
 * boundary, which costs the user more than the error does. See DECISIONS
 * 2026-08-08 (`T-jwt-skew`) for the retry that was written and deleted.
 *
 * What is left is to stop lying to the user about it. The boundary's "Try again"
 * calls `reset()`, which re-runs the segment with the same doomed token and
 * fails identically; the only thing that helps is signing in again to have
 * GoTrue mint a fresh one.
 */

/** Where `unwrapRows` sends a request whose token PostgREST will not accept. */
export const SESSION_CLOCK_PATH = "/session-clock";

/**
 * PostgREST's future-dated-`iat` rejection.
 *
 * Matched on the code rather than the message, because the code is stable and
 * was confirmed directly (`PGRST303`) — the same shape as `isRangeBeyondEnd`
 * for `PGRST103`. Note this must be decided SERVER-side: Next redacts
 * server-component error messages before `app/(app)/error.tsx` receives them,
 * so the browser sees a digest and could not branch on this at all.
 */
export function isClockSkewRejection(
  error: { code?: string } | null | undefined,
): boolean {
  return error?.code === "PGRST303";
}
