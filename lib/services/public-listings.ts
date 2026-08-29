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

/**
 * FEED-1 (0073): `public_listings()` returns rendition paths RELATIVE to the
 * public `media` bucket, because SQL does not know the project URL. The route
 * absolutizes them here so a marketing site gets URLs it can put straight
 * into <img src> without knowing the Supabase host.
 *
 * Pure and separately tested for the same reason parseFeedParams is: this is
 * string plumbing on a public surface, and the failure mode (a double slash,
 * a missing bucket segment) renders as broken images on somebody else's site
 * with nothing in our logs.
 */
export interface FeedImage {
  thumb: string | null;
  card: string | null;
  full: string | null;
  alt: unknown;
  watermarked: boolean;
}

export function publicMediaUrl(supabaseUrl: string, path: string | null): string | null {
  if (!path) return null;
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/media/${path.replace(/^\/+/, "")}`;
}

/** Maps every listing's `images` paths to absolute URLs, leaving all other
 *  fields untouched. Tolerates rows without an images key (a feed served by a
 *  pre-0073 database mid-rollout) by passing them through unchanged. */
export function absolutizeListingImages<T extends { images?: unknown }>(
  listings: T[],
  supabaseUrl: string,
): T[] {
  return listings.map((row) => {
    if (!Array.isArray(row.images)) return row;
    return {
      ...row,
      images: (row.images as FeedImage[]).map((img) => ({
        ...img,
        thumb: publicMediaUrl(supabaseUrl, img.thumb),
        card: publicMediaUrl(supabaseUrl, img.card),
        full: publicMediaUrl(supabaseUrl, img.full),
      })),
    };
  });
}
