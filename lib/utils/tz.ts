/**
 * Timezone helpers (doc 02 §A11: the agency operates in Asia/Nicosia).
 *
 * `scheduled_at` and friends are stored as UTC `timestamptz`. Users think in
 * Cyprus wall-clock time, and datetime-local inputs are timezone-naive, so we
 * convert explicitly rather than trusting the browser's local zone (which may
 * not be Cyprus). All conversions pass the zone to Intl, so results are the
 * same on a UTC CI box as on a Cyprus laptop.
 */

export const CYPRUS_TZ = "Asia/Nicosia";

/**
 * Offset in ms between wall-clock time in `tz` and UTC at a given instant
 * (positive when the zone is ahead of UTC, e.g. +3h during Cyprus summer).
 */
function tzOffsetMs(tz: string, utcDate: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(utcDate)) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtc - utcDate.getTime();
}

/**
 * Interpret a naive wall-clock string ("YYYY-MM-DDTHH:mm", optional seconds)
 * as `tz` local time and return the corresponding UTC Date.
 */
export function zonedWallClockToUtc(wallClock: string, tz: string = CYPRUS_TZ): Date {
  const m = wallClock.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error(`Invalid wall-clock datetime: ${wallClock}`);
  const [, y, mo, d, h, mi, s] = m;
  const naiveUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  // Two passes so a guess that lands on the far side of a DST switch settles.
  const offset1 = tzOffsetMs(tz, new Date(naiveUtc));
  const offset2 = tzOffsetMs(tz, new Date(naiveUtc - offset1));
  return new Date(naiveUtc - offset2);
}

/**
 * Format a UTC instant as a naive "YYYY-MM-DDTHH:mm" wall-clock string in `tz`,
 * suitable as the value of a datetime-local input.
 */
export function utcToDatetimeLocal(iso: string | Date, tz: string = CYPRUS_TZ): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

/**
 * Inclusive Cyprus-local date range ("YYYY-MM-DD", either bound optional) →
 * half-open UTC interval [gte, lt) for timestamptz filtering. The exclusive
 * end is the start of the day AFTER `to`, so the final local day is fully
 * covered including sub-second events (evidence report, T-audit-reports).
 */
export function zonedDateRangeToUtc(
  from: string | undefined,
  to: string | undefined,
  tz: string = CYPRUS_TZ,
): { gte: string | undefined; lt: string | undefined } {
  const gte = from ? zonedWallClockToUtc(`${from}T00:00`, tz).toISOString() : undefined;
  let lt: string | undefined;
  if (to) {
    // day + 1 via Date.UTC so month/year rollover is calendar-correct
    const next = new Date(
      Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10) + 1),
    );
    lt = zonedWallClockToUtc(`${next.toISOString().slice(0, 10)}T00:00`, tz).toISOString();
  }
  return { gte, lt };
}

/**
 * Cyprus-local calendar coordinates for a UTC instant: the day bucket
 * ("YYYY-MM-DD"), minutes since local midnight, and a "HH:mm" label. Used to
 * place viewings on the calendar grid without redoing tz math on the client.
 */
export function zonedParts(
  iso: string | Date,
  tz: string = CYPRUS_TZ,
): { dayKey: string; minutes: number; timeLabel: string } {
  const local = utcToDatetimeLocal(iso, tz);
  const [dayKey, time] = local.split("T");
  const [h, mi] = time.split(":").map(Number);
  return { dayKey, minutes: h * 60 + mi, timeLabel: time };
}
