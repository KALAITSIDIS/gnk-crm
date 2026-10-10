/**
 * The figure a deal is DISPLAYED at: a WON deal at its confirmed final value,
 * falling back to its estimate when none was recorded; every other deal at
 * its estimate. The rule of the two money reports (report_agent_performance,
 * report_source_roi — 0076) and of the dashboard's "won this month" (0140) —
 * `coalesce(final_value, expected_value)` for won rows. Used by the pipeline
 * board (a card, and the column total that sums the cards), the deal page
 * header and its Costs link, and the commission evidence's deal lines, so
 * each deal is valued the same way on all of them. (Totals still differ by
 * design: the board's closed columns hold a rolling 30 days, the dashboard a
 * Cyprus calendar month.) close_deal records the accepted offer's amount as
 * final_value, so nearly every real win differs from its estimate.
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
  const v = dealValueIsFinal(d) ? d.final_value : d.expected_value;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * Whether `dealValue()` is the deal's CONFIRMED price (a won deal with a final
 * value recorded) rather than its estimate — what a surface uses to label the
 * figure ("Final value" vs "Expected value"), so a won deal closed without a
 * figure never passes its estimate off as the price.
 */
export function dealValueIsFinal(d: { status: string; final_value: number | null }): boolean {
  return d.status === "won" && d.final_value !== null && d.final_value !== undefined;
}
