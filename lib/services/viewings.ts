/**
 * Viewing scheduling helpers (T4.1). Pure interval math so it can be unit
 * tested without a DB; the server action feeds it rows and the calendar uses
 * the result to flag agent double-bookings.
 */

/** Consent line shown on the signing screen and printed on the slip (T4.2). */
export const SLIP_GDPR_LINE =
  "By signing, I confirm I attended this property viewing on the date shown. " +
  "I consent to the agency recording this confirmation and my signature for " +
  "compliance and commission-evidence purposes, retained under the agency's " +
  "privacy policy and Cyprus/EU data-protection law.";

export interface ConflictItem {
  id: string;
  agentId: string;
  /** UTC epoch ms */
  startMs: number;
  durationMin: number;
}

/** Half-open interval overlap: [aStart,aEnd) intersects [bStart,bEnd). */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export interface RouteSortable {
  id: string;
  startMinutes: number;
  routeDate: string | null;
  routeOrder: number | null;
}

/**
 * Initial ordering for the day-route builder (T4.4): stops already routed for
 * THIS day keep their saved order; everything else follows by start time.
 * A route saved for a different date is ignored — it's stale for this day.
 */
export function initialRouteOrder<T extends RouteSortable>(items: T[], dayKey: string): T[] {
  const saved = (v: T) =>
    v.routeDate === dayKey && v.routeOrder !== null ? v.routeOrder : Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) => saved(a) - saved(b) || a.startMinutes - b.startMinutes);
}

export interface RouteGroupable {
  agentName: string;
  routeOrder: number | null;
}

/**
 * Group a day's route stops per agent for the printable sheet. Each agent
 * saves their own 1..N sequence, so a flat route_order sort would interleave
 * duplicate numbers across agents; instead: groups in agent-name order, stops
 * within a group by route_order (unrouted last, ties keep input order).
 */
export function groupRouteStops<T extends RouteGroupable>(
  stops: T[],
): { agent: string; stops: T[] }[] {
  const byAgent = new Map<string, T[]>();
  for (const s of stops) {
    const arr = byAgent.get(s.agentName) ?? [];
    arr.push(s);
    byAgent.set(s.agentName, arr);
  }
  return [...byAgent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, items]) => ({
      agent,
      stops: [...items].sort(
        (a, b) =>
          (a.routeOrder ?? Number.POSITIVE_INFINITY) - (b.routeOrder ?? Number.POSITIVE_INFINITY),
      ),
    }));
}

/**
 * Ids of viewings that overlap at least one other viewing held by the SAME
 * agent. A zero-duration viewing still can't sit inside another's window.
 * O(n²) — fine for Phase 1 volumes.
 */
export function computeConflictIds(items: ConflictItem[]): Set<string> {
  const conflicts = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const aEnd = a.startMs + a.durationMin * 60_000;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (a.agentId !== b.agentId) continue;
      const bEnd = b.startMs + b.durationMin * 60_000;
      if (intervalsOverlap(a.startMs, aEnd, b.startMs, bEnd)) {
        conflicts.add(a.id);
        conflicts.add(b.id);
      }
    }
  }
  return conflicts;
}
