/**
 * Turning a payment plan into a reservation's schedule (0050).
 *
 * PURE. No I/O, so the arithmetic — which is money — is testable exhaustively.
 *
 * A `payment_plans` row holds `{label, pct, due}[]` where **`due` is free text**
 * ("On contract signing"), NOT a date. A plan therefore describes proportions
 * and milestones; it cannot describe a dated schedule, and no amount of code
 * here can invent one. Dates are entered per reservation afterwards, which is
 * also why instalment reminders need this table rather than the plan.
 *
 * THE SCHEDULE IS FROZEN WHEN IT IS APPLIED, and that is the point of storing
 * amounts at all rather than recomputing them. A unit's asking price can move —
 * `applyPriceUplift` moves sixty at once — and a schedule already quoted to a
 * buyer must not silently move with it. Same reasoning as `price_lists` being
 * versioned snapshots rather than live reads.
 */

export interface PlanInstallment {
  label: string;
  pct: number;
  /** the plan's milestone text, e.g. "On contract signing" — never a date */
  due?: string | null;
}

export interface ScheduleLine {
  sortOrder: number;
  label: string;
  pct: number;
  /** cents-exact, and the lines sum to `scheduleTotal` */
  amount: number;
  milestone: string | null;
}

export interface BuiltSchedule {
  lines: ScheduleLine[];
  /** what the lines add up to — NOT necessarily the whole price, see below */
  scheduleTotal: number;
  /** sum of the plan's percentages, so a caller can warn when it is not 100 */
  totalPct: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Apply a plan to a price.
 *
 * TWO ROUNDING RULES, both deliberate:
 *
 * 1. **The last line absorbs the remainder.** Three 33.333% instalments on
 *    €100.000 are 33.333,00 each, which is €1 short. Rounding each line
 *    independently and hoping is how a schedule ends up not summing to what the
 *    buyer was quoted. The final line carries the difference instead.
 *
 * 2. **A plan that does not sum to 100% is NOT forced to.** If the percentages
 *    add to 90, the schedule totals 90% of the price and `totalPct` reports 90
 *    so the UI can say so. Scaling it up to 100 would silently invent money the
 *    desk never agreed; the absorbing in rule 1 fixes ROUNDING DRIFT only, never
 *    a deliberate shortfall.
 */
export function buildSchedule(plan: PlanInstallment[], total: number): BuiltSchedule {
  const usable = plan.filter((i) => Number.isFinite(i.pct) && i.pct > 0 && i.label.trim());
  const totalPct = round2(usable.reduce((s, i) => s + i.pct, 0));

  if (usable.length === 0 || !Number.isFinite(total) || total <= 0) {
    return { lines: [], scheduleTotal: 0, totalPct };
  }

  // What the plan as written is owed, at cent precision.
  const scheduleTotal = round2((totalPct / 100) * total);

  const lines: ScheduleLine[] = usable.map((i, idx) => ({
    sortOrder: idx,
    label: i.label.trim(),
    pct: i.pct,
    amount: round2((i.pct / 100) * total),
    milestone: i.due?.trim() ? i.due.trim() : null,
  }));

  // Rule 1: the last line carries whatever the per-line rounding lost or gained.
  const summed = round2(lines.reduce((s, l) => s + l.amount, 0));
  const drift = round2(scheduleTotal - summed);
  if (drift !== 0) {
    const last = lines[lines.length - 1]!;
    last.amount = round2(last.amount + drift);
  }

  return { lines, scheduleTotal, totalPct };
}

/** What is still owed on a schedule, given what has been marked paid. */
export function outstanding(
  lines: { amount: number; paidAmount: number | null }[],
): { paid: number; due: number } {
  const paid = round2(lines.reduce((s, l) => s + (l.paidAmount ?? 0), 0));
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  return { paid, due: round2(total - paid) };
}
