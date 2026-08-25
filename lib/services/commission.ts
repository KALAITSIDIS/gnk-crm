/**
 * The arithmetic between asking price, owner net and commission
 * (BACKLOG: *Owner net ↔ asking ↔ commission, shown, S*).
 *
 * PURE. No I/O — this decides what an agent may accept, so it is worth testing
 * exhaustively rather than eyeballing on a form.
 *
 * THE PRICING SECTION SHOWS THREE NUMBERS SIDE BY SIDE AND NO RELATIONSHIP
 * BETWEEN THEM: "Asking price", "Min acceptable" and "Owner net". They are not
 * independent. `min_acceptable` is a SALE price, `owner_net` is what the owner
 * must actually receive, and the thing connecting them is the commission on the
 * mandate — which lives on a different table and is masked from most readers.
 * So the one question an agent needs answered mid-negotiation, *what is the
 * lowest I can take*, required arithmetic nobody had done.
 *
 * ============================================================================
 * THE FLOOR
 *
 *   sale × (1 − pct/100) = owner net        (the agency takes pct of the sale)
 *   ⇒ floor = owner net / (1 − pct/100)
 *
 * Not `owner net + commission`, which is the tempting version and is WRONG:
 * commission is charged on the SALE price, not on the owner's net, so adding it
 * to the net undercharges. At 5% on a €200.000 net the naive sum gives
 * €210.000, which after commission returns €199.500 — five hundred euro short
 * of the number the owner was promised. The division is the correct inverse.
 * ============================================================================
 *
 * VAT ON COMMISSION IS NOT MODELLED. Cyprus charges VAT on agency fees, which
 * would raise the floor further. The calculators own VAT and `cyprus_config`
 * owns the rates; duplicating either here would create the second, drifting
 * copy this repo keeps being bitten by. The UI says the figure is before VAT
 * rather than quietly implying otherwise.
 *
 * WHO SEES IT is decided upstream and not re-implemented here: `commission_pct`
 * arrives from `mandates_safe`, which returns NULL unless the caller is an admin
 * or the property's assigned agent. A null percentage yields a breakdown with
 * nothing derived, so a listing manager sees the prices and no commission — the
 * masking IS the gate.
 */

export interface PricingInput {
  /** `numeric` reaches PostgREST as a STRING */
  askingPrice: number | string | null;
  minAcceptablePrice: number | string | null;
  ownerNetPrice: number | string | null;
  /** from `mandates_safe` — null means masked, or no active mandate */
  commissionPct: number | string | null;
}

export interface PricingBreakdown {
  commissionPct: number | null;
  asking: number | null;
  minAcceptable: number | null;
  ownerNetTarget: number | null;
  /** commission the agency earns at the asking price */
  commissionAtAsking: number | null;
  /** what the owner actually receives if it sells at asking */
  ownerNetsAtAsking: number | null;
  /** lowest sale price that still delivers `ownerNetTarget` */
  floor: number | null;
  /** how far `minAcceptable` falls short of the owner's net, in euro */
  minAcceptableShortfall: number | null;
  /** how far the ASKING price falls short — worse, and worth saying so */
  askingShortfall: number | null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** `numeric` arrives as a string; `0` is meaningful and must survive. */
const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return Number.isFinite(n) ? n : null;
};

export function computePricing(input: PricingInput): PricingBreakdown {
  const asking = num(input.askingPrice);
  const minAcceptable = num(input.minAcceptablePrice);
  const ownerNetTarget = num(input.ownerNetPrice);
  const rawPct = num(input.commissionPct);

  // A negative percentage is nonsense and 100+ means the agency takes the whole
  // sale, which has no floor to compute — both are refused rather than allowed
  // to produce a negative or infinite "floor" that looks like an answer.
  const commissionPct = rawPct !== null && rawPct >= 0 && rawPct < 100 ? rawPct : null;
  const retained = commissionPct === null ? null : 1 - commissionPct / 100;

  const commissionAtAsking =
    asking !== null && commissionPct !== null ? round2((asking * commissionPct) / 100) : null;

  const ownerNetsAtAsking =
    asking !== null && commissionAtAsking !== null ? round2(asking - commissionAtAsking) : null;

  const floor =
    ownerNetTarget !== null && retained !== null && retained > 0
      ? round2(ownerNetTarget / retained)
      : null;

  const shortfall = (sale: number | null): number | null => {
    if (sale === null || retained === null || ownerNetTarget === null) return null;
    const delivered = sale * retained;
    const gap = round2(ownerNetTarget - delivered);
    return gap > 0 ? gap : null;
  };

  return {
    commissionPct,
    asking,
    minAcceptable,
    ownerNetTarget,
    commissionAtAsking,
    ownerNetsAtAsking,
    floor,
    minAcceptableShortfall: shortfall(minAcceptable),
    askingShortfall: shortfall(asking),
  };
}

/** True when there is anything derived worth rendering. */
export function hasPricingInsight(b: PricingBreakdown): boolean {
  return b.commissionAtAsking !== null || b.floor !== null;
}
