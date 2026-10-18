/**
 * Shared deal filters: the pipeline board's deal-type tab, and the /deals
 * register's filters (F05).
 *
 * The pipeline is a per-`deal_type` kanban (one tab each: sale / rental /
 * antiparoxi / advisory). The board additionally splits open vs a 30-day closed
 * window for display; its export (/pipeline/export) deliberately does NOT —
 * that window is a board convenience, not a filter the user chose, and
 * reporting wants every won deal, not just recent ones (DECISIONS
 * T-csv-export-rollout). So the one thing the two share is the deal_type tab.
 *
 * /deals is the register behind the board: every deal the session may read
 * (RLS decides — an agent sees the deals they own or created), filtered in the
 * URL. The list page and /deals/export parse and apply the SAME filters here,
 * so the file is always the list on screen. Junk in the URL is no filter: an
 * unknown type or status, a malformed id, an impossible day are dropped as if
 * absent — never an error page, never 22P02 (T-malformed-ids).
 */

import { zonedDateRangeToUtc } from "@/lib/utils/tz";
import { guidOrNull } from "@/lib/validators/ids";
import { DEAL_LIST_STATUSES, isDayKey, type DealListStatus } from "@/lib/validators/deals";

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

// ---------------------------------------------------------------------------
// The /deals register
// ---------------------------------------------------------------------------

/**
 * The register's filters, as parsed. Keys are the URL's own parameter names,
 * so the export's audit record (`auditFilters`) names them as the URL does.
 * Every field is optional: none set is every deal the session may read.
 */
export interface DealListFilters {
  /** a title search (titles read "<buyer> — <property reference>" when a lead converts) */
  q?: string;
  type?: DealType;
  status?: DealListStatus;
  agent?: string;
  property?: string;
  /** the deal's buyer OR seller */
  contact?: string;
  /** Cyprus days, inclusive; either bound alone is allowed, and either one means "closed" */
  closed_from?: string;
  closed_to?: string;
}

/** The parameters the register reads — the filter bar's "Clear" and the empty state's test. */
export const DEAL_LIST_FILTER_KEYS = [
  "q",
  "type",
  "status",
  "agent",
  "property",
  "contact",
  "closed_from",
  "closed_to",
] as const satisfies readonly (keyof DealListFilters)[];

function oneOf<T extends string>(values: readonly T[], v: string | undefined): T | undefined {
  return v !== undefined && (values as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * A repeated parameter reads its FIRST value, as every list does. An empty or
 * whitespace-only search is no search.
 */
export function parseDealListFilters(sp: DealSearchParams): DealListFilters {
  const q = first(sp.q)?.trim();
  const from = first(sp.closed_from);
  const to = first(sp.closed_to);
  const out: DealListFilters = {
    q: q ? q : undefined,
    type: oneOf(DEAL_TYPES, first(sp.type)),
    status: oneOf(DEAL_LIST_STATUSES, first(sp.status)),
    agent: guidOrNull(first(sp.agent)) ?? undefined,
    property: guidOrNull(first(sp.property)) ?? undefined,
    contact: guidOrNull(first(sp.contact)) ?? undefined,
    closed_from: isDayKey(from) ? from : undefined,
    closed_to: isDayKey(to) ? to : undefined,
  };
  // undefined keys left out, so `{}` is "no filter" to every reader
  for (const k of DEAL_LIST_FILTER_KEYS) if (out[k] === undefined) delete out[k];
  return out;
}

/** Whether any register filter is set. */
export function isDealListFiltered(f: DealListFilters): boolean {
  return DEAL_LIST_FILTER_KEYS.some((k) => f[k] !== undefined);
}

/** The search text as it can go into a PostgREST filter: `%`, `,`, `(` and `)` stripped. */
export function dealSearchText(q: string | undefined): string | undefined {
  const safe = q?.replace(/[%,()]/g, " ").trim();
  return safe ? safe : undefined;
}

/**
 * The closed-range predicate: a WON deal whose `won_at`, or a LOST deal whose
 * `lost_at`, falls in [gte, lt) — the half-open UTC interval of the Cyprus
 * days chosen (zonedDateRangeToUtc). The status is part of each arm, so a
 * stray stamp on a deal of the other outcome cannot match; an open deal has no
 * close and never matches. Built only from validated day keys turned into ISO
 * instants — nothing typed reaches this string.
 */
export function closedRangeFilter(from: string | undefined, to: string | undefined): string | null {
  if (!from && !to) return null;
  const { gte, lt } = zonedDateRangeToUtc(from, to);
  const arm = (status: "won" | "lost", column: "won_at" | "lost_at") =>
    `and(${[
      `status.eq.${status}`,
      gte ? `${column}.gte.${gte}` : null,
      lt ? `${column}.lt.${lt}` : null,
    ]
      .filter(Boolean)
      .join(",")})`;
  return `${arm("won", "won_at")},${arm("lost", "lost_at")}`;
}

/**
 * Minimal shape of the part of a Supabase query builder these predicates use.
 * Generic over the concrete builder so the caller keeps its fully-typed row
 * shape; each method returns the same builder type for chaining.
 */
interface DealListFilterBuilder<Q> {
  eq(column: string, value: never): Q;
  in(column: string, values: never): Q;
  or(filter: string): Q;
  ilike(column: string, pattern: string): Q;
}

/**
 * Apply the register's filters to an already-`select()`-ed deals query. The
 * caller adds the order (`created_at desc, id` — unique, the same on the page
 * and in the export) and the range. Each `or()` is its own parameter, and
 * PostgREST ANDs them with every other filter.
 */
export function applyDealListFilters<Q extends DealListFilterBuilder<Q>>(
  query: Q,
  f: DealListFilters,
): Q {
  let q = query;
  const search = dealSearchText(f.q);
  if (search) q = q.ilike("title", `%${search}%`);
  if (f.type) q = q.eq("deal_type", f.type as never);
  if (f.status === "closed") q = q.in("status", ["won", "lost"] as never);
  else if (f.status) q = q.eq("status", f.status as never);
  if (f.agent) q = q.eq("agent_id", f.agent as never);
  if (f.property) q = q.eq("property_id", f.property as never);
  // the contact page's predicate: the deal's buyer or its seller
  if (f.contact) q = q.or(`buyer_contact_id.eq.${f.contact},seller_contact_id.eq.${f.contact}`);
  const closed = closedRangeFilter(f.closed_from, f.closed_to);
  if (closed) q = q.or(closed);
  return q;
}
