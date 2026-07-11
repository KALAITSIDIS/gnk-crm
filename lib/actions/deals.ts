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
  saveOfferSchema,
  type OfferStatus,
} from "@/lib/validators/deals";

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

  await recomputeDealHealth(supabase, dealId);
  revalidatePath("/pipeline");
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

  const { error: updateErr } = await supabase
    .from("deals")
    .update({ ...updates, last_activity_at: new Date().toISOString() })
    .eq("id", dealId);
  if (updateErr) return { error: updateErr.message, savedAt: null };

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

    const { error: updateErr } = await supabase.from("offers").update(updates).eq("id", offer.id);
    if (updateErr) return { error: updateErr.message, savedAt: null };

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

/**
 * Guarded offer status transition. Accepting flags the deal won-eligible
 * (the caller prompts; the guarded Won flow itself lands in T3.4) and is
 * blocked while another accepted offer exists on the deal.
 */
export async function updateOfferStatus(
  offerId: string,
  next: OfferStatus,
): Promise<{ wonEligible: boolean }> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: offer } = await supabase
    .from("offers")
    .select("id, org_id, deal_id, amount, status")
    .eq("id", offerId)
    .maybeSingle();
  if (!offer) throw new Error("Offer not found");

  const allowed = OFFER_TRANSITIONS[offer.status as OfferStatus] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Cannot move a ${offer.status} offer to ${next}`);
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
      throw new Error("This deal already has an accepted offer");
    }
  }

  const { error: updateErr } = await supabase
    .from("offers")
    .update({
      status: next,
      decided_at: DECIDED_STATUSES.includes(next) ? new Date().toISOString() : null,
    })
    .eq("id", offer.id);
  if (updateErr) throw new Error(updateErr.message);

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
  return { wonEligible: next === "accepted" };
}
