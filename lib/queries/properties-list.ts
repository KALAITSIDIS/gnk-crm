import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { formatMoney } from "@/lib/utils/format";
import {
  PROPERTY_FILTER_KEYS,
  PROPERTY_PRESENTATION_KEYS,
  propertyFiltersSchema,
  resolvePropertyKindScope,
  resolvePropertyScope,
  type PropertyFilters,
  type PropertyKindFilter,
  type PropertySort,
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

/**
 * Parse URL searchParams into the validated filter object (invalid → default).
 * Reads exactly `PROPERTY_FILTER_KEYS` and `PROPERTY_PRESENTATION_KEYS` — the
 * one key list (A03) — and the first value of a repeated key, as Next hands
 * the page a repeated key as an array.
 */
export function parsePropertyFilters(sp: PropertySearchParams): PropertyFilters {
  const input: Record<string, string | undefined> = {};
  for (const key of [...PROPERTY_FILTER_KEYS, ...PROPERTY_PRESENTATION_KEYS]) input[key] = first(sp[key]);
  return propertyFiltersSchema.parse(input);
}

/** A query string's parameters as the page reads them: the FIRST value of a repeated key. */
export function searchParamsRecord(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params) if (!(key in out)) out[key] = value;
  return out;
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
  // as the retired scope below; `all` (F04) asks for every kind, so it adds no
  // kind predicate at all.
  if (filters.kind && filters.kind !== "all") q = q.eq("kind", filters.kind as never);
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

  // Land (A03): plot area and building density. A listing with no recorded
  // plot or density matches no bound — `null >= x` is not true — which the
  // inputs say in their own words; an unknown is never read as a zero.
  if (filters.plot_min !== undefined) q = q.gte("plot_area_sqm", filters.plot_min as never);
  if (filters.plot_max !== undefined) q = q.lte("plot_area_sqm", filters.plot_max as never);
  if (filters.density_min !== undefined) q = q.gte("building_density_pct", filters.density_min as never);

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

/* ---------- the header: what the list holds, and what it leaves out (F04) ---------- */

/**
 * An exact count of the rows `filters` select, as a HEAD request: the same
 * embeds (`mandateEmbed`, so every mandate filter's alias is legal) and the
 * same predicates as the list, the export and the map. The caller reads it
 * with `unwrapCount` — a missing count is a failure, never zero.
 */
export function countPropertyList(supabase: SupabaseClient<Database>, filters: PropertyFilters) {
  return applyPropertyListFilters(
    supabase
      .from("properties")
      .select(`id, ${mandateEmbed(filters)}`, { count: "exact", head: true }),
    filters,
  );
}

/**
 * The filters whose count is "the units this list is not showing" (F04): the
 * list's own filters with `kind=unit` — or null when the list hides no units
 * (any explicit kind, `all` included). The default list and this count split
 * one all-kinds set exactly: `kind <> 'unit'` and `kind = 'unit'` under the
 * same other predicates, `kind` being NOT NULL. So the default's total plus
 * this count is the total `?kind=all` states.
 */
export function hiddenUnitFilters(filters: PropertyFilters): PropertyFilters | null {
  return resolvePropertyKindScope(filters) === "exclude-units" ? { ...filters, kind: "unit" } : null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * What the header calls the rows a kind filter holds. The default names what
 * it holds — "listings & developments", a development being a project or a
 * phase — because "properties" over a list with the units taken out is the
 * reading that made the dashboard's counts irreconcilable with it (F04).
 */
export function propertyCountNoun(kind: PropertyKindFilter | undefined, n: number): string {
  switch (kind) {
    case undefined:
      return plural(n, "listing or development", "listings & developments");
    case "all":
      return `${plural(n, "property", "properties")} · all kinds`;
    case "standalone":
      return plural(n, "standalone listing", "standalone listings");
    case "project":
      return plural(n, "project", "projects");
    case "phase":
      return plural(n, "phase", "phases");
    case "unit":
      return plural(n, "unit", "units");
  }
}

/** "6 units not shown" — the hint beside the default list's own total. */
export function hiddenUnitsText(n: number): string {
  return `${n} ${plural(n, "unit", "units")} not shown`;
}

/* ---------- the order (A03) ---------- */

/** Minimal shape of the `order` modifier the list's sorts use; see PropertyFilterBuilder. */
interface PropertyOrderBuilder<Q> {
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): Q;
}

/**
 * The column a non-default sort orders by, and its direction; null for the
 * default (`newest`). Price is the price the transaction filter reads: the
 * monthly rent under "Rent", the asking price otherwise — so in a mixed list
 * a rental with no asking price sorts LAST, and the description says "asking
 * price" (a coalesced list price would need a generated column).
 */
export function propertySortColumn(
  filters: Pick<PropertyFilters, "sort" | "transaction">,
): { column: string; ascending: boolean } | null {
  switch (filters.sort) {
    case "newest":
      return null;
    case "updated":
      return { column: "updated_at", ascending: false };
    case "price_asc":
    case "price_desc":
      return {
        column: filters.transaction === "rent" ? "rent_price_month" : "asking_price",
        ascending: filters.sort === "price_asc",
      };
    case "plot_asc":
    case "plot_desc":
      return { column: "plot_area_sqm", ascending: filters.sort === "plot_asc" };
    case "score_asc":
    case "score_desc":
      return { column: "quality_score", ascending: filters.sort === "score_asc" };
    case "reference":
    case "reference_desc":
      return { column: "reference", ascending: filters.sort === "reference" };
  }
}

/**
 * Order a properties query by the list's sort — the page and the CSV export
 * both call this, so the screen and the file list the same rows in the same
 * order (T-list-page-order).
 *
 * The default emits EXACTLY what the list always sent, `created_at.desc,id.asc`
 * — no nulls clause, nothing else — so every bookmark without `sort` keeps its
 * order. Every other sort puts unknown values LAST in either direction
 * (Postgres' own default puts them first when descending) and ends on `id`:
 * without a unique last key, rows tied on a price or a score could appear on
 * two pages and on none.
 */
export function applyPropertyListOrder<Q extends PropertyOrderBuilder<Q>>(
  query: Q,
  filters: Pick<PropertyFilters, "sort" | "transaction">,
): Q {
  const by = propertySortColumn(filters);
  if (!by) return query.order("created_at", { ascending: false }).order("id");
  return query.order(by.column, { ascending: by.ascending, nullsFirst: false }).order("id");
}

/**
 * The table's sortable columns and their two sorts, ascending first: a header
 * that is not the current sort goes to its first; the current one flips.
 */
export const SORTABLE_COLUMNS = {
  reference: ["reference", "reference_desc"],
  price: ["price_asc", "price_desc"],
  plot: ["plot_asc", "plot_desc"],
  score: ["score_asc", "score_desc"],
} as const satisfies Record<string, readonly [PropertySort, PropertySort]>;
export type SortableColumn = keyof typeof SORTABLE_COLUMNS;

export interface ColumnSort {
  /** where the header goes: the same list, every filter kept, page 1, the column's next sort */
  href: string;
  /** `aria-sort` for the header: the direction when it is the current sort */
  direction: "ascending" | "descending" | null;
}

/** A sortable header's link, built from the list's own query (no client code). */
export function columnSort(
  column: SortableColumn,
  query: string,
  current: PropertySort,
  path = "/properties",
): ColumnSort {
  const [asc, desc] = SORTABLE_COLUMNS[column];
  const direction = current === asc ? "ascending" : current === desc ? "descending" : null;
  const next = nextPropertiesQuery(query, { sort: current === asc ? desc : asc });
  return { href: next ? `${path}?${next}` : path, direction };
}

/* ---------- the URL the filter bar writes (A03) ---------- */

/** What a filter select posts for "no filter": its parameter is removed. */
export const FILTER_ALL = "__all__";

/**
 * The list query after `updates`, from `current` (a query string, no "?"): an
 * update of undefined, "" or `FILTER_ALL` removes its parameter, any other
 * value sets it, every other parameter is kept. A filter change returns to
 * page 1 — a narrower filter must not strand you on a page that no longer
 * exists; `keepPage` is for a change that shows the same rows another way
 * (the table/card toggle). An update that changes nothing (a number box
 * blurred as it was) keeps the page too: leaving a box must not jump from
 * page 3 to page 1. The default sort is written as no parameter, so a URL
 * without `sort` and one with `sort=newest` cannot both exist for one view.
 */
export function nextPropertiesQuery(
  current: string,
  updates: Record<string, string | undefined>,
  opts: { keepPage?: boolean } = {},
): string {
  const params = new URLSearchParams(current);
  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === "" || value === FILTER_ALL || (key === "sort" && value === "newest")) {
      if (params.has(key)) changed = true;
      params.delete(key);
    } else {
      const before = params.getAll(key);
      if (before.length !== 1 || before[0] !== value) changed = true;
      params.set(key, value);
    }
  }
  if (changed && !opts.keepPage) params.delete("page");
  return params.toString();
}

/** What Clear leaves of a query: how the list is shown (view, sort) — no filter, no page. */
export function clearedPropertiesQuery(current: string): string {
  const from = new URLSearchParams(current);
  const out = new URLSearchParams();
  for (const key of ["view", "sort"] as const) {
    const value = from.get(key);
    if (value) out.set(key, value);
  }
  return out.toString();
}

/**
 * Which settled URLs the filter bar navigated to itself (A03).
 *
 * The bar composes every change from the newest URL it has ASKED for, never
 * from the one on screen: a navigation is a transition, and until it commits
 * the rendered URL is the old one. Composing from it dropped the change still
 * in flight — a district picked and then a type before the first answer lost
 * the district; a search typed 300 ms earlier landed on top of a select
 * changed in the meantime and put the old select value back.
 *
 * When a URL settles, the bar must tell its own write landing (nothing to do:
 * its newest write is already ahead) from somebody else's navigation — Back,
 * a header sort link, "Show all kinds", a page link — which it adopts as its
 * new base (gnk-web's lesson: an own `replaceState` mistaken for a
 * navigation, and the reverse).
 *
 * `settled(q)` is true for one of the writes still pending, and forgets it
 * together with every write before it: navigations commit in order, and a
 * later one supersedes an earlier one that then never commits. It matches the
 * LAST pending copy of `q`, so a superseded copy can never linger and make a
 * later Back to that URL look like the bar's own. Anything else is external,
 * and the pending list is dropped.
 *
 * `wrote(q, onScreen)` with q EQUAL to the URL on screen (Sort → price, then
 * back to Newest before the first answer) records nothing and drops what was
 * pending (A03 review): the earlier writes are superseded, and this one will
 * never settle — the URL does not change, so no settle is ever reported. Kept,
 * they lingered, and a later sortable-header or "Show all kinds" link landing
 * on one of them was taken for the bar's own write: the bar kept composing from
 * the URL it had asked for and silently dropped what the person clicked.
 */
export function ownWriteTracker() {
  let pending: string[] = [];
  return {
    wrote(query: string, onScreen: string): void {
      if (query === onScreen) {
        pending = [];
        return;
      }
      pending.push(query);
    },
    settled(query: string): boolean {
      const at = pending.lastIndexOf(query);
      if (at === -1) {
        pending = [];
        return false;
      }
      pending = pending.slice(at + 1);
      return true;
    },
    pending(): readonly string[] {
      return [...pending];
    },
  };
}
export type OwnWriteTracker = ReturnType<typeof ownWriteTracker>;

/* ---------- a view that names itself (A03) ---------- */

/** A district or an area, by id, with the name the list shows. */
export interface PlaceName {
  id: string;
  name: string;
}
export interface PlaceNames {
  districts: readonly PlaceName[];
  areas: readonly PlaceName[];
}

const labelize = (value: string) => value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const amount = (n: number) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(n);

const KIND_WORDS: Record<PropertyKindFilter, string> = {
  all: "All kinds",
  standalone: "Standalone listings",
  project: "Projects",
  phase: "Phases",
  unit: "Units only",
};
const TRANSACTION_WORDS = { sale: "For sale", rent: "For rent", sale_or_rent: "Sale or rent" } as const;
const MANDATE_WORDS = { active: "Active mandate", expired: "Expired mandate", none: "No mandate" } as const;
const SCOPE_WORDS = { active: null, archived: "Archived", all: "Active & archived" } as const;

/** A bound pair in words: "a–b", "≥ a", "≤ b"; null when neither is set. */
function bounds(min: number | undefined, max: number | undefined, show: (n: number) => string): string | null {
  if (min !== undefined && max !== undefined) return `${show(min)}–${show(max)}`;
  if (min !== undefined) return `≥ ${show(min)}`;
  if (max !== undefined) return `≤ ${show(max)}`;
  return null;
}

/** The sort in words; null for the default. */
export function describePropertySort(filters: Pick<PropertyFilters, "sort" | "transaction">): string | null {
  const arrow = (ascending: boolean) => (ascending ? "↑" : "↓");
  switch (filters.sort) {
    case "newest":
      return null;
    case "updated":
      return "recently updated first";
    case "price_asc":
    case "price_desc":
      return `sorted by ${filters.transaction === "rent" ? "rent" : "asking price"} ${arrow(filters.sort === "price_asc")}`;
    case "plot_asc":
    case "plot_desc":
      return `sorted by plot ${arrow(filters.sort === "plot_asc")}`;
    case "score_asc":
    case "score_desc":
      return `sorted by quality score ${arrow(filters.sort === "score_asc")}`;
    case "reference":
      return "sorted by reference A–Z";
    case "reference_desc":
      return "sorted by reference Z–A";
  }
}

/** How much of a search the description repeats. */
const SEARCH_SHOWN = 40;

/**
 * Every filter and the sort of a list view, in words, in a fixed order — e.g.
 * "Paphos · Land · plot 1.500–6.000 m² · density ≥ 90% · sorted by plot ↓"
 * (doc 02 §A11 number format). The list and the map show it under their
 * heading and in the document title, so a bookmark, a history entry or a
 * shared link names the view it holds: the URL is the saved view (saved views
 * in the database stay "never at two operators"). Empty for the default view.
 *
 * Only what the parser kept is described — an invalid parameter the list
 * ignores is not named. A district or area id the session cannot read is
 * "Unknown district" / "Unknown area", never left out: the list still filters
 * by it.
 */
export function describePropertyFilters(filters: PropertyFilters, places: PlaceNames): string {
  const parts: string[] = [];
  const nameOf = (list: readonly PlaceName[], id: string | undefined, unknown: string) =>
    id === undefined ? null : (list.find((p) => p.id === id)?.name ?? unknown);

  if (filters.q) {
    const q = filters.q.length > SEARCH_SHOWN ? `${filters.q.slice(0, SEARCH_SHOWN)}…` : filters.q;
    parts.push(`“${q}”`);
  }
  const district = nameOf(places.districts, filters.district, "Unknown district");
  if (district) parts.push(district);
  const area = nameOf(places.areas, filters.area, "Unknown area");
  if (area) parts.push(area);
  if (filters.type) parts.push(labelize(filters.type));
  if (filters.kind) parts.push(KIND_WORDS[filters.kind]);
  if (filters.transaction) parts.push(TRANSACTION_WORDS[filters.transaction]);
  if (filters.status) parts.push(labelize(filters.status));
  if (filters.visibility) {
    parts.push(`Visibility: ${filters.visibility === "vip" ? "VIP" : labelize(filters.visibility)}`);
  }
  if (filters.mandate) parts.push(MANDATE_WORDS[filters.mandate]);
  if (filters.beds !== undefined) parts.push(`${filters.beds}+ beds`);

  const rent = filters.transaction === "rent";
  const price = bounds(filters.price_min, filters.price_max, (n) => formatMoney(n));
  if (price) parts.push(`${rent ? "rent" : "price"} ${price}${rent ? "/mo" : ""}`);
  const plot = bounds(filters.plot_min, filters.plot_max, amount);
  if (plot) parts.push(`plot ${plot} m²`);
  if (filters.density_min !== undefined) parts.push(`density ≥ ${amount(filters.density_min)}%`);

  const scope = SCOPE_WORDS[filters.scope];
  if (scope) parts.push(scope);
  const sort = describePropertySort(filters);
  if (sort) parts.push(sort);
  return parts.join(" · ");
}

/**
 * The document title of a list view: "<base> · <its description>", and the
 * page number past page one (a history entry of page 3 is not page 1).
 */
export function propertiesViewTitle(base: string, filters: PropertyFilters, places: PlaceNames): string {
  const described = describePropertyFilters(filters, places);
  const page = filters.page > 1 ? ` · page ${filters.page}` : "";
  return `${described ? `${base} · ${described}` : base}${page}`;
}
