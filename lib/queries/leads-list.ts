import {
  leadFiltersSchema,
  leadStatusesForFilter,
  type LeadFilters,
} from "@/lib/validators/contacts";

/**
 * Shared filter logic for the leads inbox, used by the list page and the CSV
 * export so they scope to the same statuses. The only filter is `status`
 * (open / closed / all / a concrete status), resolved by the existing
 * leadStatusesForFilter helper.
 */

type ParamValue = string | string[] | undefined;
export type LeadSearchParams = Record<string, ParamValue>;

function first(v: ParamValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseLeadFilters(sp: LeadSearchParams): LeadFilters {
  return leadFiltersSchema.parse({ status: first(sp.status) });
}

interface LeadFilterBuilder<Q> {
  in(column: string, values: never): Q;
}

/** Apply the status scope to an already-`select()`-ed leads query. */
export function applyLeadListFilters<Q extends LeadFilterBuilder<Q>>(
  query: Q,
  filters: LeadFilters,
): Q {
  const scoped = leadStatusesForFilter(filters.status);
  return scoped ? query.in("status", [...scoped] as never) : query;
}
