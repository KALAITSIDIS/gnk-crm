/**
 * The figure a deal is DISPLAYED at on the pipeline board (a card, and the
 * column total that sums the cards): a WON deal at its confirmed final value,
 * falling back to its estimate when none was recorded; every other deal at
 * its estimate. The reports' rule (0076) and the dashboard's "won this month"
 * (0140) — `coalesce(final_value, expected_value)` for won rows — so each
 * deal is valued the same way on every one of those surfaces. (Their totals
 * still differ by design: the board's closed columns hold a rolling 30 days,
 * the dashboard a Cyprus calendar month.) close_deal records the accepted
 * offer's amount as final_value, so nearly every real win differs from its
 * estimate.
 *
 * A display value only: the stored estimate (`deals.expected_value`) is never
 * replaced by it. `final_value` is REQUIRED in the argument's type so a caller
 * whose select forgot the column fails to compile instead of silently showing
 * the estimate; at run time a missing key still reads as "none recorded". The
 * fallback tests for null, never truthiness: a final value of 0 is a
 * confirmed 0. The figure goes through `Number()` as the board's estimate
 * always did before it.
 */
export function dealValue(d: {
  status: string;
  expected_value: number | null;
  final_value: number | null;
}): number | null {
  const v = d.status === "won" && d.final_value !== null && d.final_value !== undefined ? d.final_value : d.expected_value;
  return v === null || v === undefined ? null : Number(v);
}
