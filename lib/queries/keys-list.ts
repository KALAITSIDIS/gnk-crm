import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { keyFiltersSchema, sanitizeSearchTerm, type KeyFilters } from "@/lib/validators/keys";

/**
 * Shared filter logic for the keys register, used by the list page and the CSV
 * export. Two filters: `status` and a free-text `q`. The text search matches the
 * property REFERENCE, which lives on a joined table PostgREST cannot reach from
 * `.or()`, so the matching property ids are resolved first and folded into the
 * disjunction — the same pattern the properties mandate filter uses.
 */

type ParamValue = string | string[] | undefined;
export type KeySearchParams = Record<string, ParamValue>;

function first(v: ParamValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseKeyFilters(sp: KeySearchParams): KeyFilters {
  return keyFiltersSchema.parse({ status: first(sp.status), q: first(sp.q) });
}

/** Property ids whose reference matches the text term (empty when no term). */
export async function fetchKeyMatchedPropertyIds(
  supabase: SupabaseClient<Database>,
  filters: KeyFilters,
): Promise<string[]> {
  const term = filters.q ? sanitizeSearchTerm(filters.q) : "";
  if (!term) return [];
  const { data } = await supabase
    .from("properties")
    .select("id")
    .ilike("reference", `%${term}%`)
    .limit(200);
  return (data ?? []).map((p) => p.id);
}

interface KeyFilterBuilder<Q> {
  eq(column: string, value: never): Q;
  or(filter: string): Q;
}

export function applyKeyListFilters<Q extends KeyFilterBuilder<Q>>(
  query: Q,
  filters: KeyFilters,
  matchedPropertyIds: readonly string[],
): Q {
  let out = query;
  if (filters.status !== "all") out = out.eq("status", filters.status as never);

  const term = filters.q ? sanitizeSearchTerm(filters.q) : "";
  if (term) {
    const clauses = [
      `key_code.ilike.%${term}%`,
      `description.ilike.%${term}%`,
      `current_holder_name.ilike.%${term}%`,
    ];
    if (matchedPropertyIds.length) {
      clauses.push(`property_id.in.(${matchedPropertyIds.join(",")})`);
    }
    out = out.or(clauses.join(","));
  }
  return out;
}
