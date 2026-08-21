/**
 * Working out a renewal's dates (BACKLOG audit finding 6).
 *
 * Pure and tested because the arithmetic is the part that goes quietly wrong.
 * A renewal with the wrong window is not a crash — it is a contract that says
 * something nobody agreed to, discovered months later when somebody asks what
 * the commission was on a specific day.
 */

export interface RenewalDates {
  start_date: string;
  expiry_date: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD, the shape the mandate columns and the date inputs both use. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/**
 * The successor's window, given the mandate being replaced and today.
 *
 * A renewal RUNS FOR THE SAME NUMBER OF DAYS as the mandate it replaces. The
 * duration is measured, not assumed to be some fixed period, because that is
 * what the two parties agreed to last time and it is the only defensible
 * default.
 *
 * Days rather than calendar months, deliberately: "six months" is not a fixed
 * length, and month arithmetic carries its own judgement calls (Jan 31 plus one
 * month). A day count is exact and cannot be argued with — so a Jan 1 to Jul 1
 * mandate renews to Jul 1 to Dec 29, which is 181 days both times.
 *
 * It STARTS WHEN THE OLD ONE ENDS, so a renewal agreed early does not
 * accidentally overlap and produce two live windows over the same property.
 * If the old mandate expired in the past, the successor starts today instead —
 * back-dating a contract to cover a gap nobody was under mandate for would be
 * inventing history.
 *
 * An open-ended mandate (no expiry) has no duration to copy, so its renewal is
 * open-ended too and starts today. Returning some invented expiry would be
 * worse than saying "still open-ended".
 */
export function resolveRenewalDates(
  previous: { start_date: string | null; expiry_date: string | null },
  today: string,
): RenewalDates {
  if (!previous.expiry_date) {
    return { start_date: today, expiry_date: null };
  }

  // starts when the old one ends, unless that is already behind us
  const start = previous.expiry_date > today ? previous.expiry_date : today;

  if (!previous.start_date) {
    // an expiry with no start gives nothing to measure; keep the window open
    return { start_date: start, expiry_date: null };
  }

  const duration = daysBetween(previous.start_date, previous.expiry_date);
  if (duration <= 0) {
    return { start_date: start, expiry_date: null };
  }

  const expiry = toIsoDate(new Date(Date.parse(start) + duration * DAY_MS));
  return { start_date: start, expiry_date: expiry };
}

/**
 * Statuses a mandate can be renewed FROM.
 *
 * `active` is included on purpose: renewals are normally agreed before the old
 * one lapses, and the successor is created as a `draft`, so nothing goes live
 * until somebody activates it — at which point the one-active-per-property
 * index (0036) forces the old one to be terminated first. That sequence IS the
 * business rule, enforced rather than described.
 *
 * `terminated` is excluded. Termination means the relationship ended; renewing
 * it is a new mandate, not a continuation, and should not claim the chain.
 */
export const RENEWABLE_STATUSES = ["active", "expired"] as const;

export function canRenew(status: string): boolean {
  return (RENEWABLE_STATUSES as readonly string[]).includes(status);
}
