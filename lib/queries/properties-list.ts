import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAll } from "@/lib/supabase/fetch-all";
import {
  propertyFiltersSchema,
  resolvePropertyKindScope,
  resolvePropertyScope,
  type PropertyFilters,
  RETIRED_PROPERTY_STATUS,
  RETIRED_PROPERTY_VISIBILITY,
} from "@/lib/validators/properties";

/**
 * Shared query logic for the properties list, used by the list page and the CSV
 * export route so they cannot disagree about which rows the current filters
 * select. Properties are the intricate case: a mandate filter needs a separate
 * pre-query for the ids to exclude and changes the join embed, and the price/
 * scope predicates are transaction-context-dependent. All of that lives here
 * once; the page and the export each add only their own `.select()` columns,
 * ordering and pagination.
 */

type ParamValue = string | string[] | undefined;
export type PropertySearchParams = Record<string, ParamValue>;

function first(v: ParamValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Parse URL searchParams into the validated filter object (invalid → default). */
export function parsePropertyFilters(sp: PropertySearchParams): PropertyFilters {
  return propertyFiltersSchema.parse({
    q: first(sp.q),
    district: first(sp.district),
    area: first(sp.area),
    type: first(sp.type),
    transaction: first(sp.transaction),
    status: first(sp.status),
    visibility: first(sp.visibility),
    beds: first(sp.beds),
    price_min: first(sp.price_min),
    price_max: first(sp.price_max),
    mandate: first(sp.mandate),
    kind: first(sp.kind),
    scope: first(sp.scope),
    view: first(sp.view),
    page: first(sp.page),
  });
}

/**
 * The mandate embed to put in the SELECT — inner-joined when the filter needs it.
 * Returns the literal union (not `string`) so callers that pass it into a
 * template-literal `.select()` keep Supabase's typed row inference.
 */
export function mandateEmbed(
  filters: PropertyFilters,
): "mandates!inner(type, status)" | "mandates(type, status)" {
  return filters.mandate === "active" || filters.mandate === "expired"
    ? "mandates!inner(type, status)"
    : "mandates(type, status)";
}

/**
 * Property ids to EXCLUDE for the "no mandate" / "expired (not active)" filters.
 * "none" = no active AND no expired mandate; "expired" excludes any with an
 * active mandate (an active mandate wins the badge). Returns [] when the filter
 * does not need it. Throws on query error (fail loud). Paged through fetchAll
 * since 2026-09-06: a single select stops at PostgREST's 1,000 silently, and
 * the 1,001st excluded id would have let its property back onto the list
 * (the audit's A08a).
 */
export async function fetchMandateExcludeIds(
  supabase: SupabaseClient<Database>,
  filters: PropertyFilters,
): Promise<string[]> {
  if (filters.mandate !== "none" && filters.mandate !== "expired") return [];
  const statuses =
    filters.mandate === "none" ? (["active", "expired"] as const) : (["active"] as const);
  const rows = await fetchAll(
    (from, to) =>
      supabase
        .from("mandates")
        .select("property_id")
        .in("status", statuses)
        .order("id")
        .range(from, to),
    "mandates",
  );
  return [...new Set(rows.map((m) => m.property_id))];
}

/**
 * Minimal shape of the filter methods these predicates use. Generic over the
 * concrete builder so each caller keeps its fully-typed row shape; values are
 * cast `as never`, the same convention the list page uses against the generated
 * column types.
 */
interface PropertyFilterBuilder<Q> {
  or(filter: string): Q;
  eq(column: string, value: never): Q;
  neq(column: string, value: never): Q;
  in(column: string, values: never): Q;
  gte(column: string, value: never): Q;
  lte(column: string, value: never): Q;
  not(column: string, operator: string, value: never): Q;
}

/**
 * Apply every list filter to an already-`select()`-ed properties query. Mirrors
 * the list page one-for-one. `excludeIds` comes from fetchMandateExcludeIds.
 */
export function applyPropertyListFilters<Q extends PropertyFilterBuilder<Q>>(
  query: Q,
  filters: PropertyFilters,
  excludeIds: readonly string[],
): Q {
  let q = query;

  if (filters.q) {
    const s = filters.q.replace(/[%,()]/g, " ").trim();
    if (s) q = q.or(`reference.ilike.%${s}%,address.ilike.%${s}%,title->>en.ilike.%${s}%`);
  }
  if (filters.district) q = q.eq("district_id", filters.district as never);
  if (filters.area) q = q.eq("area_id", filters.area as never);
  if (filters.type) q = q.eq("property_type", filters.type as never);

  // Units are inventory inside a project, not listings — hidden unless asked
  // for, so one 60-unit project cannot bury the list, the export and the map
  // (all three share this function). An explicit kind wins, same escape hatch
  // as the retired scope below.
  if (filters.kind) q = q.eq("kind", filters.kind as never);
  else if (resolvePropertyKindScope(filters) === "exclude-units") {
    q = q.neq("kind", "unit" as never);
  }

  // sale_or_rent listings ARE for sale and ARE for rent — both filters match them
  if (filters.transaction === "sale") {
    q = q.in("transaction_type", ["sale", "sale_or_rent"] as never);
  } else if (filters.transaction === "rent") {
    q = q.in("transaction_type", ["rent", "sale_or_rent"] as never);
  } else if (filters.transaction === "sale_or_rent") {
    q = q.eq("transaction_type", "sale_or_rent" as never);
  }

  if (filters.status) q = q.eq("status", filters.status as never);
  if (filters.visibility) q = q.eq("visibility", filters.visibility as never);

  // Retired listings (withdrawn / archived) stay in the DB forever — the default
  // scope keeps them off the list; an explicit retired status/visibility wins.
  const scopeMode = resolvePropertyScope(filters);
  if (scopeMode === "exclude-retired") {
    q = q
      .neq("status", RETIRED_PROPERTY_STATUS as never)
      .neq("visibility", RETIRED_PROPERTY_VISIBILITY as never);
  } else if (scopeMode === "only-retired") {
    q = q.or(
      `status.eq.${RETIRED_PROPERTY_STATUS},visibility.eq.${RETIRED_PROPERTY_VISIBILITY}`,
    );
  }

  if (filters.beds !== undefined) q = q.gte("bedrooms", filters.beds as never);

  // € bounds check the price that matters for the transaction context; with no
  // transaction filter, either price may satisfy the bracket — but ONE price
  // must satisfy the WHOLE bracket. Until 2026-09-06 the two bounds went out as
  // two independent ORs, so a listing for sale at 900,000 and to let at 500 a
  // month sat inside a 100,000–500,000 bracket: its sale price cleared the
  // floor and its rent cleared the ceiling, and no figure it had was in the
  // range (the audit's A09). One bound alone is still a plain OR across the
  // two columns; both bounds are grouped per column, and the list, the export
  // and the map all read this one function.
  const priceCol =
    filters.transaction === "rent"
      ? "rent_price_month"
      : filters.transaction === "sale"
        ? "asking_price"
        : null;
  const { price_min: min, price_max: max } = filters;
  if (priceCol) {
    if (min !== undefined) q = q.gte(priceCol, min as never);
    if (max !== undefined) q = q.lte(priceCol, max as never);
  } else if (min !== undefined && max !== undefined) {
    q = q.or(
      `and(asking_price.gte.${min},asking_price.lte.${max}),and(rent_price_month.gte.${min},rent_price_month.lte.${max})`,
    );
  } else if (min !== undefined) {
    q = q.or(`asking_price.gte.${min},rent_price_month.gte.${min}`);
  } else if (max !== undefined) {
    q = q.or(`asking_price.lte.${max},rent_price_month.lte.${max}`);
  }

  if (filters.mandate === "active") q = q.eq("mandates.status", "active" as never);
  if (filters.mandate === "expired") q = q.eq("mandates.status", "expired" as never);
  if ((filters.mandate === "none" || filters.mandate === "expired") && excludeIds.length > 0) {
    q = q.not("id", "in", `(${excludeIds.join(",")})` as never);
  }

  return q;
}
