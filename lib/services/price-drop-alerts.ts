import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { logEvent } from "@/lib/services/events";
import {
  BUDGET_TOLERANCE_PCT,
  matchProperty,
  type MatchCandidate,
  type MatchRequirement,
  type TransactionType,
} from "@/lib/services/matching";
import { cyprusEndOfDay } from "@/lib/validators/reservations";

/**
 * Price-drop alerts — the first PUSH use of the matching engine (BACKLOG,
 * follow-on from the 2026-08-23 review, which listed it as its own automation
 * example).
 *
 * Matching so far is a pull: an agent opens a contact and looks. This is the
 * other direction — the desk is told when a price change puts a property inside
 * somebody's budget for the first time.
 *
 * **No migration.** `tasks` has carried `kind`, `property_id` and `assignee_id`
 * since 0020, and a task is how this codebase already tells people things
 * (0012 renewals, 0020 nudges). Inventing a notifications table for one rule
 * would be scope nobody asked for.
 *
 * WHY THIS IS NOT A pg_cron JOB, like the other sweeps: the matching rules live
 * in TypeScript (`matching.ts`), deliberately, so they can be tested without a
 * database. A SQL cron cannot call them, and duplicating the rules in SQL is
 * exactly the drift that `matching.ts` exists to prevent. So it runs in the
 * action that changes the price.
 */

type Client = SupabaseClient<Database>;

/** The task `kind` this feature owns, alongside 0012's and 0020's. */
export const PRICE_DROP_TASK_KIND = "price_drop_match";

/**
 * Only a genuine decrease between two known prices.
 *
 * Pricing a previously unpriced property is a NEW LISTING, not a drop — a
 * different event with a different audience, and a BACKLOG line of its own.
 * Removing a price is not a drop either.
 *
 * There is deliberately NO minimum drop. A "meaningful change" threshold would
 * be a number nobody could defend, and `wasPricedOut` already suppresses every
 * drop that does not cross somebody's ceiling — including a €1 one, unless that
 * €1 is the euro that matters.
 */
export function isAlertableDrop(oldPrice: number | null, newPrice: number | null): boolean {
  if (oldPrice === null || newPrice === null) return false;
  if (!Number.isFinite(oldPrice) || !Number.isFinite(newPrice)) return false;
  return newPrice < oldPrice;
}

/**
 * Was this buyer priced out BEFORE, and in reach now?
 *
 * This is the crux. "Can they afford it now" would alert every buyer who
 * already matched, on every drop — noise the desk would learn to ignore within
 * a week. The question is whether the drop changed the answer for them.
 *
 * Uses `BUDGET_TOLERANCE_PCT`, the same ceiling `matchProperty` applies. If the
 * two disagreed, a buyer could be alerted and then not appear in the match
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
  // exactly that and the feature silently did nothing: no task, no event, no
  // error, on a save that otherwise succeeded. `matching.ts` avoids this with
  // its own `num()` helper; this is the same trap in a second place.
  const budget = budgetMax === null ? NaN : Number(budgetMax);
  if (!Number.isFinite(budget) || budget <= 0) return false;
  const ceiling = budget * (1 + BUDGET_TOLERANCE_PCT / 100);
  return oldPrice > ceiling && newPrice <= ceiling;
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

export interface PriceDropResult {
  /** buyers who were priced out before and match now */
  newlyMatching: number;
  /** a task was created (false when there was already an open one) */
  taskCreated: boolean;
}

/**
 * Find the buyers a price drop just brought into range, and raise one task.
 *
 * Best-effort by design: the caller has already saved the price, and a failure
 * here must never turn a successful save into an error the user sees. It
 * returns what happened; it does not throw.
 */
export async function raisePriceDropAlert(
  supabase: Client,
  args: {
    orgId: string;
    actorId: string;
    property: MatchCandidate & { reference: string; assigned_agent_id: string | null };
    oldAskingPrice: number | null;
    oldRentPrice: number | null;
  },
): Promise<PriceDropResult> {
  const none: PriceDropResult = { newlyMatching: 0, taskCreated: false };
  const { property } = args;

  // A container has no price of its own worth alerting on; its units do.
  const { data: reqRows, error: reqErr } = await supabase
    .from("buyer_requirements")
    .select(
      "id, contact_id, transaction_type, property_types, district_ids, area_ids, budget_min, " +
        "budget_max, bedrooms_min, bedrooms_max, bathrooms_min, covered_area_min_sqm, " +
        "plot_area_min_sqm, title_deed_required, vat_preference, max_sea_distance_m, " +
        "delivery_by, features_required",
    )
    .eq("is_active", true)
    .not("budget_max", "is", null);
  if (reqErr || !reqRows?.length) return none;

  const newlyMatching: { requirementId: string; contactId: string }[] = [];
  for (const row of reqRows as unknown as (MatchRequirement & {
    id: string;
    contact_id: string;
  })[]) {
    // Compare like with like: a rental requirement is judged on the rent.
    const oldPrice =
      row.transaction_type === "rent" ? args.oldRentPrice : args.oldAskingPrice;
    const newPrice = priceFor(row.transaction_type, property);
    if (!isAlertableDrop(oldPrice, newPrice)) continue;
    if (!wasPricedOut(row.budget_max, oldPrice as number, newPrice as number)) continue;
    // Priced out before and in reach now — but everything ELSE must match too,
    // or a drop would alert a buyer who wanted a villa about an apartment.
    if (!matchProperty(row, property).eligible) continue;
    newlyMatching.push({ requirementId: row.id, contactId: row.contact_id });
  }

  if (newlyMatching.length === 0) return none;

  // IDEMPOTENCE, and how it differs from 0020 deliberately. 0020 keys its
  // nudges to a CYCLE because the condition recurs on a clock. Here the
  // condition is a STATE: "there is an unactioned price-drop alert on this
  // property". A second drop while the first alert is still open adds nothing —
  // the agent has not looked at the first one yet. Completing the task arms it
  // again, which is the behaviour a desk expects.
  const { count: openAlready } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("property_id", property.id)
    .eq("kind", PRICE_DROP_TASK_KIND)
    .eq("is_done", false);
  if ((openAlready ?? 0) > 0) {
    return { newlyMatching: newlyMatching.length, taskCreated: false };
  }

  // Due end of tomorrow, Cyprus time — a price drop is worth acting on quickly
  // but is not a same-hour emergency, and a midnight-UTC stamp would read
  // "overdue" for the whole of its final day (0012/0020's lesson).
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .insert({
      org_id: args.orgId,
      title:
        `Price drop on ${property.reference}: ${newlyMatching.length} ` +
        `buyer${newlyMatching.length === 1 ? "" : "s"} now in budget`,
      due_at: cyprusEndOfDay(tomorrow).toISOString(),
      // the listing's agent; the actor is the fallback so it is never invisible
      assignee_id: property.assigned_agent_id ?? args.actorId,
      property_id: property.id,
      kind: PRICE_DROP_TASK_KIND,
      created_by: args.actorId,
    })
    .select("id")
    .single();
  if (taskErr || !task) {
    // NOT SILENT. The first version discarded this, and when `tasks_kind_chk`
    // rejected the new `kind` the whole feature did nothing on a save that
    // otherwise succeeded — no task, no event, no error, nothing in any log.
    // That cost a full end-to-end debug cycle to find. 0045 admits the kind;
    // this line is what would have said so in one line.
    console.error("price-drop alert: task insert failed", {
      propertyId: property.id,
      error: taskErr?.message,
    });
    return { newlyMatching: newlyMatching.length, taskCreated: false };
  }

  await logEvent(supabase, {
    orgId: args.orgId,
    actorId: args.actorId,
    entityType: "property",
    entityId: property.id,
    eventType: "price_drop_matched",
    payload: {
      task_id: task.id,
      buyers: newlyMatching.length,
      contact_ids: newlyMatching.map((m) => m.contactId),
    },
  });

  return { newlyMatching: newlyMatching.length, taskCreated: true };
}
