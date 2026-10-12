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
 * select. Properties are the intricate case: a mandate filter changes the join
 * embeds (an inner join, or an anti-join on a second, empty embed), and the
 * price/scope predicates are transaction-context-dependent. All of that lives here
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
/*
 * THROUGH THE VIEW, like every other UI mandate read.
 *
 * `mandates_select` has no listing_manager arm, so on the base table a listing
 * manager's list embed came back empty on EVERY row: the badge read "none" while
 * the property's own detail page (which reads `mandates_safe`) showed the active
 * mandate two clicks away, the mandate=none filter returned every mandated
 * property in the org as "needs a mandate", mandate=active returned nothing at
 * all, and the CSV export wrote "none" down the column. `mandates_safe` admits
 * listing managers with `commission_pct`/`commission_notes` masked — which is
 * exactly why doc 04 records the invariant that all UI mandate reads go through
 * it. The badge needs `type` and `status`; the view carries both.
 */
/**
 * The ONE name of the mandate relationship on a property query.
 *
 * A literal, not a variable, at every use site below — Supabase infers the row
 * type from a LITERAL table name and a variable collapses it (the same trap
 * `mandateSource` documents in quality-score.ts). What this constant buys is
 * that the embed and the FILTER PREFIX cannot drift apart again: PostgREST
 * rejects a filter on `<name>.<column>` unless an embed of exactly `<name>` is
 * in the same select, with 400 PGRST108 — and renaming the embed to the view
 * without renaming the prefix took the mandate=active and mandate=expired
 * filters out for every role, admin included, on 2026-09-08. `mandateFilterKey`
 * is what the filter builder must use, and `mandateEmbed` starts with it.
 */
export const MANDATE_REL = "mandates_safe" as const;

/** The prefix an embedded-resource filter on the mandate must carry. */
export function mandateFilterKey(column: "status" | "type"): string {
  return `${MANDATE_REL}.${column}`;
}

/**
 * "No mandate" and "Expired (not active)", as ANTI-JOINS the database does in
 * the one properties request: "none" = no active AND no expired mandate;
 * "expired" = an expired one and no active one (an active mandate wins the
 * badge). The listing's own mandates are embedded again under aliases that
 * select nothing — `mandate_block` narrowed to the blocking statuses, the
 * listing kept only when it is EMPTY (`mandate_block=is.null`); for "expired",
 * `mandate_has` inner-joined to an expired one. Through `mandates_safe`, like
 * every UI mandate read, so each role is blocked by exactly the mandates it can
 * see (an agent: their own, or on a listing assigned to them). An empty embed
 * adds nothing to a row, so the row type is the display embed's.
 *
 * It replaced a pre-query that read every blocking mandate's property id and
 * wrote them into the request as `id=not.in.(…)` — about 39 bytes each: past
 * about 200 mandated listings the gateway answered 414 (the local Kong's 8 KB
 * request line, measured: 197 ids passed, 198 did not; hosted's limit is not
 * measured) and the list, the map and the export failed. The request is now the same size whatever the
 * mandate count (T-mandate-filter-anti-join).
 *
 * EVERY FILTER NAMES AN ALIAS when the view is embedded more than once.
 * Measured on PostgREST v14.5: beside an aliased embed of the same view, a
 * filter on the UNALIASED `mandates_safe.status` (or on a display embed
 * self-aliased `mandates_safe:`) is not applied where it is written — "expired"
 * as `mandates_safe!inner` + `mandates_safe.status=eq.expired` + the block
 * listed every mandated listing, active ones included. So the display embed
 * stays plain and unfiltered whenever an alias rides with it; "active" keeps
 * its filtered `!inner` display embed because its request embeds the view
 * only once.
 */
const MANDATE_BLOCK = "mandate_block";
const MANDATE_HAS = "mandate_has";
export const MANDATE_BLOCK_EMBED = `${MANDATE_BLOCK}:${MANDATE_REL}()` as const;
export const MANDATE_HAS_EMBED = `${MANDATE_HAS}:${MANDATE_REL}!inner()` as const;

/** The statuses that block each exclusion filter; null when the filter excludes nothing. */
function mandateBlockStatuses(filters: PropertyFilters): readonly ("active" | "expired")[] | null {
  if (filters.mandate === "none") return ["active", "expired"];
  if (filters.mandate === "expired") return ["active"];
  return null;
}

/**
 * The mandate embeds to put in the SELECT: the display embed (inner-joined and
 * filtered for "active"), plus the aliases `applyPropertyListFilters` filters
 * on for "none" / "expired" — so every select that takes `mandateEmbed` names
 * them (a filter on an alias the select lacks is 400 PGRST108, never a wider
 * list).
 */
export function mandateEmbed(
  filters: PropertyFilters,
): "mandates_safe!inner(type, status)" | "mandates_safe(type, status)" {
  if (filters.mandate === "active") return "mandates_safe!inner(type, status)";
  const display = "mandates_safe(type, status)";
  if (filters.mandate === "expired") return `${display}, ${MANDATE_HAS_EMBED}, ${MANDATE_BLOCK_EMBED}` as typeof display;
  if (filters.mandate === "none") return `${display}, ${MANDATE_BLOCK_EMBED}` as typeof display;
  return display;
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
  is(column: string, value: null): Q;
}

/**
 * Apply every list filter to an already-`select()`-ed properties query — one
 * whose select includes `mandateEmbed(filters)`. Mirrors the list page
 * one-for-one.
 */
export function applyPropertyListFilters<Q extends PropertyFilterBuilder<Q>>(
  query: Q,
  filters: PropertyFilters,
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

  // The prefix MUST name the embed in the same select — see MANDATE_REL. It said
  // "mandates" while the select said "mandates_safe", and PostgREST answered 400
  // PGRST108 rather than ignoring it, so both filters threw the page's error
  // boundary for every role and 500'd the CSV export.
  if (filters.mandate === "active")
    q = q.eq(mandateFilterKey("status") as never, "active" as never);
  // "expired": an expired mandate, on the inner-joined alias (see MANDATE_HAS_EMBED)
  if (filters.mandate === "expired")
    q = q.eq(`${MANDATE_HAS}.status` as never, "expired" as never);
  // the anti-join (see MANDATE_BLOCK_EMBED): the block embed narrowed to the
  // blocking statuses, and the listing kept only when nothing is left in it
  const blocking = mandateBlockStatuses(filters);
  if (blocking) {
    q = q.in(`${MANDATE_BLOCK}.status`, blocking as never).is(MANDATE_BLOCK, null);
  }

  return q;
}
