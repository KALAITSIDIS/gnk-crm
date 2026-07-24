import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { unwrapRows } from "@/lib/supabase/unwrap";
import {
  propertyFiltersSchema,
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
 * does not need it. Throws on query error via unwrapRows (fail loud).
 */
export async function fetchMandateExcludeIds(
  supabase: SupabaseClient<Database>,
  filters: PropertyFilters,
): Promise<string[]> {
  if (filters.mandate !== "none" && filters.mandate !== "expired") return [];
  const res = await supabase
    .from("mandates")
    .select("property_id")
    .in("status", filters.mandate === "none" ? ["active", "expired"] : ["active"]);
  return [...new Set(unwrapRows(res, "mandates").map((m) => m.property_id))];
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
  // transaction filter, either price may satisfy each bound.
  const priceCol =
    filters.transaction === "rent"
      ? "rent_price_month"
      : filters.transaction === "sale"
        ? "asking_price"
        : null;
  if (filters.price_min !== undefined) {
    q = priceCol
      ? q.gte(priceCol, filters.price_min as never)
      : q.or(`asking_price.gte.${filters.price_min},rent_price_month.gte.${filters.price_min}`);
  }
  if (filters.price_max !== undefined) {
    q = priceCol
      ? q.lte(priceCol, filters.price_max as never)
      : q.or(`asking_price.lte.${filters.price_max},rent_price_month.lte.${filters.price_max}`);
  }

  if (filters.mandate === "active") q = q.eq("mandates.status", "active" as never);
  if (filters.mandate === "expired") q = q.eq("mandates.status", "expired" as never);
  if ((filters.mandate === "none" || filters.mandate === "expired") && excludeIds.length > 0) {
    q = q.not("id", "in", `(${excludeIds.join(",")})` as never);
  }

  return q;
}
