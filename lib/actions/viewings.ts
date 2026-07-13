"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { intervalsOverlap } from "@/lib/services/viewings";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";
import { zonedWallClockToUtc } from "@/lib/utils/tz";
import {
  VIEWING_STATUS_ACTIONS,
  createViewingSchema,
  viewingFeedbackSchema,
  type ViewingStatusAction,
} from "@/lib/validators/viewings";

export type ViewingActionState = {
  error: string | null;
  savedAt: number | null;
  viewingId: string | null;
};

export interface ConflictHit {
  id: string;
  timeLabel: string;
  propertyRef: string | null;
}

/**
 * Live double-booking check for the create dialog (T4.1). Returns the agent's
 * existing scheduled viewings that overlap the proposed slot. Advisory only —
 * the create action never blocks on it.
 */
export async function checkViewingConflicts(input: {
  agentId: string;
  scheduledAt: string;
  durationMin: number;
  excludeId?: string;
}): Promise<ConflictHit[]> {
  if (!input.agentId || !input.scheduledAt) return [];
  let startMs: number;
  try {
    startMs = zonedWallClockToUtc(input.scheduledAt).getTime();
  } catch {
    return [];
  }
  const endMs = startMs + input.durationMin * 60_000;

  const supabase = await createClient();
  // widen the query window by a day either side so long viewings are caught
  const from = new Date(startMs - 24 * 3_600_000).toISOString();
  const to = new Date(endMs + 24 * 3_600_000).toISOString();

  const { data } = await supabase
    .from("viewings")
    .select("id, scheduled_at, duration_min, properties(reference)")
    .eq("agent_id", input.agentId)
    .eq("status", "scheduled")
    .gte("scheduled_at", from)
    .lte("scheduled_at", to);

  return (data ?? [])
    .filter((v) => {
      if (input.excludeId && v.id === input.excludeId) return false;
      const s = new Date(v.scheduled_at).getTime();
      return intervalsOverlap(startMs, endMs, s, s + v.duration_min * 60_000);
    })
    .map((v) => ({
      id: v.id,
      timeLabel: formatDateTime(v.scheduled_at),
      propertyRef: (v.properties as { reference: string } | null)?.reference ?? null,
    }));
}

export async function createViewing(
  _prev: ViewingActionState,
  formData: FormData,
): Promise<ViewingActionState> {
  const parsed = createViewingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null, viewingId: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  let scheduledUtc: string;
  try {
    scheduledUtc = zonedWallClockToUtc(d.scheduled_at).toISOString();
  } catch {
    return { error: "Invalid date and time", savedAt: null, viewingId: null };
  }

  const { data: created, error } = await supabase
    .from("viewings")
    .insert({
      org_id: profile.orgId,
      property_id: d.property_id,
      contact_id: d.contact_id,
      agent_id: d.agent_id,
      deal_id: d.deal_id ?? null,
      scheduled_at: scheduledUtc,
      duration_min: d.duration_min,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error) return { error: error.message, savedAt: null, viewingId: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "viewing",
    entityId: created.id,
    eventType: "created",
    payload: {
      property_id: d.property_id,
      agent_id: d.agent_id,
      scheduled_at: scheduledUtc,
      duration_min: d.duration_min,
    },
  });

  revalidatePath("/viewings");
  revalidatePath(`/properties/${d.property_id}`);
  return { error: null, savedAt: Date.now(), viewingId: created.id };
}

/**
 * Move a scheduled viewing to a terminal status (T4.3). Only the assigned
 * agent or an admin; only from `scheduled`. Writes a status_changed event.
 */
export async function updateViewingStatus(
  viewingId: string,
  next: ViewingStatusAction,
): Promise<{ error: string | null }> {
  if (!VIEWING_STATUS_ACTIONS.includes(next)) return { error: "Invalid status" };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: v } = await supabase
    .from("viewings")
    .select("id, org_id, agent_id, status, property_id")
    .eq("id", viewingId)
    .maybeSingle();
  if (!v) return { error: "Viewing not found" };
  if (profile.role !== "admin" && v.agent_id !== profile.id) {
    return { error: "You can only update your own viewings." };
  }
  if (v.status !== "scheduled") return { error: `Viewing is already ${v.status}.` };

  const { error } = await supabase.from("viewings").update({ status: next }).eq("id", viewingId);
  if (error) return { error: error.message };

  await logEvent(supabase, {
    orgId: v.org_id,
    actorId: profile.id,
    entityType: "viewing",
    entityId: viewingId,
    eventType: "status_changed",
    payload: { from: "scheduled", to: next },
  });

  revalidatePath(`/viewings/${viewingId}`);
  revalidatePath("/viewings");
  revalidatePath("/dashboard");
  return { error: null };
}

/**
 * Persist a day's viewing route (T4.4): stamp route_date + 1-based route_order
 * across the ordered viewings. RLS limits writes to the caller's own viewings
 * (admin: any). One summary event per save keeps the log un-spammed.
 */
export async function saveViewingRoute(
  routeDate: string,
  orderedIds: string[],
): Promise<{ error: string | null }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(routeDate)) return { error: "Invalid date" };
  if (orderedIds.length === 0) return { error: "Nothing to save" };
  if (!orderedIds.every((id) => z.guid().safeParse(id).success)) {
    return { error: "Invalid viewing reference" };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await supabase
      .from("viewings")
      .update({ route_date: routeDate, route_order: i + 1 })
      .eq("id", orderedIds[i]);
    if (error) return { error: error.message };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "viewing",
    entityId: null,
    eventType: "route_updated",
    payload: { route_date: routeDate, stops: orderedIds.length },
  });

  revalidatePath("/viewings");
  revalidatePath("/route-sheet");
  return { error: null };
}

export type FeedbackActionState = { error: string | null; savedAt: number | null };

/**
 * Save viewing feedback (T4.3). Allowed once the viewing is completed. Stored
 * on the viewing; also recorded as a property-scoped event so it surfaces on
 * the property's activity timeline (C7 acceptance).
 */
export async function saveViewingFeedback(
  _prev: FeedbackActionState,
  formData: FormData,
): Promise<FeedbackActionState> {
  const parsed = viewingFeedbackSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: v } = await supabase
    .from("viewings")
    .select("id, org_id, agent_id, status, property_id, properties(reference)")
    .eq("id", d.viewing_id)
    .maybeSingle();
  if (!v) return { error: "Viewing not found", savedAt: null };
  if (profile.role !== "admin" && v.agent_id !== profile.id) {
    return { error: "You can only add feedback to your own viewings.", savedAt: null };
  }
  if (v.status !== "completed") {
    return { error: "Feedback is only available once the viewing is completed.", savedAt: null };
  }

  const feedback = {
    rating: d.rating,
    liked: d.liked ?? null,
    disliked: d.disliked ?? null,
    comment: d.comment ?? null,
  };

  const { error } = await supabase
    .from("viewings")
    .update({ feedback })
    .eq("id", d.viewing_id);
  if (error) return { error: error.message, savedAt: null };

  await logEvent(supabase, {
    orgId: v.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: v.property_id,
    eventType: "viewing_feedback",
    payload: {
      viewing_id: d.viewing_id,
      reference: (v.properties as { reference: string } | null)?.reference ?? null,
      ...feedback,
    },
  });

  revalidatePath(`/viewings/${d.viewing_id}`);
  revalidatePath(`/properties/${v.property_id}`);
  revalidatePath("/dashboard");
  return { error: null, savedAt: Date.now() };
}
