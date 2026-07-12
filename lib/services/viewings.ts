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
