import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { kycCompletion, type KycState } from "@/lib/constants/checklists";

/**
 * Deal health score 0–100 (doc 02 §C5):
 *   budget confirmed 25 · buyer KYC ≥50% 15 · title deed status known 15 ·
 *   mandate active 15 · activity within 7 days 30 (≤7d full, ≤14d 15, else 0).
 *
 * Recomputed IN-ACTION after relevant mutations, never by cron (playbook
 * T3.3): deal section saves, stage moves, offer mutations, buyer KYC saves,
 * property legal saves, conversations logged on converted leads. The mandate
 * CRUD hook lands with T4.5 — until then mandate changes surface at the next
 * deal-side mutation.
 *
 * The score and a factor snapshot are stored on the deal (health_score +
 * health.factors) so kanban cards and the deal page render breakdowns without
 * per-card joins. Derived state only — recomputes write NO event; the
 * triggering mutation is already evented (DECISIONS T3.3).
 */

export const HEALTH_WEIGHTS = {
  budget: 25,
  kyc: 15,
  title_deed: 15,
  mandate: 15,
  activity: 30,
} as const;

export type HealthFactorKey = keyof typeof HEALTH_WEIGHTS;

export interface HealthFactor {
  key: HealthFactorKey;
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface HealthInputs {
  budgetConfirmed: boolean;
  /** Buyer KYC completion 0–100; null = no buyer linked */
  buyerKycPct: number | null;
  /** property.title_deed_status !== 'unknown'; null = no property linked */
  titleDeedKnown: boolean | null;
  /** Active mandate exists on the property; null = no property linked */
  mandateActive: boolean | null;
  lastActivityAt: string | Date | null;
}

export interface HealthResult {
  score: number;
  factors: HealthFactor[];
}

const DAY_MS = 86_400_000;

/** Pure — unit-tested (activity decay at 7/14 days, conversation raises score). */
export function computeHealth(inputs: HealthInputs, now: Date = new Date()): HealthResult {
  const factors: HealthFactor[] = [];

  factors.push({
    key: "budget",
    label: "Budget confirmed",
    points: inputs.budgetConfirmed ? HEALTH_WEIGHTS.budget : 0,
    max: HEALTH_WEIGHTS.budget,
    detail: inputs.budgetConfirmed ? "confirmed" : "not confirmed",
  });

  const kycMet = inputs.buyerKycPct !== null && inputs.buyerKycPct >= 50;
  factors.push({
    key: "kyc",
    label: "Buyer KYC ≥ 50%",
    points: kycMet ? HEALTH_WEIGHTS.kyc : 0,
    max: HEALTH_WEIGHTS.kyc,
    detail: inputs.buyerKycPct === null ? "no buyer linked" : `${inputs.buyerKycPct}% complete`,
  });

  factors.push({
    key: "title_deed",
    label: "Title deed status known",
    points: inputs.titleDeedKnown ? HEALTH_WEIGHTS.title_deed : 0,
    max: HEALTH_WEIGHTS.title_deed,
    detail:
      inputs.titleDeedKnown === null
        ? "no property linked"
        : inputs.titleDeedKnown
          ? "known"
          : "unknown",
  });

  factors.push({
    key: "mandate",
    label: "Mandate active",
    points: inputs.mandateActive ? HEALTH_WEIGHTS.mandate : 0,
    max: HEALTH_WEIGHTS.mandate,
    detail:
      inputs.mandateActive === null
        ? "no property linked"
        : inputs.mandateActive
          ? "active"
          : "none active",
  });

  // ≤7d full, ≤14d 15, else 0 (doc 02 §C5)
  let activityPoints = 0;
  let activityDetail = "no activity recorded";
  if (inputs.lastActivityAt) {
    const last =
      typeof inputs.lastActivityAt === "string"
        ? new Date(inputs.lastActivityAt)
        : inputs.lastActivityAt;
    const days = (now.getTime() - last.getTime()) / DAY_MS;
    if (days <= 7) activityPoints = HEALTH_WEIGHTS.activity;
    else if (days <= 14) activityPoints = 15;
    activityDetail = `${Math.max(0, Math.floor(days))}d since last activity`;
  }
  factors.push({
    key: "activity",
    label: "Recent activity",
    points: activityPoints,
    max: HEALTH_WEIGHTS.activity,
    detail: activityDetail,
  });

  return { score: factors.reduce((sum, f) => sum + f.points, 0), factors };
}

type Client = SupabaseClient<Database>;

/** Gather live inputs for one deal, compute, and persist score + snapshot. */
export async function recomputeDealHealth(supabase: Client, dealId: string): Promise<void> {
  const { data: deal } = await supabase
    .from("deals")
    // org_id comes back so the mandate read below (which runs as the system)
    // has an explicit boundary taken from a row RLS already returned
    .select("id, org_id, health, buyer_contact_id, property_id, last_activity_at")
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) return;

  const [buyerRes, propertyRes, mandateRes] = await Promise.all([
    deal.buyer_contact_id
      ? supabase.from("contacts").select("kyc").eq("id", deal.buyer_contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    deal.property_id
      ? supabase
          .from("properties")
          .select("title_deed_status")
          .eq("id", deal.property_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    /*
     * READ AS THE SYSTEM — a stored score must not depend on who saved it.
     *
     * "Does this property have an active mandate" is a fact about the PROPERTY,
     * but the answer was coming from the deal editor's own view of `mandates`.
     * `mandates_insert` is admin-only, so `created_by` is always an admin and the
     * agent arm `created_by = auth.uid()` can never fire; the only arm left is
     * `properties.assigned_agent_id = auth.uid()`. Nothing in
     * `deals_update_agent` ties a deal's agent to the property's assigned agent
     * — so a buyer-side agent editing their own deal on someone else's listing
     * read zero mandates and PERSISTED the 15-point factor as "none active", to
     * `deals.health_score` and the `health.factors` snapshot that the deal page
     * and every kanban card render to everyone, admins included, until the next
     * save by someone who could see it flipped it back.
     *
     * `mandates_safe` is not the answer here (it is for the property LIST and
     * for recomputeQualityScore, whose callers are all admin, listing manager or
     * the ASSIGNED agent — `properties_update` guarantees that). The view keeps
     * the agent arm, so it returns zero for exactly this caller too. Only the
     * system can answer it, with org_id filtered explicitly because the admin
     * client has no RLS to do it.
     *
     * WHAT THIS NEWLY EXPOSES, stated rather than assumed: the deal's agent can
     * now infer from their own deal's health breakdown that the property carries
     * an active mandate. Existence only — `commission_pct` and
     * `commission_notes` are not read here and are not in the score — and it is
     * the property they are already selling. The alternative was continuing to
     * publish a wrong number to everybody, which is the worse of the two.
     */
    deal.property_id
      ? createAdminClient()
          .from("mandates")
          .select("id")
          .eq("org_id", deal.org_id)
          .eq("property_id", deal.property_id)
          .eq("status", "active")
          .limit(1)
      : Promise.resolve({ data: [] as { id: string }[] }),
  ]);

  const health = (deal.health ?? {}) as Record<string, unknown>;
  const result = computeHealth({
    budgetConfirmed: health.budget_confirmed === true,
    buyerKycPct: buyerRes.data ? kycCompletion((buyerRes.data.kyc ?? {}) as KycState) : null,
    titleDeedKnown: propertyRes.data ? propertyRes.data.title_deed_status !== "unknown" : null,
    mandateActive: deal.property_id ? (mandateRes.data ?? []).length > 0 : null,
    lastActivityAt: deal.last_activity_at,
  });

  await supabase
    .from("deals")
    .update({
      health_score: result.score,
      health: JSON.parse(
        JSON.stringify({
          ...health,
          factors: result.factors,
          computed_at: new Date().toISOString(),
        }),
      ),
    })
    .eq("id", dealId);
}

/** Fan-out recompute for open deals touching a contact (buyer) or property. */
export async function recomputeDealsFor(
  supabase: Client,
  filter: { buyerContactId?: string; propertyId?: string },
): Promise<void> {
  if (!filter.buyerContactId && !filter.propertyId) return;
  let query = supabase.from("deals").select("id").eq("status", "open");
  if (filter.buyerContactId) query = query.eq("buyer_contact_id", filter.buyerContactId);
  if (filter.propertyId) query = query.eq("property_id", filter.propertyId);
  const { data } = await query;
  for (const d of data ?? []) {
    await recomputeDealHealth(supabase, d.id);
  }
}
