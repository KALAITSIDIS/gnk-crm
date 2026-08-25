import { zonedParts } from "@/lib/utils/tz";

/**
 * Sales velocity and absorption for a project's units (0054-era feature, no
 * migration — see below).
 *
 * PURE. No I/O, so the arithmetic behind a number the desk will quote to a
 * developer is testable exhaustively.
 *
 * ============================================================================
 * WHERE THE SALE DATE COMES FROM, AND WHY IT IS TWO SHAPES.
 *
 * The BACKLOG said this could be computed from `status_changed` events "already
 * being written". That is true of the path that matters — the units grid calls
 * `updateUnitStatus`, which writes `status_changed` with `{reference, from,
 * to}` — but it is not the ONLY path. Saving the property details form calls
 * `saveProperty`, which writes an `updated` event carrying a per-field diff:
 * `{section, changed: {status: {from, to}}}`.
 *
 * A unit marked sold from the details form therefore produces no
 * `status_changed` row at all. Reading only one shape silently undercounts, and
 * silently is the operative word — the chart would simply be low, with nothing
 * anywhere saying so. `soldAtFromEvents` below reads BOTH.
 *
 * NO NEW COLUMN AND NO MIGRATION. A `sold_at` column would be easier to query
 * and would be a second source of truth about something the event log already
 * records — the exact trade the events table exists to avoid.
 * ============================================================================
 *
 * ONLY UNITS CURRENTLY `sold` ARE COUNTED, even though the events would happily
 * report a unit that was marked sold and later reverted. Two reasons: the
 * monthly series then reconciles exactly with the inventory count beside it,
 * and a sale that was undone is not a sale. The cost is that a genuine
 * sold → available → sold round trip counts once, at the FIRST sale, which is
 * the conservative direction.
 */

/** Statuses that are not inventory anybody is still trying to shift. */
const NOT_FOR_SALE = new Set(["withdrawn"]);

export interface VelocityUnit {
  id: string;
  /** CURRENT status — the series is filtered on this, see the header */
  status: string;
  /** earliest transition into `sold`, ISO; null when no event records one */
  soldAt: string | null;
  /** `numeric` reaches PostgREST as a STRING */
  askingPrice: number | string | null;
}

export interface MonthBucket {
  /** Cyprus wall-clock month, `YYYY-MM` */
  month: string;
  sold: number;
  /** summed asking price of the units sold that month */
  value: number;
}

export interface VelocityResult {
  totalUnits: number;
  byStatus: Record<string, number>;
  soldTotal: number;
  /** sold AND carrying a date — these are the ones the series can place */
  soldDated: number;
  /**
   * Sold with no event recording when. Created already sold, imported, or
   * changed by a path that predates the event. Counted in `soldTotal` and
   * absorption, absent from `months`. SURFACED rather than hidden: a chart
   * quietly missing four sales is worse than one that says four are missing.
   */
  soldUndated: number;
  /** zero-filled, ascending, capped — see SERIES_MONTHS */
  months: MonthBucket[];
  /** sold in the last 12 Cyprus months, including the current one */
  soldLast12: number;
  /** the pace used for the projection: soldLast12 / 12 */
  perMonth: number;
  /** sold ÷ total, 0–100 */
  absorptionPct: number;
  /** still to sell — excludes sold AND withdrawn */
  remaining: number;
  /** remaining ÷ perMonth, or null when the recent pace is zero */
  monthsToSellOut: number | null;
}

/**
 * How far back the zero-filled series runs. A project that started in 2015
 * would otherwise produce a hundred-odd empty buckets to render. Sales older
 * than this still count in every total; they are just off the left of the
 * chart.
 */
export const SERIES_MONTHS = 24;

/** Cyprus wall-clock month of an instant. */
export function monthKey(iso: string | Date): string {
  return zonedParts(iso).dayKey.slice(0, 7);
}

/** `YYYY-MM` arithmetic without dragging a Date through a timezone twice. */
function addMonths(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y! * 12 + (m! - 1) + delta;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}`;
}

const num = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Earliest instant at which an event says this property became `sold`.
 *
 * Handles BOTH shapes — see the module header. Returns null when neither is
 * present, which is a real state and not an error.
 */
export function soldAtFromEvents(
  events: { event_type: string; occurred_at: string; payload: unknown }[],
): string | null {
  let earliest: string | null = null;
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    let becameSold = false;

    if (e.event_type === "status_changed") {
      becameSold = p.to === "sold";
    } else if (e.event_type === "updated") {
      const changed = p.changed as Record<string, unknown> | undefined;
      const status = changed?.status as { to?: unknown } | undefined;
      becameSold = status?.to === "sold";
    }

    if (becameSold && (earliest === null || e.occurred_at < earliest)) {
      earliest = e.occurred_at;
    }
  }
  return earliest;
}

export function computeVelocity(units: VelocityUnit[], now: Date = new Date()): VelocityResult {
  const byStatus: Record<string, number> = {};
  for (const u of units) byStatus[u.status] = (byStatus[u.status] ?? 0) + 1;

  const sold = units.filter((u) => u.status === "sold");
  const dated = sold.filter((u) => u.soldAt !== null);

  const totalUnits = units.length;
  const soldTotal = sold.length;
  const withdrawn = units.filter((u) => NOT_FOR_SALE.has(u.status)).length;
  const remaining = Math.max(0, totalUnits - soldTotal - withdrawn);

  const nowMonth = monthKey(now);
  const from = addMonths(nowMonth, -(SERIES_MONTHS - 1));

  // bucket first, so a unit sold before the window still lands in the totals
  const buckets = new Map<string, MonthBucket>();
  for (let i = 0; i < SERIES_MONTHS; i++) {
    const m = addMonths(from, i);
    buckets.set(m, { month: m, sold: 0, value: 0 });
  }

  const twelveFrom = addMonths(nowMonth, -11);
  let soldLast12 = 0;

  for (const u of dated) {
    const m = monthKey(u.soldAt!);
    const b = buckets.get(m);
    if (b) {
      b.sold += 1;
      b.value += num(u.askingPrice);
    }
    // the 12-month count is independent of the chart window, and a sale in a
    // FUTURE month (clock skew on an import) must not inflate it
    if (m >= twelveFrom && m <= nowMonth) soldLast12 += 1;
  }

  const perMonth = soldLast12 / 12;
  const absorptionPct = totalUnits === 0 ? 0 : (soldTotal / totalUnits) * 100;

  return {
    totalUnits,
    byStatus,
    soldTotal,
    soldDated: dated.length,
    soldUndated: soldTotal - dated.length,
    months: [...buckets.values()],
    soldLast12,
    perMonth,
    absorptionPct,
    remaining,
    // no sales in the last twelve months means there is no current pace to
    // project from — saying "never" would be a claim, and saying "0 months"
    // would be a lie
    monthsToSellOut: perMonth > 0 ? remaining / perMonth : null,
  };
}
