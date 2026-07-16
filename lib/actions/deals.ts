"use server";

import { revalidatePath } from "next/cache";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { recomputeDealHealth } from "@/lib/services/health-score";
import { createClient } from "@/lib/supabase/server";
import {
  DECIDED_STATUSES,
  OFFER_TRANSITIONS,
  dealCommissionSchema,
  dealDetailsSchema,
  markLostSchema,
  markWonSchema,
  saveOfferSchema,
  type OfferStatus,
} from "@/lib/validators/deals";

export type MoveDealResult = { error: string | null };

/**
 * Drag-and-drop stage change (T3.1). Delegates to the move_deal_to_stage RPC
 * (migration 0011) so the deal UPDATE and its stage_changed event commit in
 * one transaction — a move can never land without its event, and an
 * RLS-filtered 0-row update aborts instead of logging a phantom event.
 * Returns a result object, never throws: Next.js strips thrown Server Action
 * messages in production, which would hide the guard texts from the toast.
 */
export async function moveDealToStage(dealId: string, stageId: string): Promise<MoveDealResult> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("move_deal_to_stage", {
      p_deal_id: dealId,
      p_stage_id: stageId,
    });
    if (error) return { error: error.message };

    await recomputeDealHealth(supabase, dealId);
    revalidatePath("/pipeline");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Move failed" };
  }
}

export type DealSectionState = { error: string | null; savedAt: number | null };

/**
 * Change-diff equality that treats numeric strings numerically — Postgres
 * numeric comes back as "480000.00" while form input parses to 480000; those
 * are the same value, not a change.
 */
function normEq(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v === "object") return JSON.stringify(v);
    const n = Number(v);
    if (typeof v !== "boolean" && String(v).trim() !== "" && Number.isFinite(n)) return String(n);
    return String(v);
  };
  return norm(a) === norm(b);
}

/** Deal detail sections (T3.2): "details" (parties/value/title) and "commission". */
export async function updateDealSection(
  _prev: DealSectionState,
  formData: FormData,
): Promise<DealSectionState> {
  const dealId = formData.get("deal_id");
  const section = formData.get("section");
  if (typeof dealId !== "string" || typeof section !== "string") {
    return { error: "Missing deal or section", savedAt: null };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: current } = await supabase.from("deals").select("*").eq("id", dealId).maybeSingle();
  if (!current) return { error: "Deal not found", savedAt: null };

  const raw = Object.fromEntries(formData.entries());
  let updates: Database["public"]["Tables"]["deals"]["Update"];
  // health section: event the flag change, not the whole jsonb snapshot
  let changedOverride: Record<string, { from: unknown; to: unknown }> | null = null;

  if (section === "details") {
    const parsed = dealDetailsSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    const d = parsed.data;
    updates = {
      title: d.title,
      property_id: d.property_id ?? null,
      buyer_contact_id: d.buyer_contact_id ?? null,
      seller_contact_id: d.seller_contact_id ?? null,
      agent_id: d.agent_id ?? null,
      expected_value: d.expected_value ?? null,
    };
  } else if (section === "commission") {
    const parsed = dealCommissionSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    updates = { commission_split_notes: parsed.data.commission_split_notes || null };
  } else if (section === "health") {
    // Manual health checklist flag (doc 02 §C5: budget confirmed 25).
    // Merged into the health jsonb next to the computed factor snapshot.
    const health = (current.health ?? {}) as Record<string, unknown>;
    const budgetConfirmed = raw.budget_confirmed === "on";
    if ((health.budget_confirmed === true) === budgetConfirmed) {
      return { error: null, savedAt: Date.now() };
    }
    updates = {
      health: JSON.parse(JSON.stringify({ ...health, budget_confirmed: budgetConfirmed })),
    };
    changedOverride = {
      budget_confirmed: { from: health.budget_confirmed === true, to: budgetConfirmed },
    };
  } else {
    return { error: `Unknown section: ${section}`, savedAt: null };
  }

  const changed: Record<string, { from: unknown; to: unknown }> = changedOverride ?? {};
  if (!changedOverride) {
    for (const [key, next] of Object.entries(updates)) {
      const prev = (current as Record<string, unknown>)[key];
      if (!normEq(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
    }
    if (Object.keys(changed).length === 0) return { error: null, savedAt: Date.now() };
  }

  // .select() so an RLS-filtered 0-row update surfaces instead of silently
  // logging an "updated" event for a write that never happened.
  const { data: updatedRow, error: updateErr } = await supabase
    .from("deals")
    .update({ ...updates, last_activity_at: new Date().toISOString() })
    .eq("id", dealId)
    .select("id")
    .maybeSingle();
  if (updateErr) return { error: updateErr.message, savedAt: null };
  if (!updatedRow) return { error: "You do not have permission to edit this deal", savedAt: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "deal",
    entityId: dealId,
    eventType: "updated",
    payload: JSON.parse(JSON.stringify({ section, changed })),
  });

  await recomputeDealHealth(supabase, dealId);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/pipeline");
  return { error: null, savedAt: Date.now() };
}

export type OfferActionState = { error: string | null; savedAt: number | null };

/**
 * Create a new offer, or edit amount/terms/validity of an open one
 * (submitted/countered). Decided offers are immutable; there is no hard
 * delete — withdraw instead (DECISIONS T3.2, evidence trail).
 */
export async function saveOffer(
  _prev: OfferActionState,
  formData: FormData,
): Promise<OfferActionState> {
  const parsed = saveOfferSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: deal } = await supabase
    .from("deals")
    .select("id, org_id, status, property_id, buyer_contact_id")
    .eq("id", input.deal_id)
    .maybeSingle();
  if (!deal) return { error: "Deal not found", savedAt: null };
  if (deal.status !== "open") return { error: "Deal is closed — offers are frozen", savedAt: null };

  if (input.offer_id) {
    const { data: offer } = await supabase
      .from("offers")
      .select("*")
      .eq("id", input.offer_id)
      .maybeSingle();
    if (!offer || offer.deal_id !== deal.id) return { error: "Offer not found", savedAt: null };
    if (offer.status !== "submitted" && offer.status !== "countered") {
      return { error: `A ${offer.status} offer can no longer be edited`, savedAt: null };
    }

    const updates = {
      amount: input.amount,
      terms: input.terms ?? null,
      valid_until: input.valid_until ?? null,
      contact_id: input.contact_id ?? null,
    };
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, next] of Object.entries(updates)) {
      const prev = (offer as Record<string, unknown>)[key];
      if (!normEq(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
    }
    if (Object.keys(changed).length === 0) return { error: null, savedAt: Date.now() };

    const { data: updatedOffer, error: updateErr } = await supabase
      .from("offers")
      .update(updates)
      .eq("id", offer.id)
      .select("id")
      .maybeSingle();
    if (updateErr) return { error: updateErr.message, savedAt: null };
    if (!updatedOffer) {
      return { error: "You do not have permission to edit this offer", savedAt: null };
    }

    await logEvent(supabase, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "offer",
      entityId: offer.id,
      eventType: "updated",
      payload: JSON.parse(JSON.stringify({ deal_id: deal.id, changed })),
    });
  } else {
    const { data: created, error: insertErr } = await supabase
      .from("offers")
      .insert({
        org_id: deal.org_id,
        deal_id: deal.id,
        property_id: deal.property_id,
        contact_id: input.contact_id ?? deal.buyer_contact_id,
        amount: input.amount,
        terms: input.terms ?? null,
        valid_until: input.valid_until ?? null,
        created_by: profile.id,
      })
      .select("id")
      .single();
    if (insertErr) return { error: insertErr.message, savedAt: null };

    await logEvent(supabase, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "offer",
      entityId: created.id,
      eventType: "created",
      payload: { deal_id: deal.id, amount: input.amount },
    });
  }

  await supabase
    .from("deals")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", deal.id);

  await recomputeDealHealth(supabase, deal.id);
  revalidatePath(`/deals/${deal.id}`);
  revalidatePath("/pipeline");
  return { error: null, savedAt: Date.now() };
}

export type OfferStatusResult = { wonEligible: boolean; error: string | null };

/**
 * Guarded offer status transition. Accepting flags the deal won-eligible
 * (the caller prompts; the guarded Won flow itself lands in T3.4) and is
 * blocked while another accepted offer exists on the deal.
 * Returns a result object, never throws — thrown Server Action messages are
 * stripped in production builds and the guard texts would never reach the UI.
 */
export async function updateOfferStatus(
  offerId: string,
  next: OfferStatus,
): Promise<OfferStatusResult> {
  const fail = (error: string): OfferStatusResult => ({ wonEligible: false, error });
  try {
    const supabase = await createClient();
    const profile = await getCurrentProfile(supabase);

    const { data: offer } = await supabase
      .from("offers")
      .select("id, org_id, deal_id, amount, status")
      .eq("id", offerId)
      .maybeSingle();
    if (!offer) return fail("Offer not found");

    const allowed = OFFER_TRANSITIONS[offer.status as OfferStatus] ?? [];
    if (!allowed.includes(next)) {
      return fail(`Cannot move a ${offer.status} offer to ${next}`);
    }

    if (next === "accepted") {
      const { data: alreadyAccepted } = await supabase
        .from("offers")
        .select("id")
        .eq("deal_id", offer.deal_id)
        .eq("status", "accepted")
        .neq("id", offer.id)
        .limit(1);
      if (alreadyAccepted?.[0]) {
        return fail("This deal already has an accepted offer");
      }
    }

    // .select() so an RLS-filtered 0-row update aborts before the event write.
    const { data: updatedOffer, error: updateErr } = await supabase
      .from("offers")
      .update({
        status: next,
        decided_at: DECIDED_STATUSES.includes(next) ? new Date().toISOString() : null,
      })
      .eq("id", offer.id)
      .select("id")
      .maybeSingle();
    if (updateErr) return fail(updateErr.message);
    if (!updatedOffer) return fail("You do not have permission to update this offer");

    await logEvent(supabase, {
      orgId: offer.org_id,
      actorId: profile.id,
      entityType: "offer",
      entityId: offer.id,
      eventType: "status_changed",
      payload: { deal_id: offer.deal_id, from: offer.status, to: next, amount: offer.amount },
    });

    await supabase
      .from("deals")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", offer.deal_id);

    await recomputeDealHealth(supabase, offer.deal_id);
    revalidatePath(`/deals/${offer.deal_id}`);
    revalidatePath("/pipeline");
    return { wonEligible: next === "accepted", error: null };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Update failed");
  }
}

/**
 * Guarded Won flow (T3.4, doc 02 §C5): requires an accepted offer, or an
 * explicit admin override which writes its own `won_override` event. Also
 * moves the deal into the pipeline's is_won stage so the kanban reflects it.
 */
export async function markDealWon(
  _prev: DealSectionState,
  formData: FormData,
): Promise<DealSectionState> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const parsed = markWonSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const { deal_id: dealId, override } = parsed.data;

  const { data: deal } = await supabase
    .from("deals")
    .select("id, org_id, deal_type, status, stage_id")
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) return { error: "Deal not found", savedAt: null };
  if (deal.status !== "open") {
    return { error: `Deal is already ${deal.status}`, savedAt: null };
  }

  const { data: acceptedOffers } = await supabase
    .from("offers")
    .select("id")
    .eq("deal_id", dealId)
    .eq("status", "accepted")
    .limit(1);
  const hasAccepted = (acceptedOffers ?? []).length > 0;

  if (!hasAccepted) {
    if (profile.role !== "admin") {
      return {
        error: "Won requires an accepted offer — record one first, or ask an admin to override.",
        savedAt: null,
      };
    }
    if (!override) {
      return {
        error: 'No accepted offer on this deal. Tick "Admin override" to mark it won anyway.',
        savedAt: null,
      };
    }
  }

  const { data: wonStage } = await supabase
    .from("deal_stages")
    .select("id, name")
    .eq("deal_type", deal.deal_type)
    .eq("is_won", true)
    .limit(1)
    .maybeSingle();

  const now = new Date().toISOString();
  const { data: updatedRow, error: updateErr } = await supabase
    .from("deals")
    .update({
      status: "won",
      won_at: now,
      last_activity_at: now,
      ...(wonStage ? { stage_id: wonStage.id, stage_entered_at: now } : {}),
    })
    .eq("id", dealId)
    .select("id")
    .maybeSingle();
  if (updateErr) return { error: updateErr.message, savedAt: null };
  if (!updatedRow) return { error: "You do not have permission to close this deal", savedAt: null };

  if (!hasAccepted) {
    await logEvent(supabase, {
      orgId: deal.org_id,
      actorId: profile.id,
      entityType: "deal",
      entityId: dealId,
      eventType: "won_override",
      payload: { reason: "marked won without an accepted offer" },
    });
  }
  await logEvent(supabase, {
    orgId: deal.org_id,
    actorId: profile.id,
    entityType: "deal",
    entityId: dealId,
    eventType: "won",
    payload: { override: !hasAccepted, ...(wonStage ? { stage: wonStage.name } : {}) },
  });

  await recomputeDealHealth(supabase, dealId);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/pipeline");
  revalidatePath("/dashboard");
  return { error: null, savedAt: Date.now() };
}

/** Guarded Lost flow (T3.4): a reason is mandatory and lands in the event. */
export async function markDealLost(
  _prev: DealSectionState,
  formData: FormData,
): Promise<DealSectionState> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const parsed = markLostSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const { deal_id: dealId, lost_reason: lostReason } = parsed.data;

  const { data: deal } = await supabase
    .from("deals")
    .select("id, org_id, deal_type, status")
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) return { error: "Deal not found", savedAt: null };
  if (deal.status !== "open") {
    return { error: `Deal is already ${deal.status}`, savedAt: null };
  }

  const { data: lostStage } = await supabase
    .from("deal_stages")
    .select("id, name")
    .eq("deal_type", deal.deal_type)
    .eq("is_lost", true)
    .limit(1)
    .maybeSingle();

  const now = new Date().toISOString();
  const { data: updatedRow, error: updateErr } = await supabase
    .from("deals")
    .update({
      status: "lost",
      lost_at: now,
      lost_reason: lostReason,
      last_activity_at: now,
      ...(lostStage ? { stage_id: lostStage.id, stage_entered_at: now } : {}),
    })
    .eq("id", dealId)
    .select("id")
    .maybeSingle();
  if (updateErr) return { error: updateErr.message, savedAt: null };
  if (!updatedRow) return { error: "You do not have permission to close this deal", savedAt: null };

  await logEvent(supabase, {
    orgId: deal.org_id,
    actorId: profile.id,
    entityType: "deal",
    entityId: dealId,
    eventType: "lost",
    payload: { reason: lostReason, ...(lostStage ? { stage: lostStage.name } : {}) },
  });

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/pipeline");
  revalidatePath("/dashboard");
  return { error: null, savedAt: Date.now() };
}
