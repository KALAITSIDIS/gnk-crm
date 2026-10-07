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
 *
 * THE DATABASE WRITES WHAT THIS PREVIEWS, DIGIT FOR DIGIT (T-price-uplift-atomic,
 * migration 0141). The write happens in `record_price_list_version`, in exact
 * numeric; this file computes the preview in exact decimals the same way. It
 * used to multiply in floating point, which disagreed with the rule at a half:
 * €50.000 + 0,1% is exactly €50.050, which the €100 rule rounds UP to €50.100 —
 * float made it 50049.999… and rounded it down, so the preview showed (and the
 * old action wrote) €50.000.
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
 * like a price. A half rounds away from zero (PostgreSQL's `round`), which for
 * a price is up.
 */
export const ROUND_TO = 100;

/** Smallest price the uplift will produce. A discount cannot reach zero. */
export const MIN_PRICE = ROUND_TO;

/** A finite decimal held exactly: the value is `v / 10^s`. */
interface Exact {
  v: bigint;
  s: number;
}

// BigInt constants by call, not literal: the tsconfig target (ES2017) predates `10n`
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const pow10 = (n: number): bigint => BigInt(10) ** BigInt(n);

/**
 * The exact decimal a number or numeric string spells. A JS number is read
 * through `String(n)` — its shortest round-trip digits, which is also what
 * JSON.stringify sends PostgREST, so the database computes on the same digits.
 */
function exact(x: number | string): Exact | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(x).trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const frac = m[3] ?? "";
  let v = BigInt(`${m[2]}${frac}` || "0");
  let s = frac.length - (m[4] ? Number(m[4]) : 0);
  if (s < 0) {
    v *= pow10(-s);
    s = 0;
  }
  return { v: m[1] === "-" ? -v : v, s };
}

/** n / d rounded half away from zero (d > 0). */
function divRound(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  const twice = TWO * (r < ZERO ? -r : r);
  return twice >= d ? q + (n < ZERO ? -ONE : ONE) : q;
}

/**
 * `a × b` to the nearest €100, a half up — exact, the digits PostgreSQL's
 * `round(a * b, -2)` computes on (0142's unit-type price). Null when either is
 * not a finite decimal or the product is not positive.
 */
export function roundedProduct(a: number | string, b: number | string): number | null {
  const x = exact(a);
  const y = exact(b);
  if (!x || !y) return null;
  const product = x.v * y.v;
  if (product <= ZERO) return null;
  return Number(divRound(product, pow10(x.s + y.s + 2)) * BigInt(ROUND_TO));
}

/**
 * The new price for one unit, or null when there is nothing to uplift.
 *
 * A unit with no price is SKIPPED rather than treated as 0 — applying +3% to
 * "not priced yet" would invent €0 and then round it up to €100, which is a
 * number nobody chose.
 *
 * Exact: percent is `round(price × (100 + amount), −4) / 100`, fixed is
 * `round(price + amount, −2)` — the same expressions migration 0141 evaluates
 * in numeric — then never below `MIN_PRICE`.
 */
export function upliftPrice(current: number | string | null, spec: UpliftSpec): number | null {
  if (current === null || current === "") return null;
  const price = typeof current === "number" ? current : Number(current);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(spec.amount)) return null;

  const p = exact(current);
  const a = exact(spec.amount);
  if (!p || !a) return null;

  let hundreds: bigint;
  if (spec.mode === "percent") {
    // price × (100 + amount) has scale p.s + a.s; to a multiple of 10^4 of it is hundreds of euros
    const factor = HUNDRED * pow10(a.s) + a.v;
    hundreds = divRound(p.v * factor, pow10(p.s + a.s + 4));
  } else {
    const s = Math.max(p.s, a.s);
    const sum = p.v * pow10(s - p.s) + a.v * pow10(s - a.s);
    hundreds = divRound(sum, pow10(s + 2));
  }
  return Math.max(Number(hundreds * BigInt(ROUND_TO)), MIN_PRICE);
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
 * The preview the form shows. The database (`record_price_list_version`,
 * 0141) recomputes it with the same rule, and refuses the write if the units
 * no longer hold the prices this was computed from.
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

/**
 * What the form sends as the reviewed scope: every unit the preview covered,
 * priced or not, with the price it showed. The database answers `stale` — and
 * changes nothing — unless the scope still holds exactly these units at
 * exactly these prices (0141).
 */
export function reviewedScope(targets: UpliftTarget[]): { id: string; price: number | null }[] {
  return targets.map((t) => ({
    id: t.id,
    price: t.asking_price === null || t.asking_price === "" ? null : Number(t.asking_price),
  }));
}
