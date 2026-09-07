import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { logEvent } from "@/lib/services/events";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  cyprusEndOfDay,
  isLiveReservation,
  type ReservationStatus,
} from "@/lib/validators/reservations";

/**
 * Close the loop on `listing_status_check` prompts (2026-09-01 review).
 *
 * markDealWon raises an open, immediately-due task when a won deal's listing
 * still reads on-market — but nothing ever closed it: the agent would update
 * the status exactly as asked and the task sat open forever. A prompt that
 * survives being obeyed teaches the desk to ignore prompts, which is the
 * failure mode every other machine-checkable followup kind avoids by being
 * superseded the moment its predicate stops holding (the mandates
 * `supersedeRenewalTasks` idiom, the 0052/0075/0078 sweep-arm reasons).
 *
 * Called from the two places a listing's status is saved (property details
 * section, unit status) AFTER the status write has been proven by its
 * returned row. The reason states only what the predicate proved: the status
 * is now off-market. Idempotent — an empty match writes nothing.
 *
 * THE SUPERSEDE RUNS AS THE SYSTEM, NOT AS THE CALLER, and that is deliberate.
 * `tasks_update` is assignee-scoped — admin, or `assignee_id = auth.uid()` —
 * so on the caller's client this matched ZERO ROWS whenever the person saving
 * the status was not the person the prompt was assigned to, which is the
 * ordinary case: the prompt goes to the deal's agent, and anyone may set a
 * listing to sold. No error, nothing logged, and the prompt stayed open having
 * been obeyed. Measured in supabase/tests/listing-manager-silent-writes.test.ts.
 *
 * This is not a user editing someone else's task; it is the app closing its own
 * prompt because the condition it asked about is satisfied. The EVENT is still
 * written on the caller's client, because the actor really is the person who
 * saved the status.
 *
 * Because the admin client bypasses RLS, `org_id` is filtered EXPLICITLY below.
 * Losing that would make a property id from another organisation reachable.
 */
export async function completeListingStatusChecks(
  supabase: SupabaseClient<Database>,
  params: {
    propertyId: string;
    orgId: string;
    actorId: string;
    /** the status the listing was just moved to */
    newStatus: string;
  },
): Promise<number> {
  if (params.newStatus !== "sold" && params.newStatus !== "rented") return 0;

  const admin = createAdminClient();
  const { data: superseded } = await admin
    .from("tasks")
    .update({ is_done: true, done_at: new Date().toISOString() })
    // EXPLICIT, because the admin client has no RLS to do it — see the header
    .eq("org_id", params.orgId)
    .eq("property_id", params.propertyId)
    .eq("kind", "listing_status_check")
    .eq("is_done", false)
    .select("id");
  for (const t of superseded ?? []) {
    await logEvent(supabase, {
      orgId: params.orgId,
      actorId: params.actorId,
      entityType: "task",
      entityId: t.id,
      eventType: "superseded",
      payload: {
        kind: "listing_status_check",
        reason: `listing status set to ${params.newStatus} — the check's ask is satisfied`,
      },
    });
  }
  return (superseded ?? []).length;
}


/**
 * The OTHER thing a won deal leaves behind: a live hold on the property.
 *
 * markDealWon does not touch the reservation, and nothing else does either, so
 * a hold on a sold property simply runs to its expiry — at which point
 * `expire_reservations()` writes `release_reason = 'expired automatically'`
 * (0044) and events it as `reservation_expired`. That is false. The hold did
 * not lapse; the sale completed. The property's history then says the buyer's
 * hold quietly ran out, on a property they bought.
 *
 * WHY A PROMPT AND NOT A RELEASE. Converting or releasing the hold
 * automatically is the reservation↔status coupling DECLINED 2026-08-26 —
 * "`properties.status` is not to be coupled to holds, now or later. Do not
 * build the trigger" — and the reason given there applies exactly here: the
 * desk's manual action and an automatic one are both legitimate and neither can
 * know about the other. The precedent the same decision set is explicit: "the
 * Won side got a task that ASKS". This is that task, for the sibling case.
 *
 * The sweep is deliberately NOT changed. Making `expire_reservations()` consult
 * `properties.status` would build the very coupling that was declined, in the
 * one function the decision names as proof of independence ("`expire_reservations()`
 * does not reference `properties` at all"). The prompt exists so the hold is
 * settled by a person before the sweep ever sees it.
 */
export const LIVE_HOLD_TASK_KIND = "reservation_still_live";

export async function raiseLiveHoldCheck(
  supabase: SupabaseClient<Database>,
  params: {
    propertyId: string;
    orgId: string;
    actorId: string;
    dealId: string;
    assigneeId: string;
    propertyReference: string;
  },
): Promise<number> {
  const admin = createAdminClient();

  // Only a LIVE hold is worth asking about — 0044's own definition.
  const { data: live } = await admin
    .from("reservations")
    .select("id")
    .eq("org_id", params.orgId)
    .eq("property_id", params.propertyId)
    .in("status", ["held", "confirmed"])
    .limit(1)
    .maybeSingle();
  if (!live) return 0;

  // Asked of the DATABASE, not of the reader: `tasks_select` is scoped to
  // admin/assignee/creator, so on the caller's client this question is answered
  // from the subset they happen to see. org_id is explicit — the admin client
  // has no RLS to add it.
  const { data: already } = await admin
    .from("tasks")
    .select("id")
    .eq("org_id", params.orgId)
    .eq("property_id", params.propertyId)
    .eq("kind", LIVE_HOLD_TASK_KIND)
    .eq("is_done", false)
    .limit(1);
  if (already?.length) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const { data: task, error } = await supabase
    .from("tasks")
    .insert({
      org_id: params.orgId,
      title: `Deal won — settle the hold on ${params.propertyReference}`,
      // end of day, not the current instant: a prompt stamped "now" renders
      // OVERDUE on the next paint, and red that arrives with the task teaches
      // the desk to ignore red.
      due_at: cyprusEndOfDay(today).toISOString(),
      assignee_id: params.assigneeId,
      property_id: params.propertyId,
      reservation_id: live.id,
      deal_id: params.dealId,
      created_by: params.actorId,
      kind: LIVE_HOLD_TASK_KIND,
    })
    .select("id")
    .single();

  // A failed prompt must never roll back the win — logged loudly instead.
  if (error || !task) {
    console.error("reservation_still_live task failed:", error?.message);
    return 0;
  }

  await logEvent(supabase, {
    orgId: params.orgId,
    actorId: params.actorId,
    entityType: "property",
    entityId: params.propertyId,
    eventType: "followup_task_created",
    payload: {
      kind: LIVE_HOLD_TASK_KIND,
      task_id: task.id,
      deal_id: params.dealId,
      reservation_id: live.id,
    },
  });
  return 1;
}


/**
 * And the other half of the loop: close the live-hold prompt once the hold is
 * settled, whichever way the desk settles it.
 *
 * A prompt that survives being obeyed teaches the desk to ignore prompts —
 * `lib/actions/properties.ts` says so in its own words, and today
 * `completeListingStatusChecks` had to be moved onto the system client for
 * exactly that reason. Raising a prompt without an exit would have shipped the
 * defect this file exists to fix, one kind later.
 *
 * The exit is the hold LEAVING the live set: converted, released or expired.
 * `isLiveReservation` is the one definition of that, so this asks it rather
 * than listing statuses again.
 *
 * Runs as the system for the same reason as its sibling: `tasks_update` is
 * assignee-scoped, and the person settling a hold is very often not the agent
 * the prompt was assigned to. `org_id` is explicit — the admin client has no
 * RLS to add it.
 */
export async function completeLiveHoldChecks(
  supabase: SupabaseClient<Database>,
  params: { reservationId: string; orgId: string; actorId: string; newStatus: string },
): Promise<number> {
  if (isLiveReservation(params.newStatus as ReservationStatus)) return 0;

  const { data: closed } = await createAdminClient()
    .from("tasks")
    .update({ is_done: true, done_at: new Date().toISOString() })
    .eq("org_id", params.orgId)
    .eq("reservation_id", params.reservationId)
    .eq("kind", LIVE_HOLD_TASK_KIND)
    .eq("is_done", false)
    .select("id");

  for (const t of closed ?? []) {
    await logEvent(supabase, {
      orgId: params.orgId,
      actorId: params.actorId,
      entityType: "task",
      entityId: t.id,
      eventType: "superseded",
      payload: {
        kind: LIVE_HOLD_TASK_KIND,
        reason: `the hold is ${params.newStatus} — the check's ask is satisfied`,
      },
    });
  }
  return (closed ?? []).length;
}
