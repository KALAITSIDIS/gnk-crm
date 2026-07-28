/**
 * Viewings calendar fetch window (B1 follow-up).
 *
 * The window used to be pinned to the server's `now` while the calendar's
 * anchor lived in client state, so stepping far enough forward or back left the
 * loaded range and rendered an EMPTY week — indistinguishable from "no viewings
 * booked". The anchor now travels in the URL and the window follows it, and
 * these helpers decide when a step has left the loaded range and must refetch.
 *
 * Day keys are "YYYY-MM-DD" Cyprus-local calendar days (the same `dayKey` that
 * `zonedParts` produces). All arithmetic runs at UTC noon so a DST shift can
 * never move a day.
 */

/** How far either side of the anchor the calendar loads. */
export const WINDOW_DAYS_BACK = 90;
export const WINDOW_DAYS_AHEAD = 365;

export type CalendarViewMode = "week" | "day" | "list" | "route";

export interface DayRange {
  fromKey: string;
  toKey: string;
}

function keyToUtcNoon(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

function utcNoonToKey(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function addDayKey(key: string, days: number): string {
  return utcNoonToKey(keyToUtcNoon(key) + days * 86_400_000);
}

/** Monday that starts the key's week. */
export function weekStartKey(key: string): string {
  const dow = new Date(keyToUtcNoon(key)).getUTCDay(); // 0=Sun
  return addDayKey(key, -((dow + 6) % 7));
}

/**
 * A day key straight from the URL, or `fallback` when absent or malformed.
 * Round-tripping through the calendar rejects values that look well-formed but
 * are not real dates (e.g. 2026-13-45), so a hand-edited URL cannot produce a
 * nonsense window.
 */
export function parseDayKey(raw: string | undefined | null, fallback: string): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  return utcNoonToKey(keyToUtcNoon(raw)) === raw ? raw : fallback;
}

/** The span of days the server loads for a given anchor. */
export function calendarWindow(anchorKey: string): DayRange {
  return {
    fromKey: addDayKey(anchorKey, -WINDOW_DAYS_BACK),
    toKey: addDayKey(anchorKey, WINDOW_DAYS_AHEAD),
  };
}

/**
 * The days a view actually shows. `list` reads forward from its anchor's week,
 * so it takes the same range as `week` for the purposes of "is this loaded?".
 */
export function visibleRange(anchorKey: string, view: CalendarViewMode): DayRange {
  if (view === "day" || view === "route") {
    return { fromKey: anchorKey, toKey: anchorKey };
  }
  const start = weekStartKey(anchorKey);
  return { fromKey: start, toKey: addDayKey(start, 6) };
}

/**
 * True when every day of `range` is already loaded. A range that merely
 * STRADDLES an edge is not within the window — half a week of real bookings
 * would be silently missing, which is the bug this exists to prevent.
 */
export function isRangeWithinWindow(range: DayRange, window: DayRange): boolean {
  return range.fromKey >= window.fromKey && range.toKey <= window.toKey;
}
