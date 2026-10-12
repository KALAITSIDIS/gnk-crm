import {
  KEY_SEARCH_NOTHING,
  KEY_SEARCH_TOO_LONG,
  keyFiltersSchema,
  sanitizeSearchTerm,
  type KeyFilters,
} from "@/lib/validators/keys";

/**
 * Shared filter logic for the keys register, used by the list page and the CSV
 * export. Two filters: `status` and a free-text `q`. The text search matches the
 * key's code, description and holder's name, and its property's REFERENCE —
 * all four in ONE request (T-key-reference-search; see `withKeySearchEmbed`).
 */

type ParamValue = string | string[] | undefined;
export type KeySearchParams = Record<string, ParamValue>;

function first(v: ParamValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The register's filters — or, when the search cannot be run, the words that say why. */
export type ParsedKeyFilters = { filters: KeyFilters; refusal: null } | { filters: null; refusal: string };

/**
 * Never throws (a throw was the page's error boundary and the export's bare
 * 500). `status` falls back to "all" (a stale or hand-typed scope). A search
 * the register cannot run as asked — longer than the box allows, or nothing
 * but characters the search leaves out — is REFUSED, never truncated or run as
 * the whole register: the caller runs no key query at all and says so. A
 * repeated parameter reads its FIRST value, here and in the export route
 * (T-keys-search-length).
 */
export function parseKeyFilters(sp: KeySearchParams): ParsedKeyFilters {
  const parsed = keyFiltersSchema.safeParse({ status: first(sp.status), q: first(sp.q) });
  if (parsed.success) {
    // "(,)" would otherwise add no predicate: the whole register, labelled a search
    if (parsed.data.q && !sanitizeSearchTerm(parsed.data.q)) return { filters: null, refusal: KEY_SEARCH_NOTHING };
    return { filters: parsed.data, refusal: null };
  }
  const tooLong = parsed.error.issues.some((i) => i.code === "too_big");
  return { filters: null, refusal: tooLong ? KEY_SEARCH_TOO_LONG : "That search could not be read. Nothing was searched." };
}

/**
 * The key's own property, embedded a second time under an alias that selects
 * nothing. The search's reference predicate is applied to THIS embed, so it is
 * non-null exactly when the key's property reference matches, and the `.or()`
 * tests that beside the key's own fields. The property is read under the
 * caller's RLS like any embed: a property the session cannot read matches
 * nothing. The display embed (`properties(reference)`) stays unfiltered, so a
 * key found by its code still shows its property.
 *
 * It replaced a lookup that read the matching property ids first
 * (`.limit(200)`, no order) and inlined them as `property_id.in.(…)`: a term
 * matching more than 200 references silently dropped the rest's keys, and the
 * URL grew with every id. The request is now the same size whatever matches.
 *
 * PostgREST builds an empty embed as the property's whole row and tests that
 * row for null, so the search needs table-level SELECT on `properties` and
 * reads one property row per key it considers (measured negligible at today's
 * sizes; BACKLOG "Keys search — 2026-10-11").
 */
const REFERENCE_MATCH = "reference_match";
export const KEY_REFERENCE_MATCH_EMBED = `${REFERENCE_MATCH}:properties()`;

/** The search term as every predicate uses it ("" = no search). */
function searchTerm(filters: KeyFilters): string {
  return filters.q ? sanitizeSearchTerm(filters.q) : "";
}

/**
 * The select for a key query that goes through `applyKeyListFilters`, given the
 * SAME filters: the caller's columns, plus the reference-match embed when — and
 * only when — there is a search term, so an unsearched register does not pay a
 * property lookup per key. The embed adds nothing to a row, so the row type is
 * the columns'. A select and a filter that disagree make PostgREST refuse the
 * filter (400, PGRST108) — a failed load, never a narrower list.
 */
export function withKeySearchEmbed<const S extends string>(columns: S, filters: KeyFilters): S {
  return (searchTerm(filters) ? `${columns}, ${KEY_REFERENCE_MATCH_EMBED}` : columns) as S;
}

interface KeyFilterBuilder<Q> {
  eq(column: string, value: never): Q;
  ilike(column: string, pattern: string): Q;
  or(filter: string): Q;
}

export function applyKeyListFilters<Q extends KeyFilterBuilder<Q>>(query: Q, filters: KeyFilters): Q {
  let out = query;
  if (filters.status !== "all") out = out.eq("status", filters.status as never);

  const term = searchTerm(filters);
  if (term) {
    out = out.ilike(`${REFERENCE_MATCH}.reference`, `%${term}%`).or(
      [
        `key_code.ilike.%${term}%`,
        `description.ilike.%${term}%`,
        `current_holder_name.ilike.%${term}%`,
        `${REFERENCE_MATCH}.not.is.null`,
      ].join(","),
    );
  }
  return out;
}
