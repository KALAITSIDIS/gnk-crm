import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { logEvent } from "@/lib/services/events";
import {
  BUDGET_TOLERANCE_PCT,
  MATCHABLE_STATUSES,
  matchProperty,
  type MatchCandidate,
  type MatchRequirement,
  type PropertyStatus,
  type TransactionType,
} from "@/lib/services/matching";
import { cyprusEndOfDay } from "@/lib/validators/reservations";

/**
 * Match alerts — the PUSH side of the matching engine.
 *
 * Matching on the contact and property pages is a pull: an agent opens a record
 * and looks. These are the other direction — the desk is told when something
 * changes that puts a property in front of a buyer who could not see it before.
 *
 * Two triggers, and the distinction between them is the whole design:
 *
 *   PRICE DROP    — the property was always visible, but out of reach. The
 *                   question is whether the drop crossed somebody's ceiling.
 *   NEW LISTING   — the property was not on the market at all. The question is
 *                   whether its status just entered a matchable state.
 *
 * **Both ask "what changed for this buyer", never "does this match now".** The
 * second form alerts every already-matching buyer on every edit, which is noise
 * a desk learns to ignore within a week — and an ignored alert is worse than no
 * alert, because it buries the real ones too.
 *
 * NOT pg_cron, unlike the other sweeps: the rules live in TypeScript
 * (`matching.ts`) so they can be tested without a database, and duplicating
 * them in SQL is exactly the drift that module exists to prevent. So these hook
 * the action that makes the change, best-effort, and can never turn a
 * successful save into an error the user sees.
 */

type Client = SupabaseClient<Database>;

/** Task kinds this module owns. Both are admitted by `tasks_kind_chk`. */
export const PRICE_DROP_TASK_KIND = "price_drop_match";
export const NEW_LISTING_TASK_KIND = "new_listing_match";

// ---------------------------------------------------------------- triggers --

/**
 * Only a genuine decrease between two known prices.
 *
 * Pricing a previously UNPRICED property is deliberately excluded, and NOT
 * because it belongs to the new-listing path — it belongs to NEITHER. An
 * unpriced property already passes the budget hard filter (`matchProperty`
 * skips it when the price is null), so it is already eligible for everyone.
 * Setting a price can therefore only ever REMOVE a match, never create one.
 * A test pins that, because an earlier BACKLOG note of mine claimed otherwise.
 *
 * There is deliberately no minimum drop: a "meaningful change" threshold is a
 * number nobody can defend, and `wasPricedOut` already suppresses every drop
 * that fails to cross a ceiling — including a €1 one, unless that is the euro
 * that matters.
 */
export function isAlertableDrop(oldPrice: number | null, newPrice: number | null): boolean {
  if (oldPrice === null || newPrice === null) return false;
  if (!Number.isFinite(oldPrice) || !Number.isFinite(newPrice)) return false;
  return newPrice < oldPrice;
}

/**
 * Was this buyer priced out BEFORE, and in reach now?
 *
 * Uses `BUDGET_TOLERANCE_PCT`, the same ceiling `matchProperty` applies. If the
 * two disagreed, a buyer could be alerted and then be absent from the match
 * list, or sit in the list and never be alerted.
 */
export function wasPricedOut(
  budgetMax: number | string | null,
  oldPrice: number,
  newPrice: number,
): boolean {
  // COERCE, do not merely check. Postgres `numeric` arrives from PostgREST as a
  // STRING — budget_max is "700000.00" — and `Number.isFinite` does not coerce,
  // so testing it directly rejects every real row. The first version did
  // exactly that and the feature silently did nothing.
  const budget = budgetMax === null ? NaN : Number(budgetMax);
  if (!Number.isFinite(budget) || budget <= 0) return false;
  const ceiling = budget * (1 + BUDGET_TOLERANCE_PCT / 100);
  return oldPrice > ceiling && newPrice <= ceiling;
}

/**
 * Did this property just come onto the market?
 *
 * The precise question, and the reason this is a STATUS test rather than a "was
 * it created recently" one: `matchProperty` hard-blocks any status outside
 * `MATCHABLE_STATUSES`, so a property in `draft` is invisible to every buyer no
 * matter how well it fits. Entering that set is the moment it becomes visible.
 *
 * That covers more than a first publication, correctly: a withdrawn listing put
 * back on, or a sale that fell through and returned to `available`, are new
 * listings to a buyer who was never shown them.
 *
 * Reads `MATCHABLE_STATUSES` from `matching.ts` rather than restating it. If
 * the two ever disagreed, this would fire for a property the matcher still
 * hides, or stay silent for one it shows.
 */
export function becameMatchable(
  from: PropertyStatus | null,
  to: PropertyStatus | null,
): boolean {
  if (to === null || !MATCHABLE_STATUSES.includes(to)) return false;
  if (from === null) return true; // no prior state: it is arriving on the market
  return !MATCHABLE_STATUSES.includes(from);
}

/** The price a requirement of this transaction type compares against. */
export function priceFor(
  transactionType: TransactionType,
  p: { asking_price: number | null; rent_price_month: number | null },
): number | null {
  const raw = transactionType === "rent" ? p.rent_price_month : p.asking_price;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- shared ----

const REQUIREMENT_COLUMNS =
  "id, contact_id, transaction_type, property_types, district_ids, area_ids, budget_min, " +
  "budget_max, bedrooms_min, bedrooms_max, bathrooms_min, covered_area_min_sqm, " +
  "plot_area_min_sqm, title_deed_required, vat_preference, max_sea_distance_m, " +
  "delivery_by, features_required";

type RequirementRow = MatchRequirement & { id: string; contact_id: string };

export interface AlertProperty extends MatchCandidate {
  reference: string;
  assigned_agent_id: string | null;
}

export interface MatchAlertResult {
  /** buyers for whom this change opened something that was closed before */
  newlyMatching: number;
  /** a task was created (false when one was already open, or the insert failed) */
  taskCreated: boolean;
}

const NONE: MatchAlertResult = { newlyMatching: 0, taskCreated: false };

async function activeRequirements(
  supabase: Client,
  opts: { budgetedOnly: boolean },
): Promise<RequirementRow[]> {
  let q = supabase.from("buyer_requirements").select(REQUIREMENT_COLUMNS).eq("is_active", true);
  if (opts.budgetedOnly) q = q.not("budget_max", "is", null);
  const { data, error } = await q;
  if (error || !data?.length) return [];
  return data as unknown as RequirementRow[];
}

/**
 * One task per alert, and one open alert at a time per property per kind.
 *
 * IDEMPOTENCE, and how it differs from 0020 deliberately. 0020 keys its nudges
 * to a CYCLE because the condition recurs on a clock. Here the condition is a
 * STATE: "there is an unactioned alert of this kind on this property". A second
 * change while the first is still open adds nothing — the agent has not looked
 * at the first one. Completing the task arms it again.
 */
async function raiseOneTask(
  supabase: Client,
  args: {
    orgId: string;
    actorId: string;
    property: AlertProperty;
    kind: string;
    title: string;
    eventType: string;
    contactIds: string[];
  },
): Promise<MatchAlertResult> {
  const { property, contactIds } = args;

  const { count: openAlready } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("property_id", property.id)
    .eq("kind", args.kind)
    .eq("is_done", false);
  if ((openAlready ?? 0) > 0) {
    return { newlyMatching: contactIds.length, taskCreated: false };
  }

  // Due end of tomorrow, Cyprus time. Worth acting on quickly but not a
  // same-hour emergency, and a midnight-UTC stamp would read "overdue" for the
  // whole of its final day (0012/0020's lesson).
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .insert({
      org_id: args.orgId,
      title: args.title,
      due_at: cyprusEndOfDay(tomorrow).toISOString(),
      // the listing's agent; the actor is the fallback so it is never invisible
      assignee_id: property.assigned_agent_id ?? args.actorId,
      property_id: property.id,
      kind: args.kind,
      created_by: args.actorId,
    })
    .select("id")
    .single();

  if (taskErr || !task) {
    // NOT SILENT. An earlier version discarded this, and when `tasks_kind_chk`
    // rejected a new `kind` the whole feature did nothing on a save that
    // otherwise succeeded — no task, no event, nothing in any log. That cost a
    // full end-to-end debug cycle; this line is what would have said so.
    console.error("match alert: task insert failed", {
      propertyId: property.id,
      kind: args.kind,
      error: taskErr?.message,
    });
    return { newlyMatching: contactIds.length, taskCreated: false };
  }

  await logEvent(supabase, {
    orgId: args.orgId,
    actorId: args.actorId,
    entityType: "property",
    entityId: property.id,
    eventType: args.eventType,
    payload: { task_id: task.id, buyers: contactIds.length, contact_ids: contactIds },
  });

  return { newlyMatching: contactIds.length, taskCreated: true };
}

// ---------------------------------------------------------------- alerts ----

/** Buyers a price drop just brought into range. */
export async function raisePriceDropAlert(
  supabase: Client,
  args: {
    orgId: string;
    actorId: string;
    property: AlertProperty;
    oldAskingPrice: number | null;
    oldRentPrice: number | null;
  },
): Promise<MatchAlertResult> {
  const { property } = args;
  const rows = await activeRequirements(supabase, { budgetedOnly: true });
  if (rows.length === 0) return NONE;

  const contactIds: string[] = [];
  for (const row of rows) {
    const oldPrice = row.transaction_type === "rent" ? args.oldRentPrice : args.oldAskingPrice;
    const newPrice = priceFor(row.transaction_type, property);
    if (!isAlertableDrop(oldPrice, newPrice)) continue;
    if (!wasPricedOut(row.budget_max, oldPrice as number, newPrice as number)) continue;
    // Priced out before and in reach now — but everything ELSE must match too,
    // or a drop would alert a buyer who wanted a villa about an apartment.
    if (!matchProperty(row, property).eligible) continue;
    contactIds.push(row.contact_id);
  }
  if (contactIds.length === 0) return NONE;

  return raiseOneTask(supabase, {
    orgId: args.orgId,
    actorId: args.actorId,
    property,
    kind: PRICE_DROP_TASK_KIND,
    eventType: "price_drop_matched",
    contactIds,
    title:
      `Price drop on ${property.reference}: ${contactIds.length} ` +
      `buyer${contactIds.length === 1 ? "" : "s"} now in budget`,
  });
}

/**
 * Buyers who match a property that has just come onto the market.
 *
 * No "was priced out" test here, and none is needed: the property was invisible
 * to EVERY buyer a moment ago, so every buyer it matches now is a new match.
 * `matchProperty` alone is the filter.
 */
export async function raiseNewListingAlert(
  supabase: Client,
  args: {
    orgId: string;
    actorId: string;
    property: AlertProperty;
    previousStatus: PropertyStatus | null;
  },
): Promise<MatchAlertResult> {
  const { property } = args;
  if (!becameMatchable(args.previousStatus, property.status)) return NONE;

  // budgetedOnly would be WRONG here. A buyer with no ceiling still matches,
  // and on this alert they are as newly-served as anyone — it is the price-drop
  // path, not this one, that needs a budget to reason about.
  const rows = await activeRequirements(supabase, { budgetedOnly: false });
  if (rows.length === 0) return NONE;

  const contactIds: string[] = [];
  for (const row of rows) {
    if (!matchProperty(row, property).eligible) continue;
    contactIds.push(row.contact_id);
  }
  if (contactIds.length === 0) return NONE;

  return raiseOneTask(supabase, {
    orgId: args.orgId,
    actorId: args.actorId,
    property,
    kind: NEW_LISTING_TASK_KIND,
    eventType: "new_listing_matched",
    contactIds,
    title:
      `${property.reference} is on the market: ${contactIds.length} ` +
      `matching buyer${contactIds.length === 1 ? "" : "s"}`,
  });
}
