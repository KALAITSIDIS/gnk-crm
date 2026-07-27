/**
 * AML retention-expiry classification (IMPROVEMENTS B11).
 *
 * `contacts.retention_until` is written by the GDPR Art.17 erasure flow: when a
 * customer due-diligence relationship existed, the KYC documents must survive
 * the erasure by five years (Cyprus AML). Nothing read that column until this
 * module — data was marked for expiry and then kept forever, leaving the
 * Article 17 implementation half-closed.
 *
 * Pure and I/O-free: dates in, status out. Dates are Cyprus-local day keys
 * ("YYYY-MM-DD"), matching the `date` column and computed via
 * `zonedParts(...).dayKey` — the retention duty is a calendar obligation in
 * Cyprus, not a UTC instant.
 */

/** How far ahead an upcoming expiry is flagged, so a purge can be planned. */
export const RETENTION_DUE_SOON_DAYS = 90;

export type RetentionStatus = "expired" | "due_soon" | "retained";

export interface RetentionRow {
  id: string;
  displayName: string | null;
  /** "YYYY-MM-DD"; only rows WITH a retention date belong on this surface */
  retentionUntil: string;
}

export interface RetentionRowStatus extends RetentionRow {
  status: RetentionStatus;
  /** negative once the duty has run out */
  daysRemaining: number;
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `today` until `retentionUntil`; negative once past. */
export function daysUntilRetentionEnds(retentionUntil: string, today: string): number {
  // Both are plain calendar dates, so parse at UTC midnight: the difference is
  // exact whole days with no DST or offset drift.
  const end = Date.parse(`${retentionUntil}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Math.round((end - now) / MS_PER_DAY);
}

/**
 * Expired ON the retention date: the duty is "five years past the relationship",
 * so once that date arrives the obligation has been served and the records may
 * be purged. Before it, `due_soon` inside the notice window, else `retained`.
 */
export function classifyRetention(retentionUntil: string, today: string): RetentionStatus {
  const days = daysUntilRetentionEnds(retentionUntil, today);
  if (days <= 0) return "expired";
  return days <= RETENTION_DUE_SOON_DAYS ? "due_soon" : "retained";
}

/** Tag each row with its status and sort soonest-first (actionable rows lead). */
export function summarizeRetention(
  rows: readonly RetentionRow[],
  today: string,
): RetentionRowStatus[] {
  return rows
    .map((r) => ({
      ...r,
      status: classifyRetention(r.retentionUntil, today),
      daysRemaining: daysUntilRetentionEnds(r.retentionUntil, today),
    }))
    .sort((a, b) => a.retentionUntil.localeCompare(b.retentionUntil));
}
