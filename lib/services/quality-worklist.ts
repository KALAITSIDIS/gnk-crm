import { daysOnMarket, isPriceReviewDue } from "./listing-health";
import { PUBLISH_THRESHOLD, type QualityScoreItem, type QualityScoreResult } from "./quality-score";
import { PROPERTY_TAB_LABELS, propertyTabHref, type PropertyTab } from "./property-tabs";

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
 *
 * F03: the same computation answers the admin dashboard's Listing health
 * (lib/services/listing-health.ts `listingHealthVerdict`), so the dashboard
 * and this page cannot give two answers about the same listing.
 */

export interface WorklistProperty {
  id: string;
  reference: string;
  title: string | null;
  score: number;
  /** a project or phase — its prices are fixed on its Units page, not a tab */
  container?: boolean;
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
  /**
   * F03: where the contradiction actually lives, when it is not this row's
   * own — a unit (or phase) still inheriting its construction status or
   * delivery date (0035 `inherited_fields`) from a parent that declares the
   * same contradiction. The topmost such parent; null for a row's own.
   */
  inheritedFrom: { id: string; reference: string } | null;
}

/**
 * F03: one contradiction as the desk fixes it — on its source row, then
 * synced down from that row's Units page — with the rows that carry it only
 * by inheritance. One wrong project used to read as one row for itself and
 * one more per unit, each telling the reader to fix it on that unit.
 */
export interface WorklistBuildConflictGroup {
  source: WorklistBuildConflict;
  inheritedBy: WorklistProperty[];
}

/** F03: a listing on the website without something the website needs. */
export interface WorklistMissingEssentials {
  property: WorklistProperty;
  missing: { key: string; label: string }[];
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
   * F03: public, available listings — on the website — missing a website
   * essential (a cover photo, an English title, a price: WEBSITE_ESSENTIALS).
   * Reported, never acted on: nothing unpublishes, and whether a missing one
   * blocks publishing is the operator's open decision (BACKLOG LST-09).
   * By reference.
   */
  publicMissingEssentials: WorklistMissingEssentials[];
  /**
   * Public, available listings whose FRESH score is below PUBLISH_THRESHOLD
   * (audit 2026-09-15, LST-03). The feed deliberately does not re-check the
   * score — an admin override is an audited decision and a decayed score
   * must not silently unpublish — so the drift has to be SEEN instead.
   * Worst first. (`published_below_threshold()` (0066) asks the same of the
   * stored column; since F03 nothing in the app reads it.)
   */
  belowThreshold: WorklistProperty[];
  /** every public, available listing with a publish stamp, longest on the market first */
  onMarket: WorklistOnMarket[];
  /** public, available listings — what the website shows — stamped or not */
  publicCount: number;
  /** warnings, not points: a build year that contradicts the status or a pending delivery (CRM-05) */
  buildConflicts: WorklistBuildConflict[];
  /** the same, one group per source row (F03) — `buildConflicts` regrouped, nothing added or lost */
  buildConflictGroups: WorklistBuildConflictGroup[];
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
  /**
   * F03: the row's parent and the columns it still takes from it (0035) —
   * what decides whether a build contradiction is the row's own. Absent: own.
   */
  lineage?: { parentId: string | null; inheritedFields: readonly string[] | null };
}

/** The public feed's predicate (0066): what a buyer can currently see. */
function isOnMarket(listing: ScoredProperty["listing"]): boolean {
  return listing.visibility === "public" && listing.status === "available";
}

/**
 * Where a criterion is fixed: a tab of the property page (F03: tabs have an
 * href now, `?tab=`), or, for a container's units, its Units page.
 */
type FixTarget = { tab: PropertyTab } | { page: "units" };

const FIX_TARGET: Record<string, FixTarget> = {
  cover: { tab: "media" },
  photos6: { tab: "media" },
  title_en: { tab: "marketing" },
  description_en: { tab: "marketing" },
  // a standalone's or a unit's own price; a CONTAINER's price is its units'
  // ("Units priced"), fixed on its Units page — see fixTargetFor
  price: { tab: "details" },
  // a container's gaps are fixed on its units page, not on a tab
  units: { page: "units" },
  area: { tab: "details" },
  rooms: { tab: "details" },
  // F07: the planning zone and density are Details fields (Plot & planning, at
  // the top of a plot's Details tab) — this used to send the desk to Legal,
  // which has neither
  planning: { tab: "details" },
  coords: { tab: "details" },
  deed: { tab: "legal" },
  permit: { tab: "legal" },
  mandate: { tab: "mandate" },
  agent: { tab: "overview" },
  party: { tab: "overview" },
};

function fixTargetFor(key: string, container: boolean): FixTarget | null {
  if (key === "price" && container) return { page: "units" };
  return FIX_TARGET[key] ?? null;
}

/** Where a criterion is fixed, in words: a tab's name, or "Units page". */
export function fixLocation(key: string, opts: { container?: boolean } = {}): string | null {
  const target = fixTargetFor(key, opts.container === true);
  if (!target) return null;
  return "tab" in target ? PROPERTY_TAB_LABELS[target.tab] : "Units page";
}

/** The link that opens one property where a criterion is fixed (F03), or null for an unknown key. */
export function fixHref(
  property: { id: string; container?: boolean },
  key: string,
): string | null {
  const target = fixTargetFor(key, property.container === true);
  if (!target) return null;
  return "tab" in target
    ? propertyTabHref(property.id, target.tab)
    : `/properties/${property.id}/units`;
}

/** The tab a criterion is fixed on, or null when it is fixed elsewhere (a Units page) or unknown. */
export function fixTab(key: string, opts: { container?: boolean } = {}): PropertyTab | null {
  const target = fixTargetFor(key, opts.container === true);
  return target && "tab" in target ? target.tab : null;
}

/**
 * A website essential as a noun in running text ("public on the website
 * without: cover photo") — the item labels are list headings ("Price set").
 * A container's price is its units' (F03).
 */
export function essentialNoun(key: string, opts: { container?: boolean } = {}): string {
  if (key === "cover") return "cover photo";
  if (key === "title_en") return "English title";
  if (key === "price") return opts.container ? "priced units" : "price";
  return key;
}

/** The columns through which a unit or phase can inherit a build contradiction (0035). */
export const INHERITED_BUILD_FIELDS = ["construction_status", "delivery_date"] as const;

/**
 * Whether a row's build contradiction is its parent's, carried down (F03): the
 * row still inherits one of the build columns AND the parent declares the very
 * same contradiction. A unit whose OWN year built contradicts the inherited
 * status carries a different sentence and stays its own.
 */
export function inheritsBuildConflict(
  child: { conflict: string | null; inheritedFields: readonly string[] | null | undefined },
  parentConflict: string | null,
): boolean {
  if (!child.conflict || child.conflict !== parentConflict) return false;
  const inherited = child.inheritedFields ?? [];
  return INHERITED_BUILD_FIELDS.some((f) => inherited.includes(f));
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

  const { buildConflicts, buildConflictGroups } = groupBuildConflicts(scored);

  const live = scored.filter((s) => isOnMarket(s.listing));
  const publicMissingEssentials: WorklistMissingEssentials[] = live
    .filter((s) => s.result.essentialsMissing.length > 0)
    .map((s) => ({
      property: s.property,
      missing: s.result.essentialsMissing.map((i) => ({ key: i.key, label: i.label })),
    }))
    .sort((a, b) => a.property.reference.localeCompare(b.property.reference));
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
    publicMissingEssentials,
    belowThreshold,
    onMarket,
    publicCount: live.length,
    sharedPhotos,
    buildConflicts,
    buildConflictGroups,
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
 * Every build contradiction, each told where it comes from, and the same set
 * grouped by source (F03). A row's source is followed up through parents that
 * carry the same sentence by inheritance (unit → phase → project), so a
 * project's contradiction collects its phases' units too.
 */
function groupBuildConflicts(scored: ScoredProperty[]): {
  buildConflicts: WorklistBuildConflict[];
  buildConflictGroups: WorklistBuildConflictGroup[];
} {
  const conflictOf = new Map<string, string>();
  const byId = new Map<string, ScoredProperty>();
  for (const s of scored) {
    byId.set(s.property.id, s);
    const w = s.result.warnings.find((x) => x.key === "build_conflict");
    if (w) conflictOf.set(s.property.id, w.label);
  }

  /** the parent this row's contradiction is inherited from, one level up */
  const parentSource = (id: string): string | null => {
    const lineage = byId.get(id)?.lineage;
    const parentId = lineage?.parentId ?? null;
    if (parentId === null) return null;
    const conflict = conflictOf.get(id) ?? null;
    return inheritsBuildConflict(
      { conflict, inheritedFields: lineage?.inheritedFields },
      conflictOf.get(parentId) ?? null,
    )
      ? parentId
      : null;
  };
  /** the topmost row the contradiction is inherited from (a cycle stops where it closes) */
  const rootSource = (id: string): string | null => {
    let source = parentSource(id);
    if (source === null) return null;
    const seen = new Set([id, source]);
    for (let next = parentSource(source); next !== null && !seen.has(next); next = parentSource(next)) {
      seen.add(next);
      source = next;
    }
    return source;
  };

  const buildConflicts: WorklistBuildConflict[] = scored
    .flatMap(({ property, result }) =>
      result.warnings
        .filter((w) => w.key === "build_conflict")
        .map((w) => {
          const root = rootSource(property.id);
          const rootProperty = root === null ? undefined : byId.get(root)?.property;
          return {
            property,
            label: w.label,
            inheritedFrom: rootProperty
              ? { id: rootProperty.id, reference: rootProperty.reference }
              : null,
          };
        }),
    )
    .sort((a, b) => a.property.reference.localeCompare(b.property.reference));

  const groups = new Map<string, WorklistBuildConflictGroup>();
  for (const c of buildConflicts) {
    if (c.inheritedFrom === null) groups.set(c.property.id, { source: c, inheritedBy: [] });
  }
  for (const c of buildConflicts) {
    if (c.inheritedFrom === null) continue;
    const group = groups.get(c.inheritedFrom.id);
    // a source is always a row with its own group — unless parent links loop,
    // which no real data does; then the row stands alone rather than vanish
    if (group) group.inheritedBy.push(c.property);
    else groups.set(c.property.id, { source: c, inheritedBy: [] });
  }
  return {
    buildConflicts,
    // each group's tail is in reference order because buildConflicts is
    buildConflictGroups: [...groups.values()].sort((a, b) =>
      a.source.property.reference.localeCompare(b.source.property.reference),
    ),
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
