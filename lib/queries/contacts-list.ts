/**
 * Shared filter logic for the contacts list, used by both the list page and the
 * CSV export route so the two can never disagree about which rows the current
 * filters select. The page adds its own `.select()`, ordering and pagination;
 * the export adds a wider `.select()` and a cap. Only the WHERE clause is shared,
 * which is the part that must stay identical for "export = the list you see".
 */

type ParamValue = string | string[] | undefined;
export type ContactSearchParams = Record<string, ParamValue>;

export interface ContactListFilters {
  q?: string;
  type?: string;
  temperature?: string;
  source?: string;
  agent?: string;
  nationality?: string;
  language?: string;
  archived: boolean;
}

function first(v: ParamValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function clean(v: ParamValue): string | undefined {
  const s = first(v)?.trim();
  return s ? s : undefined;
}

export function parseContactListFilters(sp: ContactSearchParams): ContactListFilters {
  return {
    q: clean(sp.q),
    type: clean(sp.type),
    temperature: clean(sp.temperature),
    source: clean(sp.source),
    agent: clean(sp.agent),
    nationality: clean(sp.nationality),
    language: clean(sp.language),
    // archived is a strict flag, not a free value: only "1" opens the archive.
    archived: first(sp.archived) === "1",
  };
}

/**
 * Minimal shape of the part of a Supabase query builder these predicates use.
 * Generic over the concrete builder so the caller keeps its fully-typed row
 * shape — this only constrains the filter methods, and each returns the same
 * builder type for chaining.
 */
interface ContactFilterBuilder<Q> {
  or(filter: string): Q;
  eq(column: string, value: never): Q;
  contains(column: string, value: never): Q;
  ilike(column: string, value: string): Q;
}

/**
 * Apply the list filters to an already-`select()`-ed contacts query. `is_archived`
 * is always constrained (active vs archived are disjoint views). The free-text
 * search strips PostgREST `or()` metacharacters before interpolation, matching
 * the page's original guard. Enum/uuid columns are cast `as never`, the same
 * convention the list page uses against the generated column types.
 */
export function applyContactListFilters<Q extends ContactFilterBuilder<Q>>(
  query: Q,
  f: ContactListFilters,
): Q {
  let q = query.eq("is_archived", f.archived as never);

  if (f.q) {
    const safe = f.q.replace(/[%,()]/g, " ").trim();
    if (safe) {
      q = q.or(`display_name.ilike.%${safe}%,phone_e164.ilike.%${safe}%,email.ilike.%${safe}%`);
    }
  }
  if (f.type) q = q.contains("contact_types", [f.type] as never);
  if (f.temperature) q = q.eq("temperature", f.temperature as never);
  if (f.source) q = q.eq("source", f.source as never);
  if (f.agent) q = q.eq("assigned_agent_id", f.agent as never);
  if (f.nationality) q = q.ilike("nationality", `%${f.nationality}%`);
  if (f.language) q = q.contains("languages", [f.language] as never);

  return q;
}
