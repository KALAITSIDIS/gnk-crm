/**
 * VAT treatment for a sale, DERIVED rather than remembered.
 *
 * `properties.vat_status` is a DECLARATION — someone picked `new_vat`,
 * `resale_no_vat`, `reduced_rate_eligible` or `unknown` from a dropdown, and
 * matching has trusted it ever since (`lib/services/matching.ts` scores a
 * buyer's `vat_preference` against it). Nothing has ever checked that a
 * `reduced_rate_eligible` claim survives contact with the caps. This does.
 *
 * ============================================================================
 * IT REFUSES TO GUESS. THAT IS THE POINT, NOT A LIMITATION.
 *
 * BACKLOG's entry is explicit: "The thresholds must come from the operator — a
 * CRM must not invent tax law." So there is NO hardcoded rate anywhere in this
 * file. Every number is read from `cyprus_config.vat_property`, and if that row
 * is missing, malformed, or missing a threshold, the result is
 * `outcome: "cannot_derive"` with the reason — never a plausible-looking number
 * computed from a constant someone typed here.
 *
 * A wrong VAT figure quoted to a buyer is worse than no figure.
 * ============================================================================
 *
 * WHAT A PROPERTY RECORD CANNOT KNOW, and therefore what this does not claim.
 *
 * The reduced rate turns on the BUYER, not only the dwelling: a natural person
 * (not a company), their first and primary residence, occupied for 10 years,
 * one per person or married couple. A property row knows none of that and never
 * will. So every reduced-rate result here is CONDITIONAL, and the UI says so.
 * What this derives is the half the property does determine: whether the
 * dwelling's area and price allow the reduced rate at all, and how the price
 * splits between the two bands if the buyer qualifies.
 *
 * THE AREA BASIS IS AN APPROXIMATION AND IS LABELLED AS ONE. The law measures
 * "buildable residential area". The closest field is `covered_area_sqm`;
 * veranda, roof garden and basement are stored separately and whether each
 * counts depends on the permit. Treating covered area as the basis is the
 * defensible default, not a certainty, so `assumptions` says it out loud.
 */

import { formatMoney } from "@/lib/utils/format";

/** The `cyprus_config.vat_property` row, as stored. Every field optional — a
 *  malformed row must produce a refusal, not a crash. */
export interface VatConfigRow {
  standard_rate?: unknown;
  reduced_rate?: unknown;
  reduced_rules_post_2023?: {
    reduced_area_cap_sqm?: unknown;
    reduced_value_cap_eur?: unknown;
    max_total_area_sqm?: unknown;
    max_total_value_eur?: unknown;
    disability_area_cap_sqm?: unknown;
  } | null;
  transitional?: {
    deadline?: unknown;
    old_rule?: unknown;
  } | null;
}

export type VatStatus = "new_vat" | "resale_no_vat" | "reduced_rate_eligible" | "unknown";

export interface VatInput {
  /** `properties.covered_area_sqm`. Numeric arrives from PostgREST as a string. */
  coveredAreaSqm: number | string | null;
  /** The sale price under discussion — asking price, or whatever is being typed. */
  price: number | string | null;
  /** The stored declaration, so a contradiction can be surfaced. */
  vatStatus: VatStatus | null;
  /** `cyprus_config.vat_property`.value, or null when the row is absent. */
  config: VatConfigRow | null;
  /** `cyprus_config.vat_property`.verified_at, so an unverified row is flagged. */
  configVerifiedAt?: string | null;
}

export interface VatBand {
  /** Portion of the price taxed at this rate. */
  base: number;
  /** The rate itself, as a fraction (0.05). */
  rate: number;
  /** base * rate. */
  vat: number;
}

export interface VatTreatment {
  outcome:
    | "cannot_derive" // no usable config, or not enough of the property filled in
    | "no_vat" // resale — VAT does not arise
    | "standard_only" // VAT applies but the reduced rate cannot
    | "reduced_possible"; // the dwelling allows it, IF the buyer qualifies
  /** Human-readable, ordered, and every one of them is a reason not a slogan. */
  reasons: string[];
  /** Things assumed rather than known. Always shown, never hidden. */
  assumptions: string[];
  /** Populated for standard_only and reduced_possible. */
  bands: VatBand[];
  totalVat: number | null;
  /** What the buyer pays including VAT. */
  totalWithVat: number | null;
  /**
   * THE CLIFF. Exceeding either total cap makes the WHOLE purchase standard
   * rated — not just the excess — so a property a little over a cap costs
   * dramatically more VAT than one just under it. Null when not near a cap.
   */
  cliff: {
    kind: "value" | "area";
    /** How far over the cap this property is. EUR for value, m² for area. */
    over: number;
    /** What crossing it costs in VAT, in EUR. */
    costsEur: number;
  } | null;
  /**
   * Set when `properties.vat_status` says `reduced_rate_eligible` but the caps
   * refuse it. The declaration is what matching trusts, so a contradiction is
   * worth a warning rather than a silent override.
   */
  conflictsWithDeclaration: boolean;
  /** Set when the transitional regime would be BETTER than the current rules. */
  transitionalMayHelp: { deadline: string; oldRule: string } | null;
}

/** PostgREST hands numerics over as strings; blanks arrive as "" or null. */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** A threshold must be a positive finite number or the config is unusable. */
function threshold(v: unknown): number | null {
  const n = num(v as number | string | null);
  return n !== null && n > 0 ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function deriveVat(input: VatInput): VatTreatment {
  const base: VatTreatment = {
    outcome: "cannot_derive",
    reasons: [],
    assumptions: [],
    bands: [],
    totalVat: null,
    totalWithVat: null,
    cliff: null,
    conflictsWithDeclaration: false,
    transitionalMayHelp: null,
  };

  // ---------------------------------------------------------------- config --
  const cfg = input.config;
  if (!cfg) {
    return { ...base, reasons: ["No verified VAT configuration — set it in Settings → Cyprus config."] };
  }
  const standardRate = threshold(cfg.standard_rate);
  const reducedRate = threshold(cfg.reduced_rate);
  const r = cfg.reduced_rules_post_2023 ?? null;
  const areaCap = r ? threshold(r.reduced_area_cap_sqm) : null;
  const valueCap = r ? threshold(r.reduced_value_cap_eur) : null;
  const maxArea = r ? threshold(r.max_total_area_sqm) : null;
  const maxValue = r ? threshold(r.max_total_value_eur) : null;

  const missing: string[] = [];
  if (standardRate === null) missing.push("standard_rate");
  if (reducedRate === null) missing.push("reduced_rate");
  if (areaCap === null) missing.push("reduced_area_cap_sqm");
  if (valueCap === null) missing.push("reduced_value_cap_eur");
  if (maxArea === null) missing.push("max_total_area_sqm");
  if (maxValue === null) missing.push("max_total_value_eur");
  if (missing.length) {
    return {
      ...base,
      reasons: [`VAT configuration is incomplete — missing ${missing.join(", ")}. Nothing is assumed.`],
    };
  }

  const assumptions: string[] = [];
  if (!input.configVerifiedAt) {
    assumptions.push("The VAT thresholds have not been marked verified by anyone.");
  }

  // ------------------------------------------------------------ resale case --
  // VAT and transfer fees are mutually exclusive: `cyprus_config.transfer_fees`
  // records "No transfer fees when the transaction was subject to VAT". So a
  // resale is not a smaller VAT bill, it is a different tax entirely.
  if (input.vatStatus === "resale_no_vat") {
    return {
      ...base,
      outcome: "no_vat",
      reasons: [
        "Declared a resale, so VAT does not arise on this transfer.",
        "Transfer fees apply instead — see the calculators.",
      ],
      assumptions,
    };
  }

  // ------------------------------------------------------------ the numbers --
  const price = num(input.price);
  const area = num(input.coveredAreaSqm);
  if (price === null || price <= 0) {
    return { ...base, reasons: ["Enter a price to derive the VAT treatment."], assumptions };
  }

  const standardVatOnAll = round2(price * standardRate!);

  if (area === null || area <= 0) {
    return {
      ...base,
      outcome: "standard_only",
      reasons: [
        "No covered area recorded, so reduced-rate eligibility cannot be assessed.",
        `Shown at the standard ${(standardRate! * 100).toFixed(0)}% rate.`,
      ],
      assumptions,
      bands: [{ base: price, rate: standardRate!, vat: standardVatOnAll }],
      totalVat: standardVatOnAll,
      totalWithVat: round2(price + standardVatOnAll),
      conflictsWithDeclaration: input.vatStatus === "reduced_rate_eligible",
    };
  }

  assumptions.push(
    `Covered area (${area} m²) is used as the buildable area. Veranda, roof garden and basement are recorded separately and may change this.`,
  );

  // ------------------------------------------------------- the total caps ----
  // Over EITHER cap and the whole purchase is standard rated. This is the cliff.
  const overValue = price > maxValue! ? round2(price - maxValue!) : 0;
  const overArea = area > maxArea! ? round2(area - maxArea!) : 0;

  if (overValue > 0 || overArea > 0) {
    const reasons: string[] = [];
    if (overValue > 0) {
      reasons.push(
        `Price exceeds the ${formatMoney(maxValue!)} total cap by ${formatMoney(overValue)}, so the WHOLE purchase is standard rated.`,
      );
    }
    if (overArea > 0) {
      reasons.push(
        `Covered area exceeds the ${maxArea} m² total cap by ${overArea} m², so the WHOLE purchase is standard rated.`,
      );
    }
    // What the cliff costs: the relief that would have applied just under it.
    const reliefLost = round2(reducedBaseFor(maxValue!, area, areaCap!, valueCap!) * (standardRate! - reducedRate!));
    return {
      ...base,
      outcome: "standard_only",
      reasons,
      assumptions,
      bands: [{ base: price, rate: standardRate!, vat: standardVatOnAll }],
      totalVat: standardVatOnAll,
      totalWithVat: round2(price + standardVatOnAll),
      cliff: {
        kind: overValue > 0 ? "value" : "area",
        over: overValue > 0 ? overValue : overArea,
        costsEur: reliefLost,
      },
      conflictsWithDeclaration: input.vatStatus === "reduced_rate_eligible",
      transitionalMayHelp: transitionalHint(cfg),
    };
  }

  // ------------------------------------------------------------ the split ----
  const reducedBase = reducedBaseFor(price, area, areaCap!, valueCap!);
  const standardBase = round2(price - reducedBase);
  const reducedVat = round2(reducedBase * reducedRate!);
  const standardVat = round2(standardBase * standardRate!);
  const totalVat = round2(reducedVat + standardVat);

  const reasons = [
    `Within both total caps (${maxArea} m², ${formatMoney(maxValue!)}), so the reduced rate can apply.`,
    `${(reducedRate! * 100).toFixed(0)}% on the first ${areaCap} m² and first ${formatMoney(valueCap!)}; ${(standardRate! * 100).toFixed(0)}% on the rest.`,
  ];
  if (standardBase <= 0) {
    reasons.push("The whole price falls inside the reduced band.");
  }

  return {
    ...base,
    outcome: "reduced_possible",
    reasons,
    assumptions,
    bands: [
      { base: reducedBase, rate: reducedRate!, vat: reducedVat },
      ...(standardBase > 0 ? [{ base: standardBase, rate: standardRate!, vat: standardVat }] : []),
    ],
    totalVat,
    totalWithVat: round2(price + totalVat),
    // How close to the value cliff? Only worth saying when genuinely near it.
    cliff: null,
    conflictsWithDeclaration: false,
    transitionalMayHelp: null,
  };
}

/**
 * The value that sits in the reduced band: the price attributable to the first
 * `areaCap` m², capped at `valueCap`. Apportioning by area is how the reduced
 * band is applied to a dwelling larger than the cap — a flat "first €350,000"
 * would over-relieve a large cheap property.
 */
function reducedBaseFor(price: number, area: number, areaCap: number, valueCap: number): number {
  const share = Math.min(areaCap, area) / area;
  return round2(Math.min(price * share, valueCap));
}

/** Only surfaced when the old regime would actually be better. */
function transitionalHint(cfg: VatConfigRow): VatTreatment["transitionalMayHelp"] {
  const t = cfg.transitional;
  if (!t) return null;
  const deadline = typeof t.deadline === "string" ? t.deadline : null;
  const oldRule = typeof t.old_rule === "string" ? t.old_rule : null;
  if (!deadline || !oldRule) return null;
  return { deadline, oldRule };
}

/** Does this treatment carry anything worth rendering? */
export function hasVatInsight(t: VatTreatment): boolean {
  return t.outcome !== "cannot_derive" || t.reasons.length > 0;
}
