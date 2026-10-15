import * as Sentry from "@sentry/nextjs";
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
 * T3.3): deal section saves, stage moves, offer mutations and conversations
 * logged on converted leads recompute their own deal on the caller's session
 * (recomputeDealHealth); property legal saves, buyer KYC saves and mandate
 * changes fan out to every open deal they touch AS THE SYSTEM, inside the
 * saved row's organisation (recomputeDealsFor, T-lm-health-recompute).
 *
 * The score and a factor snapshot are stored on the deal (health_score +
 * health.factors) so kanban cards and the deal page render breakdowns without
 * per-card joins. Derived state only — recomputes write NO event; the
 * triggering mutation is already evented (DECISIONS T3.3). A recompute writes
 * only over the row it read (T-deal-health-race, see recomputeDealHealth).
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
type DealRow = Database["public"]["Tables"]["deals"]["Row"];

/** The columns one recompute reads; `updated_at` is what its write is predicated on. */
type DealForHealth = Pick<
  DealRow,
  "id" | "org_id" | "health" | "buyer_contact_id" | "property_id" | "last_activity_at" | "updated_at"
>;

/**
 * How many times one recompute may read, compute and write: the first
 * attempt, and one retry after a write that found the row moved (see
 * recomputeDealHealth).
 *
 * WHY TWO, AND WHAT GIVING UP LEAVES. Giving up cannot put an old value back —
 * the write that is not made is the only one that could have. What it can
 * leave is a score and factor snapshot OLDER than this recompute's inputs:
 * whoever moved the row after the second read wrote last, and the derived
 * keys are as fresh as that writer leaves them.
 *   - Another recompute: its write is predicated on the row IT read, which is
 *     no older than our second read, so what it stores is at least as fresh.
 *   - A mutation that runs its own recompute once it has committed (the
 *     in-action rule in the header): that recompute reads after the move.
 *   - A writer that runs NO recompute after it: mergeContacts' repoint of
 *     buyer_contact_id / seller_contact_id (admin client, no recompute at
 *     all); a direct PATCH through PostgREST (`authenticated` holds UPDATE on
 *     deals with no column list, 0002, and deals_update scopes rows, not
 *     columns); and a mutation that throws or returns between its commit and
 *     its recompute (BACKLOG "Throws after a commit"). If one of these is the
 *     last mover in a double miss, health_score and health.factors stay as
 *     the last successful recompute left them — which may predate the
 *     mutation that started this one — until the next deal-side recompute.
 * That needs two moves inside one recompute's read-to-write gap. The blind
 * write it replaces would have stored fresher numbers there, but over a
 * `health` it read before both moves — the defect this guard exists for. A
 * third attempt would narrow the window, not close it.
 */
export const HEALTH_WRITE_ATTEMPTS = 2;

/**
 * WHO A RECOMPUTE RUNS AS (T-lm-health-recompute), and what bounds it.
 *   - The caller's SESSION (`orgId: null`): RLS decides which deal it reads
 *     and whether its write lands. A deal action recomputing the deal it is
 *     editing — deals.ts' six call sites, leads.ts' converted deal — has just
 *     written that deal through the same session, so the same session may
 *     write its derived columns. recomputeDealHealth.
 *   - The SYSTEM (`orgId` set): the service-role client, with the deal read,
 *     the selection and the write each filtered to `orgId` explicitly —
 *     nothing else would: the admin client has no RLS. The fan-out after a
 *     property legal save, a buyer's KYC save or a mandate change, whose
 *     caller may update the property or the contact but not, as a rule, the
 *     deals on it (recomputeDealsFor).
 * Either way the other-table reads (buyer KYC, title deed, mandate) are bound
 * to the DEAL'S organisation: `deals.property_id` is a single-column key
 * (0129 and 0139 left it so), and a row loaded past the keys can name another
 * organisation's contact too, so only the predicate keeps another
 * organisation's KYC or title deed out of this deal's score.
 */
type Runner = { db: Client; orgId: string | null };

/**
 * What one recompute did. recomputeDealHealth's callers never see it; the
 * fan-out reports the two that mean a failure (see recomputeDealsFor).
 *   - `written`: the score and snapshot are stored over the row it read.
 *   - `gone`: the deal is not visible (RLS, or another organisation's row on
 *     the system path) or no longer exists.
 *   - `unmoved`: a write matched nothing and the next read found the row
 *     unmoved. On the session path that is RLS refusing the UPDATE (a listing
 *     manager, an agent on someone else's deal); the system has no RLS, so
 *     there it is a write that failed — `code` says how.
 *   - `contended`: every attempt found the row moved (HEALTH_WRITE_ATTEMPTS).
 *   - `read_failed`: the deal read answered an error.
 */
type Outcome =
  | { kind: "written" }
  | { kind: "gone" }
  | { kind: "unmoved"; code: string }
  | { kind: "contended" }
  | { kind: "read_failed"; code: string };

/** The columns one recompute reads; `updated_at` is what its write is predicated on. */
const DEAL_COLUMNS = "id, org_id, health, buyer_contact_id, property_id, last_activity_at, updated_at";

/**
 * Gather live inputs for one deal, compute, and persist score + snapshot —
 * ONLY over the row it read (T-deal-health-race) — on the caller's SESSION:
 * RLS decides what it sees and whether its write lands. For the deal a deal
 * action is editing; the fan-out after a property / contact / mandate save is
 * recomputeDealsFor, which runs as the system.
 *
 * `health` holds one key a person enters (`budget_confirmed`, saved by
 * updateDealSection's health section) beside the two derived here
 * (`factors`, `computed_at`), and the write carries the whole object. Without
 * a guard, a recompute that read before a budget save and wrote after it put
 * the old flag back for good — 25 points gone while the event log said the
 * flag had changed — and even a preserved flag would have sat under a score
 * and a budget factor computed from the old one.
 *
 * So the write is predicated on the row's own `updated_at` exactly as
 * PostgREST served it (the T-optimistic-save idiom; never through `new
 * Date()`). `deals_updated` (0001, BEFORE UPDATE, `set_updated_at()`) stamps
 * now() on EVERY update of deals — any column, any role, definer bodies
 * included — and `deals_closed_guard`, the only other BEFORE UPDATE trigger,
 * raises or returns the row, never skips it. `select("id")` says whether a
 * row was written. Zero rows — or an error, or no rows array at all (a code
 * is not a refusal: an answer lost after the commit looks the same) — is
 * decided by the next read:
 *   - the deal is not visible any more ⇒ stop;
 *   - the same `updated_at` ⇒ the row did not move, so RLS refused the UPDATE
 *     (a listing manager, an agent on someone else's deal) ⇒ stop — the silent
 *     no-op it always was, now at the cost of that one read;
 *   - it moved ⇒ compute again from what was read and write over THAT, within
 *     HEALTH_WRITE_ATTEMPTS.
 *
 * Never throws for a write it could not make: its seven callers (deals.ts six,
 * leads.ts one) have already committed and logged their own mutation and
 * ignore the result. It can still throw where it always could — the mandate
 * read builds the service-role client — and moveDealToStage pages that.
 * Writes no event (derived state, DECISIONS T3.3).
 * supabase/tests/deal-health-race.test.ts forces the race on the real stack.
 */
export async function recomputeDealHealth(supabase: Client, dealId: string): Promise<void> {
  await recompute({ db: supabase, orgId: null }, dealId);
}

/** One recompute, as `run` says: read, compute, write over the row read — retried once on a moved row. */
async function recompute(run: Runner, dealId: string): Promise<Outcome> {
  /** the `updated_at` the previous attempt's write was predicated on, and how that write answered */
  let missed: { at: string; code: string } | null = null;

  for (let attempt = 1; attempt <= HEALTH_WRITE_ATTEMPTS; attempt += 1) {
    // org_id comes back so the other-table reads have an explicit boundary
    // taken from a row that was itself bounded (RLS, or the system's filter)
    let read = run.db.from("deals").select(DEAL_COLUMNS).eq("id", dealId);
    if (run.orgId !== null) read = read.eq("org_id", run.orgId);
    const { data: deal, error: readErr } = await read.maybeSingle();
    if (readErr) return { kind: "read_failed", code: readErr.code || "none" };
    // not visible (RLS, or not this organisation's), or gone
    if (!deal) return { kind: "gone" };
    // not moved since the write that matched nothing
    if (missed !== null && deal.updated_at === missed.at) return { kind: "unmoved", code: missed.code };

    const update = await healthUpdateFor(run, deal);

    let write = run.db.from("deals").update(update).eq("id", dealId);
    if (run.orgId !== null) write = write.eq("org_id", run.orgId);
    const { data: written, error: writeErr } = await write
      .eq("updated_at", deal.updated_at)
      .select("id");
    if (written && written.length > 0) return { kind: "written" };
    missed = { at: deal.updated_at, code: writeErr ? writeErr.code || "none" : "no_row_written" };
  }
  return { kind: "contended" };
}

/** The score and the `health` object to store, computed from one read of the deal. */
async function healthUpdateFor(
  run: Runner,
  deal: DealForHealth,
): Promise<Pick<Database["public"]["Tables"]["deals"]["Update"], "health_score" | "health">> {
  const [buyerRes, propertyRes, mandateRes] = await Promise.all([
    // bound to the deal's organisation: see Runner
    deal.buyer_contact_id
      ? run.db
          .from("contacts")
          .select("kyc")
          .eq("id", deal.buyer_contact_id)
          .eq("org_id", deal.org_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    deal.property_id
      ? run.db
          .from("properties")
          .select("title_deed_status")
          .eq("id", deal.property_id)
          .eq("org_id", deal.org_id)
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
     * client has no RLS to do it. On the system path the runner's own client is
     * the system already; on the session path one is built here, as before.
     *
     * WHAT THIS NEWLY EXPOSES, stated rather than assumed: the deal's agent can
     * now infer from their own deal's health breakdown that the property carries
     * an active mandate. Existence only — `commission_pct` and
     * `commission_notes` are not read here and are not in the score — and it is
     * the property they are already selling. The alternative was continuing to
     * publish a wrong number to everybody, which is the worse of the two.
     */
    deal.property_id
      ? (run.orgId !== null ? run.db : createAdminClient())
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

  return {
    health_score: result.score,
    health: JSON.parse(
      JSON.stringify({
        ...health,
        factors: result.factors,
        computed_at: new Date().toISOString(),
      }),
    ),
  };
}

/** The saved row the fan-out starts from: a property (legal save, mandate change) or a buyer (KYC save). */
export type FanOutAnchor =
  | { propertyId: string; buyerContactId?: never }
  | { buyerContactId: string; propertyId?: never };

/**
 * Fan-out recompute for the open deals on a property, or of a buyer — AS THE
 * SYSTEM, inside the saved row's own organisation (T-lm-health-recompute, the
 * operator's decision on BACKLOG "External audit — 2026-10-14").
 *
 * WHY THE SYSTEM. A title-deed status and a buyer's KYC are deal-health
 * factors, so a legal save (updatePropertySection), a KYC save
 * (updateContactSection) and a mandate change (mandates.ts' recomputeScores)
 * recompute every open deal they touch. On the caller's session a stored score
 * depended on who saved: `properties_update` admits a listing manager and the
 * assigned agent, but `deals_update` (0100) has no listing-manager arm — the
 * PATCH matched 0 rows, silently — and `deals_select` hides from an agent
 * every deal another agent owns, so the assigned agent never even selected it.
 * The deal kept its old factor and score until somebody who may update the
 * deal saved it (the class DECISIONS T-reader fixed for the mandate read).
 *
 * THE BOUNDARY. `session` MUST be the caller's own client. The anchor's
 * `org_id` is read on it, under RLS — the row the caller has just written —
 * and that organisation bounds everything the system then does: the selection
 * (`org_id`, open deals only, as before), each deal's read and write
 * (Runner), and the deal's other-table reads. An anchor the caller cannot see
 * fans out nothing, so the service role is never a way into a row of an
 * organisation the caller does not belong to, nor a way to make it write
 * there: what it writes is derived from that organisation's own rows, onto
 * that organisation's deals, `health` and `health_score` only.
 *
 * RUN IT ONLY AFTER THE CALLER'S OWN WRITE IS PROVEN (a row count): a refused
 * save must not fan out — on the session client RLS used to stop it; here
 * nothing would.
 *
 * NEVER THROWS: its callers have committed and evented their own save. A
 * failure — the anchor unreadable or invisible, the system client not built,
 * the selection failed, a deal's read failed, a write that lands nowhere on an
 * unmoved row (no RLS here to explain it), a throw — is paged in shape only
 * (the step and the code or error name, never a database message; the
 * reportDealClose convention) and the fan-out goes on to the next deal. A
 * double miss under contention is not a failure (HEALTH_WRITE_ATTEMPTS).
 * Writes no event (derived state, DECISIONS T3.3).
 * supabase/tests/deal-health-fan-out.test.ts runs it on the real stack.
 */
export async function recomputeDealsFor(session: Client, anchor: FanOutAnchor): Promise<void> {
  const propertyId = anchor.propertyId ?? null;
  const contactId = anchor.buyerContactId ?? null;
  // exactly one anchor (the type says so; a hand-built call is not trusted)
  if ((propertyId === null) === (contactId === null)) return;
  const at: Record<string, string> = propertyId !== null ? { propertyId } : { contactId: contactId! };

  try {
    // the boundary: the saved row's organisation, as the caller's own session sees it
    const { data: row, error: anchorErr } =
      propertyId !== null
        ? await session.from("properties").select("org_id").eq("id", propertyId).maybeSingle()
        : await session.from("contacts").select("org_id").eq("id", contactId!).maybeSingle();
    if (anchorErr) return reportFanOut("anchor", anchorErr.code || "none", at);
    const orgId = row?.org_id;
    if (typeof orgId !== "string" || orgId === "") return reportFanOut("anchor", "not_visible", at);

    let system: Client;
    try {
      system = createAdminClient();
    } catch (e) {
      return reportFanOut("client", errorName(e), at);
    }

    let selection = system.from("deals").select("id").eq("org_id", orgId).eq("status", "open");
    selection =
      propertyId !== null
        ? selection.eq("property_id", propertyId)
        : selection.eq("buyer_contact_id", contactId!);
    const { data: deals, error: selectErr } = await selection;
    if (selectErr) return reportFanOut("select", selectErr.code || "none", at);
    if (!Array.isArray(deals)) return reportFanOut("select", "no_rows_array", at);

    for (const { id } of deals) {
      try {
        const outcome = await recompute({ db: system, orgId }, id);
        if (outcome.kind === "read_failed") reportFanOut("deal_read", outcome.code, { ...at, dealId: id });
        if (outcome.kind === "unmoved") reportFanOut("write", outcome.code, { ...at, dealId: id });
      } catch (e) {
        reportFanOut("recompute", errorName(e), { ...at, dealId: id });
      }
    }
  } catch (e) {
    reportFanOut("threw", errorName(e), at);
  }
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "threw");

/**
 * The console line is for the runtime log; Sentry is where a human is paged.
 * SHAPE ONLY — the step and the error code or name, plus opaque ids, never a
 * database message (the reportDealClose / site-revalidate convention). The
 * stored scores self-heal at the next recompute of the deal (T3.3).
 */
function reportFanOut(step: string, code: string, extra: Record<string, string>): void {
  const ids = Object.entries(extra)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  console.error(`[health] deal fan-out failed (${step}, ${code}) for ${ids}`);
  try {
    Sentry.captureMessage("[health] deal fan-out failed", {
      level: "error",
      tags: { operation: "health.fan_out", step, code },
      extra,
    });
  } catch {
    // Sentry is best-effort; the console line stands
  }
}
