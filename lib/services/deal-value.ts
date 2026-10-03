/**
 * The figure a deal is worth on a board or a total: a WON deal at its
 * confirmed final value, falling back to the estimate when none was recorded;
 * every other deal at its estimate. The same rule as the reports (0076) and
 * the dashboard's "won this month" (0140) — `coalesce(final_value,
 * expected_value)` for won rows — so a card, its column and the dashboard
 * agree. close_deal records the accepted offer's amount as final_value, so
 * nearly every real win differs from its estimate.
 */
export function dealValue(d: {
  status: string;
  expected_value: number | null;
  final_value?: number | null;
}): number | null {
  if (d.status === "won" && d.final_value !== null && d.final_value !== undefined) return d.final_value;
  return d.expected_value;
}
