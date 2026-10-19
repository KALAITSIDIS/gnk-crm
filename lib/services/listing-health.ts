import type {
  Worklist,
  WorklistMissingEssentials,
  WorklistOnMarket,
  WorklistProperty,
} from "./quality-worklist";

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

/**
 * The admin dashboard's Listing health, as separate statements (F03).
 *
 * It used to read `published_below_threshold()` — the STORED score against a
 * hard-coded 70 — and print, in green, "all N public listings clear the
 * publish threshold". True, and not what it sounded like: the threshold is
 * compensatory, so a public listing with no photograph at all cleared it on
 * paperwork, and the build and shared-photo warnings never reached the line.
 *
 * Now it is the worklist's own fresh computation (one answer for both
 * screens), stated as four things that are not one another:
 *   1. website essentials — public listings missing a cover, a title, a price;
 *   2. completeness — public listings scoring below the publish threshold;
 *   3. the market — the longest-standing listing and any due a price review;
 *   4. data warnings across the live inventory — build contradictions (by
 *      source) and shared photographs.
 * HEALTHY (green) only when 1 and 2 are clean and no price review is due.
 * Data warnings are reported beside the verdict and never decide it: a build
 * contradiction may be a rebuild being recorded (CRM-05), and a shared
 * exterior is normal for a development (0088).
 */
export interface ListingHealthVerdict {
  healthy: boolean;
  /** public and available: on the website */
  publicCount: number;
  essentials: WorklistMissingEssentials[];
  belowThreshold: WorklistProperty[];
  longest: WorklistOnMarket | null;
  /** listings at PRICE_REVIEW_DAYS or more */
  priceReviewDue: number;
  dataWarnings: {
    /** listings carrying a build contradiction, inherited ones included */
    buildConflicts: number;
    /** the rows those contradictions are fixed on */
    buildConflictSources: number;
    /** listings carrying a photograph another listing also carries */
    sharedPhotos: number;
  };
}

export function listingHealthVerdict(worklist: Worklist): ListingHealthVerdict {
  const priceReviewDue = worklist.onMarket.filter((m) => m.priceReviewDue).length;
  const essentials = worklist.publicMissingEssentials;
  const belowThreshold = worklist.belowThreshold;
  return {
    healthy: essentials.length === 0 && belowThreshold.length === 0 && priceReviewDue === 0,
    publicCount: worklist.publicCount,
    essentials,
    belowThreshold,
    longest: worklist.onMarket[0] ?? null,
    priceReviewDue,
    dataWarnings: {
      buildConflicts: worklist.buildConflicts.length,
      buildConflictSources: worklist.buildConflictGroups.length,
      sharedPhotos: worklist.sharedPhotos.length,
    },
  };
}
