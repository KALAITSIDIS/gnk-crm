/**
 * Cyprus purchase-cost calculators (T5.1, doc 02 §C8). Pure functions over
 * the `cyprus_config` JSON — rates are NEVER hardcoded (guardrail 5); a config
 * edit in Settings changes results with no deploy. All amounts in EUR; fees
 * rounded to cents per band.
 *
 * WHETHER THE SALE IS SUBJECT TO VAT IS A SCENARIO, NAMED (F01). Transfer
 * fees and VAT are mutually exclusive, so every transfer-fee figure rests on
 * an answer to "is this sale subject to VAT?". The calculator used to assume
 * "no" silently, and its tick said "VAT was paid" — a different fact. Now the
 * answer is an explicit `VatApplicability`, opened from the property's stored
 * declaration when there is one (`vatApplicability` in ./vat), and every
 * copied summary says which scenario it is.
 */

import type { VatApplicability } from "@/lib/services/vat";
import { formatDate, formatMoney } from "@/lib/utils/format";

export interface FeeBand {
  /** inclusive upper bound of the band; null = open-ended top band */
  up_to: number | null;
  rate: number;
}

export interface TransferFeesConfig {
  bands: FeeBand[];
  relief_pct: number;
  /**
   * The stored key keeps its historical name: it means "a transfer SUBJECT TO
   * VAT owes no transfer fee" (its own `vat_paid_note`: "No transfer fees
   * when the transaction was subject to VAT"). Renaming it would need a
   * migration and buy nothing; the code says `subjectToVat`.
   */
  vat_paid_exempt: boolean;
  /** the config's own wording for the exemption, shown under the scenario choice */
  vat_paid_note?: string;
}

export interface StampAbolition {
  /** ISO date; documents signed on or after this date owe no stamp duty */
  from: string;
  /** the repealing law, quoted verbatim in the UI (e.g. "Law 239(I)/2025") */
  law: string;
  note?: string;
}

export interface StampDutyConfig {
  bands: FeeBand[];
  cap: number | null;
  /**
   * Present once the duty is repealed (Law 239(I)/2025, from 2026-01-01): the
   * calculator renders this notice INSTEAD of a figure. The bands stay — they
   * remain the correct scale for contracts signed before `from`.
   */
  abolished?: StampAbolition | null;
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
  // the note is prose: absent or not a string, it is simply not shown — it
  // never decides a figure, so it never fails the config
  const note = typeof v.vat_paid_note === "string" ? v.vat_paid_note.trim() : "";
  return {
    bands: v.bands,
    relief_pct: v.relief_pct,
    vat_paid_exempt: v.vat_paid_exempt === true,
    ...(note ? { vat_paid_note: note } : {}),
  };
}

export function parseStampDutyConfig(value: unknown): StampDutyConfig | null {
  const v = value as Partial<StampDutyConfig> | null;
  if (!v || !isBandArray(v.bands)) return null;
  if (v.cap !== undefined && v.cap !== null) {
    if (typeof v.cap !== "number" || !Number.isFinite(v.cap) || v.cap < 0) return null;
  }

  // A malformed abolition block fails the WHOLE config rather than being
  // ignored: silently dropping it would quote a repealed tax, which is the
  // exact failure the field exists to prevent.
  let abolished: StampAbolition | null = null;
  if (v.abolished !== undefined && v.abolished !== null) {
    const a = v.abolished as Partial<StampAbolition>;
    if (typeof a.from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.from)) return null;
    if (typeof a.law !== "string" || a.law.trim().length === 0) return null;
    abolished = {
      from: a.from,
      law: a.law,
      ...(typeof a.note === "string" && a.note ? { note: a.note } : {}),
    };
  }

  return { bands: v.bands, cap: typeof v.cap === "number" ? v.cap : null, abolished };
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
  /** `subjectToVat`: the transfer is subject to VAT (not "VAT was paid" — F01) */
  opts: { relief: boolean; subjectToVat: boolean; purchasers?: number },
): TransferFeesResult {
  const purchasers = normalisePurchasers(opts.purchasers);

  if (opts.subjectToVat && config.vat_paid_exempt) {
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

/* ------------------------------------------- the VAT scenario (F01) ---- */

/**
 * The property the calculators were opened on — what the page could read
 * through the viewer's own RLS. Absent when there is no `property=` link, the
 * id is malformed, the row is not visible, or the read failed: the calculator
 * then works exactly as a bare one.
 */
export interface CalculatorPropertyContext {
  id: string;
  reference: string;
  /** "land", "apartment", "project · building" */
  typeLabel: string;
  /** the stored status in words (VAT_STATUS_LABELS) */
  vatStatusLabel: string;
  /** `vatApplicability(vat_status)` — the scenario the calculator opens on */
  scenario: VatApplicability;
}

/**
 * The choice on screen, in the order offered. A bare /calculators opens on
 * the first — today's default, with today's figures, now named as a scenario.
 */
export const VAT_SCENARIOS: readonly VatApplicability[] = ["does_not_apply", "applies", "unconfirmed"];

/** What the agent picks. "Subject to VAT", the config's own words — never "paid". */
export const VAT_SCENARIO_LABELS: Record<VatApplicability, string> = {
  does_not_apply: "Not subject to VAT (e.g. resale)",
  applies: "Subject to VAT (e.g. new build)",
  unconfirmed: "Not confirmed",
};

/** The "Scenario:" line every copied transfer-fee summary carries. */
export const SUMMARY_SCENARIO: Record<VatApplicability, string> = {
  does_not_apply: "not subject to VAT",
  applies: "subject to VAT",
  unconfirmed: "VAT status not confirmed — confirm before quoting",
};

export interface TransferScenario {
  scenario: VatApplicability;
  /**
   * The breakdown the card leads with: the subject-to-VAT assessment for
   * "applies", the not-subject one otherwise.
   */
  primary: TransferFeesResult;
  /**
   * "unconfirmed" only: the other branch — what is owed if the sale IS
   * subject to VAT (nil under the seeded config). Both are shown, because
   * neither is known to be the one that applies.
   */
  ifSubject: TransferFeesResult | null;
}

export function computeTransferScenario(
  price: number,
  config: TransferFeesConfig,
  opts: { relief: boolean; purchasers?: number; scenario: VatApplicability },
): TransferScenario {
  const subject = computeTransferFees(price, config, {
    relief: opts.relief,
    subjectToVat: true,
    purchasers: opts.purchasers,
  });
  if (opts.scenario === "applies") return { scenario: "applies", primary: subject, ifSubject: null };
  const notSubject = computeTransferFees(price, config, {
    relief: opts.relief,
    subjectToVat: false,
    purchasers: opts.purchasers,
  });
  return {
    scenario: opts.scenario,
    primary: notSubject,
    ifSubject: opts.scenario === "unconfirmed" ? subject : null,
  };
}

/* ------------------------------------------------ copied summaries ---- */

export function pct(rate: number): string {
  return `${(rate * 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
}

export function bandLabel(b: BandRow): string {
  return b.to === null
    ? `above ${formatMoney(b.from)}`
    : `${formatMoney(b.from)} – ${formatMoney(b.to)}`;
}

/**
 * CALC-2: a pasted summary dates itself the way the screen does — an undated
 * quote in a WhatsApp thread outlives every rate change. "Computed" is the
 * moment of copying, Cyprus-zoned via formatDate like everything else.
 */
export function summaryTail(verifiedAt: string | null, computedAt: Date | string): string {
  return `Rates verified ${verifiedAt ? formatDate(verifiedAt) : "never"} · computed ${formatDate(
    computedAt,
  )} — verify current legislation.`;
}

export interface SummaryMeta {
  /** The property's reference, when the calculators were opened on one. */
  reference: string | null;
  verifiedAt: string | null;
  computedAt: Date | string;
}

function breakdownLines(price: number, r: TransferFeesResult, totalLabel: string): string[] {
  const joint = r.purchasers > 1;
  return [
    ...(joint ? [`Assessed per purchaser on ${formatMoney(price / r.purchasers)} each:`] : []),
    ...r.rows.map((b) => `  ${bandLabel(b)} @ ${pct(b.rate)} = ${formatMoney(b.fee)}`),
    ...(joint
      ? [
          `Per purchaser: ${formatMoney(r.perShareGross)}`,
          `× ${r.purchasers} purchasers = ${formatMoney(r.gross)}`,
        ]
      : [`Gross: ${formatMoney(r.gross)}`]),
    ...(r.reliefApplied ? [`50% relief: −${formatMoney(r.reliefAmount)}`] : []),
    `${totalLabel}: ${formatMoney(r.total)}`,
  ];
}

/**
 * The transfer-fee summary that reaches a buyer. It names the property and
 * the VAT scenario it assumes; an unconfirmed one carries BOTH branches and
 * no unqualified "Total:" line, so a pasted quote can never present the
 * not-subject figure as the answer.
 */
export function buildTransferSummary(price: number, s: TransferScenario, meta: SummaryMeta): string {
  const r = s.primary;
  const lines = [
    `Transfer fees for ${formatMoney(price)}${meta.reference ? ` — ${meta.reference}` : ""}` +
      (r.purchasers > 1 ? ` (${r.purchasers} purchasers):` : ":"),
    `Scenario: ${SUMMARY_SCENARIO[s.scenario]}`,
  ];
  if (s.scenario === "unconfirmed" && s.ifSubject) {
    lines.push(
      s.ifSubject.vatExempt
        ? "If subject to VAT: no transfer fees."
        : `If subject to VAT: ${formatMoney(s.ifSubject.total)}.`,
      "If not subject to VAT:",
      ...breakdownLines(price, r, "Total (if not subject to VAT)"),
    );
  } else if (r.vatExempt) {
    lines.push("No transfer fees — the transaction is subject to VAT.");
  } else {
    lines.push(...breakdownLines(price, r, "Total"));
  }
  lines.push(summaryTail(meta.verifiedAt, meta.computedAt));
  return lines.join("\n");
}

/**
 * The stamp-duty summary. Under an abolition it explains the repeal and
 * carries no total (Law 239(I)/2025); otherwise the pre-abolition scale.
 * Null when there is nothing to say yet (no price, and the duty applies).
 */
export function buildStampSummary(
  price: number | null,
  config: StampDutyConfig,
  meta: SummaryMeta,
): string | null {
  const ref = meta.reference;
  if (config.abolished) {
    return [
      `Stamp duty${ref ? ` for ${ref}` : ""}: none — abolished for documents signed on or after ${formatDate(config.abolished.from)} (${config.abolished.law}).`,
      "Contracts signed before that date follow the previous bands.",
      summaryTail(meta.verifiedAt, meta.computedAt),
    ].join("\n");
  }
  if (price === null || !(price > 0)) return null;
  const stamp = computeStampDuty(price, config);
  return [
    `Stamp duty for ${formatMoney(price)}${ref ? ` — ${ref}` : ""}:`,
    ...stamp.rows.map((b) => `  ${bandLabel(b)} @ ${pct(b.rate)} = ${formatMoney(b.fee)}`),
    ...(stamp.capApplied
      ? [`Uncapped: ${formatMoney(stamp.uncapped)} → capped at ${formatMoney(stamp.cap)}`]
      : []),
    `Total: ${formatMoney(stamp.total)}`,
    summaryTail(meta.verifiedAt, meta.computedAt),
  ].join("\n");
}
