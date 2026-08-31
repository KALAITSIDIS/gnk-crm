import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { logEvent } from "@/lib/services/events";

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

  const { data: superseded } = await supabase
    .from("tasks")
    .update({ is_done: true, done_at: new Date().toISOString() })
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
