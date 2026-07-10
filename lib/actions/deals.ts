"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";

/** Drag-and-drop stage change (T3.1). Writes deal.stage_changed {from,to}. */
export async function moveDealToStage(dealId: string, stageId: string): Promise<void> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: deal } = await supabase
    .from("deals")
    .select("id, org_id, deal_type, stage_id, status, title")
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) throw new Error("Deal not found");
  if (deal.stage_id === stageId) return;

  const [{ data: fromStage }, { data: toStage }] = await Promise.all([
    supabase.from("deal_stages").select("id, name, is_won, is_lost").eq("id", deal.stage_id).maybeSingle(),
    supabase.from("deal_stages").select("id, name, is_won, is_lost, deal_type").eq("id", stageId).maybeSingle(),
  ]);
  if (!toStage) throw new Error("Stage not found");
  if (toStage.deal_type !== deal.deal_type) throw new Error("Stage belongs to another deal type");

  // Won/lost guards are enforced in T3.4; for now dragging into a won/lost
  // column is refused so the kanban cannot bypass the coming server guards.
  if (toStage.is_won || toStage.is_lost) {
    throw new Error(`Use the deal page to mark ${toStage.is_won ? "won" : "lost"} (guarded flow)`);
  }

  const { error } = await supabase
    .from("deals")
    .update({ stage_id: stageId, last_activity_at: new Date().toISOString() })
    .eq("id", dealId);
  if (error) throw new Error(error.message);

  await logEvent(supabase, {
    orgId: deal.org_id,
    actorId: profile.id,
    entityType: "deal",
    entityId: dealId,
    eventType: "stage_changed",
    payload: { from: fromStage?.name ?? deal.stage_id, to: toStage.name },
  });

  revalidatePath("/pipeline");
}
