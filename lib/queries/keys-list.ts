import { keyFiltersSchema, sanitizeSearchTerm, type KeyFilters } from "@/lib/validators/keys";

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

export function parseKeyFilters(sp: KeySearchParams): KeyFilters {
  return keyFiltersSchema.parse({ status: first(sp.status), q: first(sp.q) });
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
 */
const REFERENCE_MATCH = "reference_match";
export const KEY_REFERENCE_MATCH_EMBED = `${REFERENCE_MATCH}:properties()` as const;

/**
 * A key select with the reference-match embed added. Every query that goes
 * through `applyKeyListFilters` must select through this: PostgREST refuses a
 * filter on an embed the select does not name (400, PGRST108) — a failed load,
 * never a narrower list.
 */
export function withKeySearchEmbed<const S extends string>(columns: S): `${S}, ${typeof KEY_REFERENCE_MATCH_EMBED}` {
  return `${columns}, ${KEY_REFERENCE_MATCH_EMBED}`;
}

interface KeyFilterBuilder<Q> {
  eq(column: string, value: never): Q;
  ilike(column: string, pattern: string): Q;
  or(filter: string): Q;
}

export function applyKeyListFilters<Q extends KeyFilterBuilder<Q>>(query: Q, filters: KeyFilters): Q {
  let out = query;
  if (filters.status !== "all") out = out.eq("status", filters.status as never);

  const term = filters.q ? sanitizeSearchTerm(filters.q) : "";
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
