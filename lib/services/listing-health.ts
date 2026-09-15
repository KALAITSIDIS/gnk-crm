/**
 * How long a listing has been on the market, and when that alone is a
 * reason to look at it (audit 2026-09-15, LST-03).
 *
 * Two surfaces read these — the listing worklist and the admin dashboard —
 * and they must agree on the number, so the arithmetic lives here and is
 * pinned by listing-health.test.ts. The stamp is `published_at` (0073),
 * written on every transition into public and never cleared on unpublish.
 *
 * WHOLE DAYS, ROUNDED DOWN, UTC. This is a "how long has this sat" figure,
 * not a due date: the Cyprus-day rule that governs `due_at` (HANDOFF §4)
 * does not apply, and a listing published this morning reads 0, not 1.
 */

const DAY_MS = 86_400_000;

/** A public listing this old with no price change is due a look — a nudge, never a block. */
export const PRICE_REVIEW_DAYS = 90;

export function daysOnMarket(publishedAt: string, now: Date): number {
  const elapsed = now.getTime() - new Date(publishedAt).getTime();
  // a stamp ahead of the reader's clock is skew, not a listing from the future
  return Math.max(0, Math.floor(elapsed / DAY_MS));
}

export function isPriceReviewDue(days: number): boolean {
  return days >= PRICE_REVIEW_DAYS;
}
