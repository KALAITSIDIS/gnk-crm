/**
 * The four nightly sweep thresholds (migration 0052).
 *
 * PURE. No I/O, so the fallback rules — which decide whether four cron jobs
 * behave — are testable exhaustively.
 *
 * ============================================================================
 * `readThresholds` IS A DELIBERATE SECOND READER OF `cyprus_config.
 * nudge_thresholds`, AND THAT IS THE RISK THIS WHOLE FEATURE EXISTS TO AVOID.
 *
 * The reason those numbers were hardcoded in four separate migrations is that
 * every one of them carries a comment saying a second editable copy could
 * disagree silently about what the number means. Putting them in config does
 * not remove that risk — it moves it here, to the gap between this function and
 * `public.nudge_threshold(text, numeric)` in SQL.
 *
 * So this function mirrors that SQL function RULE FOR RULE, and nothing else:
 *
 *   | input                        | both must yield |
 *   |------------------------------|-----------------|
 *   | key absent / row missing     | the default     |
 *   | not a plain non-negative num | the default     |
 *   | <= 0                         | the default     |
 *   | > 3650                       | the default     |
 *   | otherwise                    | the value       |
 *
 * `nudge-thresholds.test.ts` runs the same table against this function that
 * 0052's assertion block runs against the SQL one. **If you change one, change
 * the other and both tables**, or the settings page will display a number the
 * sweeps do not use — which is worse than the hardcoding was, because it looks
 * authoritative.
 *
 * NOTE the deliberate asymmetry with FORM_BOUNDS below: this reader accepts
 * anything SQL accepts, including values the form would refuse. It has to. The
 * config row is editable as raw JSON on /settings/cyprus-config, so a value
 * outside the form's range is reachable, and when it is, the UI must show what
 * the sweeps are ACTUALLY using rather than what it wishes they used.
 * ============================================================================
 */

export const NUDGE_THRESHOLD_KEYS = [
  "deal_no_contact_days",
  "viewing_feedback_hours",
  "reservation_expiry_days",
  "installment_due_days",
] as const;

export type NudgeThresholdKey = (typeof NUDGE_THRESHOLD_KEYS)[number];

/** The constants each sweep shipped with, and still falls back to. */
export const NUDGE_DEFAULTS: Record<NudgeThresholdKey, number> = {
  deal_no_contact_days: 14,
  viewing_feedback_hours: 48,
  reservation_expiry_days: 2,
  installment_due_days: 7,
};

/** Mirrors the SQL guard exactly — see the header table. */
const SQL_MAX = 3650;

/**
 * What the FORM will accept. Narrower than the SQL guard on purpose: these are
 * the ranges that make operational sense, whereas SQL's job is only to refuse
 * input that would break a sweep.
 */
export const FORM_BOUNDS: Record<NudgeThresholdKey, { min: number; max: number }> = {
  // a day is the shortest useful silence; a quarter is the longest that is
  // still a follow-up rather than an archive
  deal_no_contact_days: { min: 1, max: 90 },
  // an hour after the viewing to two weeks
  viewing_feedback_hours: { min: 1, max: 336 },
  // warning later than the hold itself is meaningless, and holds are short
  reservation_expiry_days: { min: 1, max: 30 },
  // a quarter's notice on a payment is already generous
  installment_due_days: { min: 1, max: 90 },
};

export const NUDGE_LABELS: Record<NudgeThresholdKey, { label: string; unit: string; help: string }> =
  {
    deal_no_contact_days: {
      label: "Chase an open deal after",
      unit: "days of silence",
      help: "Raises a chase-up task on any open deal with no logged contact. Logging contact closes it and restarts the clock.",
    },
    viewing_feedback_hours: {
      label: "Chase viewing feedback after",
      unit: "hours",
      help: "Raises a task when a completed viewing still has no feedback. Existing tasks keep their original timing — a viewing has one feedback cycle.",
    },
    reservation_expiry_days: {
      label: "Warn before a hold lapses",
      unit: "days ahead",
      help: "Warns while there is still time to extend or chase the deposit. Runs after the nightly expiry sweep, so a hold that already lapsed closes its warning instead.",
    },
    installment_due_days: {
      label: "Chase an instalment",
      unit: "days ahead",
      help: "Chases unpaid instalments on holds and signed sales. Overdue lines are always chased, whatever this is set to.",
    },
  };

const isPlainNumber = (raw: unknown): number | null => {
  // Postgres hands `numeric` to PostgREST as a STRING, and the config value is
  // JSON that a human may have typed, so both shapes are real.
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    // the same shape the SQL regex admits — no signs, no exponents, no spaces
    if (!/^[0-9]+(\.[0-9]+)?$/.test(raw.trim())) return null;
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** One key, with the SQL function's exact fallback behaviour. */
export function readThreshold(value: unknown, key: NudgeThresholdKey): number {
  const fallback = NUDGE_DEFAULTS[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;
  const n = isPlainNumber((value as Record<string, unknown>)[key]);
  if (n === null || n <= 0 || n > SQL_MAX) return fallback;
  return n;
}

/** All four, for the settings form and anything that displays them. */
export function readThresholds(value: unknown): Record<NudgeThresholdKey, number> {
  return {
    deal_no_contact_days: readThreshold(value, "deal_no_contact_days"),
    viewing_feedback_hours: readThreshold(value, "viewing_feedback_hours"),
    reservation_expiry_days: readThreshold(value, "reservation_expiry_days"),
    installment_due_days: readThreshold(value, "installment_due_days"),
  };
}

/**
 * True when the stored value would not survive the form's own rules — i.e. the
 * sweeps are using something a raw-JSON edit put there. The settings page says
 * so rather than silently rounding it into range.
 */
export function isOutsideFormBounds(key: NudgeThresholdKey, n: number): boolean {
  const b = FORM_BOUNDS[key];
  return n < b.min || n > b.max || !Number.isInteger(n);
}
