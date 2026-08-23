/**
 * Buyer ↔ property matching (0043, T-B5).
 *
 * PURE. No I/O, no Supabase, no next-intl. Fetching candidates is
 * lib/queries/matches.ts's job; this module decides and explains. That split is
 * what makes the rules exhaustively unit-testable without a database, and it is
 * why both directions — buyer→properties and property→buyers — can share one
 * implementation instead of drifting into two.
 *
 * TWO KINDS OF CRITERION, and the distinction is the whole design:
 *
 *   HARD (a `blocker`)  — a miss disqualifies. Reserved for things a buyer
 *                         would refuse outright: wrong transaction, wrong type,
 *                         wrong district, off-market, no separate deed when one
 *                         was demanded, or a price beyond the tolerance below.
 *   SOFT (a `miss`)     — reduces the score and is NAMED. Everything else.
 *
 * THE SCORE IS NEVER STORED. `quality_score` is stored, and
 * lib/services/quality-score.ts carries a standing warning that changing a
 * weight makes every stored value stale, plus a script to repair it. Scores
 * here are computed on read, so weights below may be changed freely and no
 * backfill exists to forget. Do not add a score column.
 *
 * IT ALWAYS RETURNS ITS REASONING. `blockers`, `misses` and `hits` are the
 * point, not the number: an unexplained score is a number nobody acts on, and
 * the UI renders the misses as plain-language chips beside every row.
 */

export type TransactionType = "sale" | "rent" | "sale_or_rent";
export type PropertyStatus =
  | "draft"
  | "available"
  | "reserved"
  | "under_offer"
  | "sold"
  | "rented"
  | "withdrawn";
export type TitleDeedStatus = "separate" | "pending" | "shared" | "none" | "unknown";
export type VatStatus = "new_vat" | "resale_no_vat" | "reduced_rate_eligible" | "unknown";

/** One saved buyer search. Mirrors a `buyer_requirements` row, minus bookkeeping. */
export interface MatchRequirement {
  transaction_type: TransactionType;
  property_types: string[];
  district_ids: string[];
  area_ids: string[];
  budget_min: number | null;
  budget_max: number | null;
  bedrooms_min: number | null;
  bedrooms_max: number | null;
  bathrooms_min: number | null;
  covered_area_min_sqm: number | null;
  plot_area_min_sqm: number | null;
  title_deed_required: boolean;
  vat_preference: VatStatus | null;
  max_sea_distance_m: number | null;
  delivery_by: string | null;
  features_required: string[];
}

/** The columns of a property this module needs. */
export interface MatchCandidate {
  id: string;
  status: PropertyStatus;
  transaction_type: TransactionType;
  property_type: string;
  district_id: string | null;
  area_id: string | null;
  asking_price: number | null;
  rent_price_month: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  covered_area_sqm: number | null;
  plot_area_sqm: number | null;
  title_deed_status: TitleDeedStatus;
  vat_status: VatStatus;
  sea_distance_m: number | null;
  delivery_date: string | null;
  features: string[];
}

export type MatchReason =
  | { code: "status"; got: PropertyStatus }
  | { code: "status_not_available"; got: PropertyStatus }
  | { code: "transaction_type"; wanted: TransactionType; got: TransactionType }
  | { code: "property_type"; wanted: string[]; got: string }
  | { code: "district"; wanted: string[]; got: string | null }
  | { code: "area"; wanted: string[]; got: string | null }
  | { code: "budget"; max: number; got: number; overBy: number }
  | { code: "budget_bracket"; min: number; got: number }
  | { code: "price_unknown" }
  | { code: "bedrooms"; min: number | null; max: number | null; got: number | null }
  | { code: "bathrooms"; min: number; got: number | null }
  | { code: "covered_area"; min: number; got: number | null }
  | { code: "plot_area"; min: number; got: number | null }
  | { code: "title_deed"; got: TitleDeedStatus }
  | { code: "sea_distance"; max: number; got: number | null }
  | { code: "delivery"; by: string; got: string | null }
  | { code: "vat"; wanted: VatStatus; got: VatStatus }
  | { code: "feature"; feature: string };

export interface MatchVerdict {
  /** false when any hard filter failed; `score` is then 0 */
  eligible: boolean;
  /** 0–100, whole numbers: points earned over points APPLICABLE */
  score: number;
  blockers: MatchReason[];
  misses: MatchReason[];
  hits: MatchReason[];
}

/**
 * How far over `budget_max` still counts as a match, as a percentage.
 *
 * NOT ZERO, deliberately. A €5.000 overshoot on a €300.000 budget is a
 * negotiation, and a matcher that silently drops it is worse than no matcher —
 * the desk would never learn the property existed. Anything inside the
 * tolerance is eligible AND carries a `budget` miss saying how much over, so
 * the agent sees the number rather than a filtered-out row.
 *
 * The boundary is INCLUSIVE: exactly 10% over matches. Asserted in the tests so
 * it cannot be moved by accident.
 */
export const BUDGET_TOLERANCE_PCT = 10;

/**
 * Soft-criterion weights. Relative, not absolute — the score divides by the
 * weight that APPLIED, so a requirement stating little is not punished for it.
 *
 * Safe to change: nothing is stored (see the module header).
 */
export const MATCH_WEIGHTS = {
  /** the sharpest signal a buyer gives after district — they named a village */
  area: 25,
  /** inside budget with nothing to negotiate */
  budgetComfort: 15,
  /** at or above the floor they said they'd spend, i.e. the right bracket */
  budgetBracket: 5,
  bathrooms: 10,
  coveredArea: 15,
  plotArea: 10,
  seaDistance: 10,
  delivery: 10,
  vat: 5,
  /** shared pro-rata across every feature the requirement lists */
  features: 15,
  /** ranks an available property above an equivalent one reserved or under offer */
  availableNow: 10,
} as const;

/**
 * Statuses a match may return. `reserved` and `under_offer` are IN: a Cyprus
 * chain falls through often enough that hiding them costs the desk real
 * options. They rank below `available` via the `availableNow` weight rather
 * than being excluded — a ranking problem solved by ranking, not by filtering.
 */
const MATCHABLE_STATUSES: readonly PropertyStatus[] = ["available", "reserved", "under_offer"];

/** `sale_or_rent` satisfies both sides; anything else must agree exactly. */
function transactionCompatible(want: TransactionType, got: TransactionType): boolean {
  if (want === "sale_or_rent" || got === "sale_or_rent") return true;
  return want === got;
}

/**
 * The price to compare against the budget.
 *
 * A rental requirement must read `rent_price_month`. Reading `asking_price`
 * would compare €250.000 against a €1.500 budget and reject every rental in the
 * database — a whole transaction type silently returning nothing.
 */
function priceFor(req: MatchRequirement, c: MatchCandidate): number | null {
  const raw = req.transaction_type === "rent" ? c.rent_price_month : c.asking_price;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const num = (v: number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function matchProperty(req: MatchRequirement, c: MatchCandidate): MatchVerdict {
  const blockers: MatchReason[] = [];
  const misses: MatchReason[] = [];
  const hits: MatchReason[] = [];

  // ---------------------------------------------------------------- hard ----
  if (!MATCHABLE_STATUSES.includes(c.status)) {
    blockers.push({ code: "status", got: c.status });
  }

  if (!transactionCompatible(req.transaction_type, c.transaction_type)) {
    blockers.push({
      code: "transaction_type",
      wanted: req.transaction_type,
      got: c.transaction_type,
    });
  }

  // An empty list is "no opinion", never "matches nothing".
  if (req.property_types.length > 0 && !req.property_types.includes(c.property_type)) {
    blockers.push({ code: "property_type", wanted: req.property_types, got: c.property_type });
  }

  if (
    req.district_ids.length > 0 &&
    (c.district_id === null || !req.district_ids.includes(c.district_id))
  ) {
    blockers.push({ code: "district", wanted: req.district_ids, got: c.district_id });
  }

  const beds = num(c.bedrooms);
  const bedsMin = num(req.bedrooms_min);
  const bedsMax = num(req.bedrooms_max);
  if (bedsMin !== null || bedsMax !== null) {
    // A null bedroom count (land, a shop) does not satisfy a bedroom demand.
    const fails =
      beds === null || (bedsMin !== null && beds < bedsMin) || (bedsMax !== null && beds > bedsMax);
    if (fails) {
      blockers.push({ code: "bedrooms", min: bedsMin, max: bedsMax, got: beds });
    }
  }

  if (req.title_deed_required && c.title_deed_status !== "separate") {
    blockers.push({ code: "title_deed", got: c.title_deed_status });
  }

  const price = priceFor(req, c);
  const budgetMax = num(req.budget_max);
  if (budgetMax !== null && price !== null) {
    const ceiling = budgetMax * (1 + BUDGET_TOLERANCE_PCT / 100);
    if (price > ceiling) {
      blockers.push({
        code: "budget",
        max: budgetMax,
        got: price,
        overBy: Math.round(price - budgetMax),
      });
    }
  }

  if (blockers.length > 0) {
    return { eligible: false, score: 0, blockers, misses, hits };
  }

  // ---------------------------------------------------------------- soft ----
  let earned = 0;
  let applicable = 0;

  const judge = (weight: number, ok: boolean, reason: MatchReason) => {
    applicable += weight;
    if (ok) {
      earned += weight;
      hits.push(reason);
    } else {
      misses.push(reason);
    }
  };

  if (req.area_ids.length > 0) {
    judge(MATCH_WEIGHTS.area, c.area_id !== null && req.area_ids.includes(c.area_id), {
      code: "area",
      wanted: req.area_ids,
      got: c.area_id,
    });
  }

  if (budgetMax !== null) {
    if (price === null) {
      // Unpriced units are real — 0041's availability demo ships one on
      // purpose. Dropping them from every budgeted search would hide live
      // inventory, so this costs the comfort points and names the gap instead.
      applicable += MATCH_WEIGHTS.budgetComfort;
      misses.push({ code: "price_unknown" });
    } else {
      const over = price - budgetMax;
      judge(MATCH_WEIGHTS.budgetComfort, over <= 0, {
        code: "budget",
        max: budgetMax,
        got: price,
        overBy: Math.round(Math.max(over, 0)),
      });
    }
  }

  const budgetMin = num(req.budget_min);
  if (budgetMin !== null && price !== null) {
    judge(MATCH_WEIGHTS.budgetBracket, price >= budgetMin, {
      code: "budget_bracket",
      min: budgetMin,
      got: price,
    });
  }

  const bathsMin = num(req.bathrooms_min);
  if (bathsMin !== null) {
    const baths = num(c.bathrooms);
    judge(MATCH_WEIGHTS.bathrooms, baths !== null && baths >= bathsMin, {
      code: "bathrooms",
      min: bathsMin,
      got: baths,
    });
  }

  const coveredMin = num(req.covered_area_min_sqm);
  if (coveredMin !== null) {
    const covered = num(c.covered_area_sqm);
    judge(MATCH_WEIGHTS.coveredArea, covered !== null && covered >= coveredMin, {
      code: "covered_area",
      min: coveredMin,
      got: covered,
    });
  }

  const plotMin = num(req.plot_area_min_sqm);
  if (plotMin !== null) {
    const plot = num(c.plot_area_sqm);
    judge(MATCH_WEIGHTS.plotArea, plot !== null && plot >= plotMin, {
      code: "plot_area",
      min: plotMin,
      got: plot,
    });
  }

  const seaMax = num(req.max_sea_distance_m);
  if (seaMax !== null) {
    const sea = num(c.sea_distance_m);
    judge(MATCH_WEIGHTS.seaDistance, sea !== null && sea <= seaMax, {
      code: "sea_distance",
      max: seaMax,
      got: sea,
    });
  }

  if (req.delivery_by) {
    // String comparison is correct for ISO dates and avoids inventing a
    // timezone; a null delivery_date means "not stated", which is not "on time".
    judge(MATCH_WEIGHTS.delivery, c.delivery_date !== null && c.delivery_date <= req.delivery_by, {
      code: "delivery",
      by: req.delivery_by,
      got: c.delivery_date,
    });
  }

  if (req.vat_preference) {
    judge(MATCH_WEIGHTS.vat, c.vat_status === req.vat_preference, {
      code: "vat",
      wanted: req.vat_preference,
      got: c.vat_status,
    });
  }

  if (req.features_required.length > 0) {
    // Pro-rata: three required features share the feature weight, so missing
    // one of three costs less than missing all three.
    const share = MATCH_WEIGHTS.features / req.features_required.length;
    for (const f of req.features_required) {
      judge(share, c.features.includes(f), { code: "feature", feature: f });
    }
  }

  // Always applicable: every eligible candidate is available, reserved or under
  // offer, and the desk needs the first ranked above the other two.
  judge(MATCH_WEIGHTS.availableNow, c.status === "available", {
    code: "status_not_available",
    got: c.status,
  });

  // A requirement that constrains nothing it could miss scores 100 — vagueness
  // is not a defect in the property.
  const score = applicable === 0 ? 100 : Math.round((earned / applicable) * 100);

  return { eligible: true, score, blockers, misses, hits };
}
