/**
 * Query-parameter parsing for the public listing feed (C3, migration 0066).
 *
 * Pure and separately tested BECAUSE THE FIRST VERSION WAS WRONG in a way no
 * type checker could catch. It read:
 *
 *   const n = Number(raw);
 *   if (!Number.isFinite(n) || n < 0) return fallback;
 *
 * `Number(null)` is `0`, not `NaN` — finite and non-negative — so a request
 * with NO `limit` parameter got a limit of ZERO. `GET /api/public/listings?org=gnk`,
 * the plainest call a marketing site can make, answered `200` with an empty
 * list and no error. Caught by actually calling the endpoint; it would
 * otherwise have shipped as "the feed is empty" with nothing to point at.
 */

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;

export interface FeedParams {
  limit: number;
  offset: number;
}

/**
 * An ABSENT parameter takes the fallback; a present-but-nonsense one also takes
 * the fallback rather than erroring, because a feed that 400s on a stray query
 * string is a feed that goes dark for a reason nobody can see from the browser.
 */
function intParam(raw: string | null | undefined, fallback: number, max: number): number {
  if (raw === null || raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function parseFeedParams(params: {
  get(name: string): string | null;
}): FeedParams {
  return {
    limit: intParam(params.get("limit"), DEFAULT_LIMIT, MAX_LIMIT),
    offset: intParam(params.get("offset"), 0, Number.MAX_SAFE_INTEGER),
  };
}
