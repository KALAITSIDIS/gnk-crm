import { daysOnMarket, isPriceReviewDue } from "./listing-health";
import { PUBLISH_THRESHOLD, type QualityScoreItem, type QualityScoreResult } from "./quality-score";

/**
 * Aggregating the quality score's `missing` array across a whole list
 * (BACKLOG: *Quality-score worklist, S*).
 *
 * PURE. No I/O.
 *
 * `computeQualityScore` already returns, per property, exactly which criteria
 * were not met — and until now every one of those arrays was thrown away after
 * drawing a single ring on a single detail page. The information to answer
 * "what one thing should I go fix?" was being computed and discarded.
 *
 * SORTED BY POINTS RECOVERABLE, not by count. Both are shown, but the order has
 * to answer the question the desk is actually asking, which is not "what is
 * most common" but "where does an afternoon buy the most". Twelve listings
 * missing a title deed status (10 points each = 120) outrank nineteen missing a
 * cover photo (5 each = 95), and sorting by count alone would put them the
 * wrong way round.
 */

export interface WorklistProperty {
  id: string;
  reference: string;
  title: string | null;
  score: number;
}

export interface WorklistCategory {
  key: string;
  label: string;
  /** points ONE property recovers by fixing this */
  points: number;
  /** how many properties are missing it */
  count: number;
  /** count × points — the ordering, and the honest measure of the win */
  recoverable: number;
  /** which ones, worst score first: the least complete are the best use of a sitting */
  properties: WorklistProperty[];
}

/** 0088: a listing carrying a photograph that another listing also carries. */
export interface WorklistSharedPhoto {
  property: WorklistProperty;
  /** the other listings, by reference */
  withReferences: string[];
}

/** A listing whose build declaration contradicts itself (audit CRM-05). */
export interface WorklistBuildConflict {
  property: WorklistProperty;
  label: string;
}

/** A public, available listing and how long it has been so (audit 2026-09-15, LST-03). */
export interface WorklistOnMarket {
  property: WorklistProperty;
  /** whole days since `published_at` */
  days: number;
  /** PRICE_REVIEW_DAYS or more on the market — a nudge to look at the price, never a block */
  priceReviewDue: boolean;
}

export interface Worklist {
  categories: WorklistCategory[];
  /**
   * Public, available listings whose FRESH score is below PUBLISH_THRESHOLD
   * (audit 2026-09-15, LST-03). The feed deliberately does not re-check the
   * score — an admin override is an audited decision and a decayed score
   * must not silently unpublish — so the drift has to be SEEN instead.
   * `published_below_threshold()` (0066) reads the stored column for the
   * admin dashboard; this reads the live computation. Worst first.
   */
  belowThreshold: WorklistProperty[];
  /** every public, available listing with a publish stamp, longest on the market first */
  onMarket: WorklistOnMarket[];
  /** warnings, not points: a build year that contradicts the status or a pending delivery (CRM-05) */
  buildConflicts: WorklistBuildConflict[];
  /** warnings, not points: listings whose photographs appear elsewhere (0088) */
  sharedPhotos: WorklistSharedPhoto[];
  /** properties considered — the denominator behind every count */
  total: number;
  /** how many scored full marks and appear in no category at all */
  complete: number;
  /** total points recoverable across the whole list */
  recoverable: number;
  /** mean score, or null when there is nothing to average */
  averageScore: number | null;
}

export interface ScoredProperty {
  property: WorklistProperty;
  /** the market state the row is in — the feed's predicate reads the same two columns */
  listing: { visibility: string; status: string; publishedAt: string | null };
  result: QualityScoreResult;
}

/** The public feed's predicate (0066): what a buyer can currently see. */
function isOnMarket(listing: ScoredProperty["listing"]): boolean {
  return listing.visibility === "public" && listing.status === "available";
}

/**
 * Where a criterion is fixed. The tabs are Radix state with no href, so a
 * category cannot deep-link — naming the tab is the next best thing, and it is
 * what turns "12 missing deed status" into an instruction.
 */
const FIX_LOCATION: Record<string, string> = {
  cover: "Media",
  photos6: "Media",
  title_en: "Marketing",
  description_en: "Marketing",
  price: "Details",
  // a container's gaps are fixed on its units page, not on a tab
  units: "Units page",
  area: "Details",
  rooms: "Details",
  planning: "Legal",
  coords: "Details",
  deed: "Legal",
  permit: "Legal",
  mandate: "Mandate & Keys",
  agent: "Overview",
  party: "Overview",
};

export function fixLocation(key: string): string | null {
  return FIX_LOCATION[key] ?? null;
}

export function buildWorklist(scored: ScoredProperty[], now: Date = new Date()): Worklist {
  const byKey = new Map<string, WorklistCategory>();

  for (const { property, result } of scored) {
    for (const item of result.missing) {
      const existing = byKey.get(item.key);
      if (existing) {
        existing.count += 1;
        existing.recoverable += item.points;
        existing.properties.push(property);
      } else {
        byKey.set(item.key, {
          key: item.key,
          label: item.label,
          points: item.points,
          count: 1,
          recoverable: item.points,
          properties: [property],
        });
      }
    }
  }

  const categories = [...byKey.values()].sort(
    // recoverable first, then count, then label — a stable order matters
    // because this list is read top-down as a plan for the afternoon
    (a, b) => b.recoverable - a.recoverable || b.count - a.count || a.label.localeCompare(b.label),
  );

  for (const c of categories) {
    // worst first: the least complete listing gains most from attention, and a
    // stable tiebreak keeps the order from shuffling between renders
    c.properties.sort((x, y) => x.score - y.score || x.reference.localeCompare(y.reference));
  }

  const total = scored.length;
  const complete = scored.filter((s) => s.result.missing.length === 0).length;

  const sharedPhotos: WorklistSharedPhoto[] = scored
    .flatMap(({ property, result }) =>
      result.warnings
        .filter((w) => w.key === "shared_photo")
        .map((w) => ({ property, withReferences: w.references })),
    )
    .sort((a, b) => a.property.reference.localeCompare(b.property.reference));

  const buildConflicts: WorklistBuildConflict[] = scored
    .flatMap(({ property, result }) =>
      result.warnings
        .filter((w) => w.key === "build_conflict")
        .map((w) => ({ property, label: w.label })),
    )
    .sort((a, b) => a.property.reference.localeCompare(b.property.reference));
  const live = scored.filter((s) => isOnMarket(s.listing));
  const belowThreshold = live
    .filter((s) => s.result.score < PUBLISH_THRESHOLD)
    .map((s) => s.property)
    .sort((a, b) => a.score - b.score || a.reference.localeCompare(b.reference));
  const onMarket: WorklistOnMarket[] = live
    .filter((s) => s.listing.publishedAt !== null)
    .map((s) => {
      const days = daysOnMarket(s.listing.publishedAt as string, now);
      return { property: s.property, days, priceReviewDue: isPriceReviewDue(days) };
    })
    .sort((a, b) => b.days - a.days || a.property.reference.localeCompare(b.property.reference));
  return {
    categories,
    belowThreshold,
    onMarket,
    sharedPhotos,
    buildConflicts,
    total,
    complete,
    recoverable: categories.reduce((sum, c) => sum + c.recoverable, 0),
    averageScore:
      total === 0
        ? null
        : Math.round(scored.reduce((sum, s) => sum + s.result.score, 0) / total),
  };
}

/**
 * The label a criterion carries can DEPEND ON THE PROPERTY — `area` reads
 * "Plot area set" for land and "Covered area set" for everything else, and
 * land swaps `rooms` for `planning` entirely. When a mixed list disagrees, the
 * first one in wins, which would silently label a mostly-apartment portfolio's
 * area row after whichever property happened to sort first.
 *
 * Exported so the test can pin it: the fix is to keep the KEY as identity and
 * treat the label as a display detail, which `buildWorklist` already does.
 */
export function labelFor(items: QualityScoreItem[], key: string): string | null {
  return items.find((i) => i.key === key)?.label ?? null;
}
