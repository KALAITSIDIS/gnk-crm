/**
 * Shared deal-type logic for the pipeline board and the deals CSV export.
 *
 * The pipeline is a per-`deal_type` kanban (one tab each: sale / rental /
 * antiparoxi / advisory). The board additionally splits open vs a 30-day closed
 * window for display; the export deliberately does NOT — that window is a board
 * convenience, not a filter the user chose, and reporting wants every won deal,
 * not just recent ones (DECISIONS T-csv-export-rollout). So the one thing the two
 * share is the deal_type tab, kept here as a single source of truth.
 */

export const DEAL_TYPES = ["sale", "rental", "antiparoxi", "advisory"] as const;
export type DealType = (typeof DEAL_TYPES)[number];

type ParamValue = string | string[] | undefined;
export type DealSearchParams = Record<string, ParamValue>;

function first(v: ParamValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The selected deal-type tab, defaulting to sale for an unknown value. */
export function parseDealType(sp: DealSearchParams): DealType {
  const raw = first(sp.type);
  return raw && (DEAL_TYPES as readonly string[]).includes(raw) ? (raw as DealType) : "sale";
}

interface DealFilterBuilder<Q> {
  eq(column: string, value: never): Q;
}

export function applyDealTypeFilter<Q extends DealFilterBuilder<Q>>(
  query: Q,
  dealType: DealType,
): Q {
  return query.eq("deal_type", dealType as never);
}
