/**
 * Applying a price change across a block (BACKLOG audit finding 4, the other
 * half).
 *
 * Reading a version shipped; minting the next one still meant editing sixty
 * unit prices by hand and then snapshotting. "Raise the C block by 3% from
 * 1 September" is one sentence and should be one action.
 *
 * Pure and tested because this is money. A rounding rule that emerges from
 * floating point rather than being chosen produces prices like €257.499,99 on a
 * document somebody signs.
 */

export type UpliftMode = "percent" | "fixed";

export interface UpliftSpec {
  mode: UpliftMode;
  /** percent (3 = +3%, -5 = −5%) or a euro amount (5000 = +€5.000) */
  amount: number;
}

/**
 * Prices land on a round number, always.
 *
 * €100 is the granularity Cyprus asking prices are actually quoted at, and it
 * is coarse enough that 3% of anything realistic still moves. Rounding is a
 * DECISION, not an artefact: without it, 3% of 253.000 is 260.590 and 3% of
 * 260.590 is 268.407,70 — and the second number has already stopped looking
 * like a price.
 */
export const ROUND_TO = 100;

/** Smallest price the uplift will produce. A discount cannot reach zero. */
export const MIN_PRICE = ROUND_TO;

/**
 * The new price for one unit, or null when there is nothing to uplift.
 *
 * A unit with no price is SKIPPED rather than treated as 0 — applying +3% to
 * "not priced yet" would invent €0 and then round it up to €100, which is a
 * number nobody chose.
 */
export function upliftPrice(current: number | string | null, spec: UpliftSpec): number | null {
  if (current === null || current === "") return null;
  const price = typeof current === "number" ? current : Number(current);
  if (!Number.isFinite(price) || price <= 0) return null;

  const raw = spec.mode === "percent" ? price * (1 + spec.amount / 100) : price + spec.amount;
  const rounded = Math.round(raw / ROUND_TO) * ROUND_TO;
  return Math.max(rounded, MIN_PRICE);
}

export interface UpliftTarget {
  id: string;
  reference: string;
  block: string | null;
  asking_price: number | string | null;
}

export interface UpliftRow {
  id: string;
  reference: string;
  from: number;
  to: number;
}

export interface UpliftPreview {
  rows: UpliftRow[];
  /** in scope but carrying no price, so untouched */
  skipped: number;
  /** in scope, priced, but the rounded result equals the current price */
  unchanged: number;
  totalBefore: number;
  totalAfter: number;
}

/**
 * What the uplift would do, given the units in scope.
 *
 * Shared with the form, so the preview cannot disagree with the write — the
 * same reason the bulk unit generator shares `generateUnits`.
 */
export function previewUplift(targets: UpliftTarget[], spec: UpliftSpec): UpliftPreview {
  const rows: UpliftRow[] = [];
  let skipped = 0;
  let unchanged = 0;
  let totalBefore = 0;
  let totalAfter = 0;

  for (const t of targets) {
    const to = upliftPrice(t.asking_price, spec);
    if (to === null) {
      skipped++;
      continue;
    }
    const from = Number(t.asking_price);
    totalBefore += from;
    totalAfter += to;
    if (to === from) {
      unchanged++;
      continue;
    }
    rows.push({ id: t.id, reference: t.reference, from, to });
  }

  return { rows, skipped, unchanged, totalBefore, totalAfter };
}

/** Distinct block labels among the units, for the scope selector. */
export function blocksOf(targets: UpliftTarget[]): string[] {
  return [...new Set(targets.map((t) => t.block).filter((b): b is string => !!b))].sort();
}

/** Units the chosen scope covers. `null` block means every unit. */
export function inScope(targets: UpliftTarget[], block: string | null): UpliftTarget[] {
  return block === null ? targets : targets.filter((t) => t.block === block);
}
