/**
 * Cyprus purchase-cost calculators (T5.1, doc 02 §C8). Pure functions over
 * the `cyprus_config` JSON — rates are NEVER hardcoded (guardrail 5); a config
 * edit in Settings changes results with no deploy. All amounts in EUR; fees
 * rounded to cents per band.
 */

export interface FeeBand {
  /** inclusive upper bound of the band; null = open-ended top band */
  up_to: number | null;
  rate: number;
}

export interface TransferFeesConfig {
  bands: FeeBand[];
  relief_pct: number;
  vat_paid_exempt: boolean;
}

export interface StampDutyConfig {
  bands: FeeBand[];
  cap: number | null;
}

export interface BandRow {
  /** e.g. "€0 – €85.000 @ 3%" — label composed by the UI; we return numbers */
  from: number;
  to: number | null;
  rate: number;
  taxable: number;
  fee: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const isFraction = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * A band table is only safe to compute with if it is STRICTLY ASCENDING and
 * only its LAST band is open-ended. `computeBandRows` walks the bands in
 * array order and slices between the previous bound and this one, so a table
 * that violates either rule produces silently wrong money:
 *   - descending bounds  -> a negative slice, i.e. a negative fee;
 *   - an open band in the middle -> the loop breaks and later bands vanish.
 * Rates are likewise bounded to 0..1, because the single most likely edit in
 * Settings is typing "3" for 3% — which would quote a 300% fee.
 * (Audit 2026-07-22, finding CALC-2: cyprus_config is admin-editable and this
 * guard is the only thing between a typo and a wrong figure shown to a buyer.)
 */
function isBandArray(v: unknown): v is FeeBand[] {
  if (!Array.isArray(v) || v.length === 0) return false;

  let prev = 0;
  for (let i = 0; i < v.length; i++) {
    const b = v[i] as FeeBand | null;
    if (b === null || typeof b !== "object") return false;
    if (!isFraction(b.rate)) return false;

    const isLast = i === v.length - 1;
    if (b.up_to === null) {
      // open-ended band is legal only as the final entry
      if (!isLast) return false;
      continue;
    }
    if (typeof b.up_to !== "number" || !Number.isFinite(b.up_to)) return false;
    // strictly ascending, and the first bound must be above zero
    if (b.up_to <= prev) return false;
    prev = b.up_to;
  }
  return true;
}

export function parseTransferFeesConfig(value: unknown): TransferFeesConfig | null {
  const v = value as Partial<TransferFeesConfig> | null;
  if (!v || !isBandArray(v.bands) || !isFraction(v.relief_pct)) return null;
  return {
    bands: v.bands,
    relief_pct: v.relief_pct,
    vat_paid_exempt: v.vat_paid_exempt === true,
  };
}

export function parseStampDutyConfig(value: unknown): StampDutyConfig | null {
  const v = value as Partial<StampDutyConfig> | null;
  if (!v || !isBandArray(v.bands)) return null;
  if (v.cap !== undefined && v.cap !== null) {
    if (typeof v.cap !== "number" || !Number.isFinite(v.cap) || v.cap < 0) return null;
  }
  return { bands: v.bands, cap: typeof v.cap === "number" ? v.cap : null };
}

/** Progressive banded fee: each band taxes the slice between the previous
 * bound and its own `up_to` (open top band takes the rest). */
export function computeBandRows(price: number, bands: FeeBand[]): BandRow[] {
  const rows: BandRow[] = [];
  let prev = 0;
  for (const band of bands) {
    if (price <= prev) break;
    const to = band.up_to;
    const slice = Math.min(price, to ?? Number.POSITIVE_INFINITY) - prev;
    rows.push({
      from: prev,
      to,
      rate: band.rate,
      taxable: round2(slice),
      fee: round2(slice * band.rate),
    });
    if (to === null || price <= to) break;
    prev = to;
  }
  return rows;
}

export interface TransferFeesResult {
  /** band breakdown for ONE purchaser's share (see `purchasers`) */
  rows: BandRow[];
  /** number of purchasers the assessment was split across (>= 1) */
  purchasers: number;
  /** fee for a single share, before relief */
  perShareGross: number;
  /** perShareGross x purchasers, before relief */
  gross: number;
  reliefApplied: boolean;
  reliefAmount: number;
  vatExempt: boolean;
  total: number;
}

/** A purchaser count must be a whole number of people, at least one. */
function normalisePurchasers(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

/**
 * Transfer fees on the DLS progressive scale.
 *
 * The scale is assessed on EACH PURCHASER'S SHARE, not on the contract as a
 * whole — the seeded `cyprus_config` row says so ("progressive, per purchaser
 * share"). So the bands restart for every purchaser: a couple buying jointly
 * at EUR 300,000 is assessed as two shares of 150,000, not one of 300,000,
 * which is EUR 2,800 cheaper after relief. Equal shares are assumed; that is
 * the ordinary case and the only split the screen collects.
 * (Audit 2026-07-22, finding CALC-1.)
 *
 * Stamp duty deliberately does NOT take a purchaser count — it is charged on
 * the contract and capped per document.
 */
export function computeTransferFees(
  price: number,
  config: TransferFeesConfig,
  opts: { relief: boolean; vatPaid: boolean; purchasers?: number },
): TransferFeesResult {
  const purchasers = normalisePurchasers(opts.purchasers);

  if (opts.vatPaid && config.vat_paid_exempt) {
    return {
      rows: [],
      purchasers,
      perShareGross: 0,
      gross: 0,
      reliefApplied: false,
      reliefAmount: 0,
      vatExempt: true,
      total: 0,
    };
  }

  // one share's breakdown; the UI multiplies it out for the reader
  const rows = computeBandRows(price / purchasers, config.bands);
  const perShareGross = round2(rows.reduce((s, r) => s + r.fee, 0));
  const gross = round2(perShareGross * purchasers);
  const reliefAmount = opts.relief ? round2(gross * config.relief_pct) : 0;

  return {
    rows,
    purchasers,
    perShareGross,
    gross,
    reliefApplied: opts.relief,
    reliefAmount,
    vatExempt: false,
    total: round2(gross - reliefAmount),
  };
}

export interface StampDutyResult {
  rows: BandRow[];
  uncapped: number;
  capApplied: boolean;
  cap: number | null;
  total: number;
}

export function computeStampDuty(price: number, config: StampDutyConfig): StampDutyResult {
  const rows = computeBandRows(price, config.bands);
  const uncapped = round2(rows.reduce((s, r) => s + r.fee, 0));
  const capApplied = config.cap !== null && uncapped > config.cap;
  return {
    rows,
    uncapped,
    capApplied,
    cap: config.cap,
    total: capApplied ? config.cap! : uncapped,
  };
}
