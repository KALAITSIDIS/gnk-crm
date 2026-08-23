import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  BUDGET_TOLERANCE_PCT,
  matchProperty,
  type MatchCandidate,
  type MatchRequirement,
  type MatchVerdict,
} from "@/lib/services/matching";

/**
 * Candidate fetch for buyer ↔ property matching (0043, T-B6/B7).
 *
 * THE HARD FILTERS GO INTO SQL, THE SCORE STAYS IN TYPESCRIPT. Fetching the
 * whole property table and filtering in memory is the PERF-3 mistake (0018)
 * repeated — that one silently under-reported money past a row cap, and this
 * one would silently drop matches past it. Everything `matchProperty` treats as
 * a blocker and Postgres can express is pushed down; the soft score, which
 * needs the weights, runs on the survivors.
 *
 * RLS DOES THE SCOPING. These run on the caller's client, so an agent only ever
 * scores properties they were already allowed to open. There is no org filter
 * in the query text on purpose — adding one would imply the policies are not
 * trusted, and doc 04 says they are (and RLS test 30 proves it for this table).
 */

type Client = SupabaseClient<Database>;

/** How many scored rows a surface shows before it starts hiding things. */
export const MATCH_PAGE_SIZE = 20;

/**
 * Fetch cap. Deliberately larger than the page size: the score is computed
 * AFTER the fetch, so cutting at 20 in SQL would rank 20 arbitrary rows rather
 * than the best 20. This takes a wider slice, scores it, then trims — and
 * reports when it hit the cap so the UI never presents a truncated list as
 * complete (B1's lesson: a silently truncated list is indistinguishable from a
 * complete one).
 */
const CANDIDATE_CAP = 400;

export interface ScoredProperty {
  verdict: MatchVerdict;
  property: MatchCandidate & {
    reference: string;
    title: Record<string, string> | null;
    currency: string | null;
  };
}

export interface MatchResult<T> {
  rows: T[];
  /** true when the candidate cap was reached — more may exist than were scored */
  capped: boolean;
  /** how many candidates survived the hard filters and were scored */
  considered: number;
}

const CANDIDATE_COLUMNS =
  "id, reference, title, status, transaction_type, property_type, district_id, area_id, " +
  "currency, asking_price, rent_price_month, bedrooms, bathrooms, covered_area_sqm, " +
  "plot_area_sqm, title_deed_status, vat_status, sea_distance_m, delivery_date, features";

/** The three statuses `matchProperty` accepts — kept in step with it by tests. */
const MATCHABLE_STATUSES = ["available", "reserved", "under_offer"] as const;

type DbTransactionType = Database["public"]["Enums"]["transaction_type"];
type DbPropertyType = Database["public"]["Enums"]["property_type"];

/**
 * Transaction types on a PROPERTY that can satisfy this requirement.
 * `sale_or_rent` satisfies both sides, so it is always included.
 */
function compatibleTransactionTypes(
  want: MatchRequirement["transaction_type"],
): DbTransactionType[] {
  if (want === "sale_or_rent") return ["sale", "rent", "sale_or_rent"];
  return [want, "sale_or_rent"];
}

/** Properties that could suit one buyer requirement, best first. */
export async function findMatchingProperties(
  supabase: Client,
  req: MatchRequirement,
): Promise<MatchResult<ScoredProperty>> {
  let q = supabase
    .from("properties")
    .select(CANDIDATE_COLUMNS)
    .in("status", MATCHABLE_STATUSES)
    .in("transaction_type", compatibleTransactionTypes(req.transaction_type))
    // a project or phase is a container, not a thing anyone buys
    .neq("kind", "project")
    .neq("kind", "phase")
    .limit(CANDIDATE_CAP);

  // The validator already restricts these to PROPERTY_TYPES, so the enum
  // narrowing the generated types want is satisfied in fact, not just claimed.
  if (req.property_types.length > 0) {
    q = q.in("property_type", req.property_types as DbPropertyType[]);
  }
  if (req.district_ids.length > 0) q = q.in("district_id", req.district_ids);
  if (req.bedrooms_min !== null) q = q.gte("bedrooms", req.bedrooms_min);
  if (req.bedrooms_max !== null) q = q.lte("bedrooms", req.bedrooms_max);
  if (req.title_deed_required) q = q.eq("title_deed_status", "separate");

  // The budget ceiling INCLUDING the tolerance, so the SQL never rejects a row
  // that matchProperty would have kept. It is a coarse pre-filter; the precise
  // decision (and the overage figure) still comes from the engine.
  //
  // `or(...)` keeps unpriced rows in — matchProperty shows them with a
  // `price_unknown` miss rather than hiding live inventory (0041 ships an
  // unpriced unit on purpose).
  if (req.budget_max !== null) {
    const ceiling = req.budget_max * (1 + BUDGET_TOLERANCE_PCT / 100);
    const column = req.transaction_type === "rent" ? "rent_price_month" : "asking_price";
    q = q.or(`${column}.lte.${ceiling},${column}.is.null`);
  }

  const { data, error } = await q;
  if (error) throw new Error(`Query failed (matching properties): ${error.message}`);

  const candidates = (data ?? []) as unknown as ScoredProperty["property"][];
  const scored: ScoredProperty[] = [];
  for (const property of candidates) {
    const verdict = matchProperty(req, property);
    // The SQL pre-filter is coarser than the engine, so re-check rather than
    // assume: `.in()` on a nullable column and the null-tolerant budget clause
    // both let rows through that the engine still rejects.
    if (verdict.eligible) scored.push({ verdict, property });
  }

  scored.sort(
    (a, b) => b.verdict.score - a.verdict.score || a.property.reference.localeCompare(b.property.reference),
  );

  return {
    rows: scored.slice(0, MATCH_PAGE_SIZE),
    capped: candidates.length >= CANDIDATE_CAP,
    considered: scored.length,
  };
}

export interface ScoredBuyer {
  verdict: MatchVerdict;
  requirementId: string;
  label: string | null;
  contactId: string;
  contactName: string;
  agentName: string | null;
}

/** Active buyer requirements this property could suit, best first. */
export async function findMatchingBuyers(
  supabase: Client,
  property: MatchCandidate,
): Promise<MatchResult<ScoredBuyer>> {
  let q = supabase
    .from("buyer_requirements")
    .select(
      "id, label, contact_id, transaction_type, property_types, district_ids, area_ids, " +
        "budget_min, budget_max, bedrooms_min, bedrooms_max, bathrooms_min, " +
        "covered_area_min_sqm, plot_area_min_sqm, title_deed_required, vat_preference, " +
        "max_sea_distance_m, delivery_by, features_required, " +
        "contacts!inner(id, display_name, assigned_agent_id, is_archived)",
    )
    .eq("is_active", true)
    .eq("contacts.is_archived", false)
    .limit(CANDIDATE_CAP);

  // `sale_or_rent` on the property satisfies every requirement type, so only a
  // narrower listing can constrain the requirement side.
  if (property.transaction_type !== "sale_or_rent") {
    q = q.in("transaction_type", [property.transaction_type, "sale_or_rent"]);
  }

  // An empty array means "no opinion" and must still match, so this cannot be a
  // plain containment test — `or` keeps the unconstrained requirements in.
  if (property.district_id) {
    q = q.or(`district_ids.cs.{${property.district_id}},district_ids.eq.{}`);
  }

  const { data, error } = await q;
  if (error) throw new Error(`Query failed (matching buyers): ${error.message}`);

  type Row = MatchRequirement & {
    id: string;
    label: string | null;
    contact_id: string;
    contacts: { id: string; display_name: string; assigned_agent_id: string | null } | null;
  };

  const rows = (data ?? []) as unknown as Row[];
  const scored: ScoredBuyer[] = [];
  for (const r of rows) {
    const verdict = matchProperty(r, property);
    if (!verdict.eligible) continue;
    scored.push({
      verdict,
      requirementId: r.id,
      label: r.label,
      contactId: r.contact_id,
      contactName: r.contacts?.display_name ?? "—",
      agentName: null,
    });
  }

  scored.sort(
    (a, b) => b.verdict.score - a.verdict.score || a.contactName.localeCompare(b.contactName),
  );

  return {
    rows: scored.slice(0, MATCH_PAGE_SIZE),
    capped: rows.length >= CANDIDATE_CAP,
    considered: scored.length,
  };
}
