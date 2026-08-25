"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { recomputeDealsFor } from "@/lib/services/health-score";
import { recomputeQualityScore } from "@/lib/services/quality-score";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  MANDATE_TRANSITIONS,
  saveMandateSchema,
  type MandateStatus,
} from "@/lib/validators/mandates";
import { canRenew, resolveRenewalDates, toIsoDate } from "@/lib/services/mandate-renewal";

export type MandateActionState = { error: string | null; savedAt: number | null };

const ALLOWED_DOC_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_DOC_BYTES = 15 * 1024 * 1024;

/** Mandate status flips + activations affect the property quality score and
 * the health of open deals on the property (doc 02 §C1/§C5). */
async function recomputeScores(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyId: string,
) {
  await recomputeQualityScore(supabase, propertyId);
  await recomputeDealsFor(supabase, { propertyId });
}

/**
 * Migration 0012 invariant: an OPEN renewal task exists iff its mandate is
 * ACTIVE with a MATCHING expiry. Admin edits that break that (expiry moved,
 * status left active) complete the open task here with actor attribution;
 * the nightly expire_mandates() run is the safety net and re-creates the
 * reminder for the new expiry when its window opens.
 */
async function supersedeRenewalTasks(
  supabase: Awaited<ReturnType<typeof createClient>>,
  mandate: { id: string; org_id: string },
  actorId: string,
  reason: string,
) {
  const { data: superseded } = await supabase
    .from("tasks")
    .update({ is_done: true, done_at: new Date().toISOString() })
    .eq("mandate_id", mandate.id)
    // 0053: `tasks.mandate_id` is no longer single-kind. Without this filter
    // this closes the key_recall task the moment the mandate is terminated —
    // the task hangs off that same mandate, so it matched every time.
    .eq("kind", "mandate_renewal")
    .eq("is_done", false)
    .select("id");
  for (const t of superseded ?? []) {
    await logEvent(supabase, {
      orgId: mandate.org_id,
      actorId,
      entityType: "task",
      entityId: t.id,
      eventType: "superseded",
      payload: { mandate_id: mandate.id, reason },
    });
  }
  if ((superseded ?? []).length > 0) {
    revalidatePath("/tasks");
    revalidatePath("/dashboard");
  }
}

/**
 * Keep `properties.owner_contact_id` agreeing with the mandate that names an
 * owner (BACKLOG audit finding 2, the forward half of migration 0034).
 *
 * ONLY FILLS A BLANK. A property whose owner was set by hand on the Parties
 * panel is the stronger statement and is never overwritten here — otherwise
 * editing a mandate would silently reassign the property, and the two fields
 * would fight every time somebody touched either one.
 *
 * Without this the backfill is a one-off and the drift returns with the next
 * mandate anyone creates.
 */
async function syncPropertyOwner(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyId: string,
  ownerContactId: string | null,
  actor: { id: string; orgId: string },
) {
  if (!ownerContactId) return;

  const { data: rows } = await supabase
    .from("properties")
    .update({ owner_contact_id: ownerContactId })
    .eq("id", propertyId)
    .is("owner_contact_id", null)
    .select("id");
  if (!rows || rows.length === 0) return; // already had an owner, or RLS said no

  await logEvent(supabase, {
    orgId: actor.orgId,
    actorId: actor.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "updated",
    payload: {
      section: "parties",
      source: "mandate_owner_sync",
      changed: { owner_contact_id: { from: null, to: ownerContactId } },
    },
  });
  revalidatePath(`/properties/${propertyId}`);
}

function changedValue(prev: unknown, next: unknown): boolean {
  const norm = (v: unknown) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    if (typeof v !== "boolean" && String(v).trim() !== "" && Number.isFinite(n)) return String(n);
    return v;
  };
  return norm(prev) !== norm(next);
}

export async function saveMandate(
  _prev: MandateActionState,
  formData: FormData,
): Promise<MandateActionState> {
  const parsed = saveMandateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") {
    return { error: "Only admins manage mandates.", savedAt: null };
  }

  if (d.mandate_id) {
    const { data: current } = await supabase
      .from("mandates")
      .select("*")
      .eq("id", d.mandate_id)
      .maybeSingle();
    if (!current) return { error: "Mandate not found", savedAt: null };

    // the schema's refine only sees form-supplied pairs — cross-check against
    // the kept start date when the form leaves it unchanged
    const effectiveStart = d.start_date ?? current.start_date;
    if (d.expiry_date && effectiveStart && d.expiry_date <= effectiveStart) {
      return { error: "Expiry must be after the start date", savedAt: null };
    }

    const updates = {
      type: d.type,
      owner_contact_id: d.owner_contact_id ?? null,
      commission_pct: d.commission_pct ?? null,
      commission_notes: d.commission_notes ?? null,
      start_date: d.start_date ?? current.start_date,
      expiry_date: d.expiry_date ?? null,
      renewal_reminder_days: d.renewal_reminder_days,
      notes: d.notes ?? null,
    };

    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, next] of Object.entries(updates)) {
      const prev = (current as Record<string, unknown>)[key];
      if (changedValue(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
    }
    if (Object.keys(changed).length === 0) return { error: null, savedAt: Date.now() };

    const { error } = await supabase.from("mandates").update(updates).eq("id", d.mandate_id);
    if (error) return { error: error.message, savedAt: null };

    await logEvent(supabase, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "mandate",
      entityId: d.mandate_id,
      eventType: "updated",
      payload: JSON.parse(JSON.stringify({ changed })),
    });
    if ("expiry_date" in changed) {
      await supersedeRenewalTasks(
        supabase,
        { id: d.mandate_id, org_id: profile.orgId },
        profile.id,
        "expiry_changed",
      );
    }
    await syncPropertyOwner(supabase, current.property_id, d.owner_contact_id ?? null, {
      id: profile.id,
      orgId: profile.orgId,
    });
    await recomputeScores(supabase, current.property_id);
    revalidatePath(`/properties/${current.property_id}`);
    return { error: null, savedAt: Date.now() };
  }

  const { data: created, error } = await supabase
    .from("mandates")
    .insert({
      org_id: profile.orgId,
      property_id: d.property_id,
      type: d.type,
      owner_contact_id: d.owner_contact_id ?? null,
      commission_pct: d.commission_pct ?? null,
      commission_notes: d.commission_notes ?? null,
      ...(d.start_date ? { start_date: d.start_date } : {}),
      expiry_date: d.expiry_date ?? null,
      renewal_reminder_days: d.renewal_reminder_days,
      notes: d.notes ?? null,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error) return { error: error.message, savedAt: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "mandate",
    entityId: created.id,
    eventType: "created",
    payload: { property_id: d.property_id, type: d.type },
  });
  await syncPropertyOwner(supabase, d.property_id, d.owner_contact_id ?? null, {
    id: profile.id,
    orgId: profile.orgId,
  });
  await recomputeScores(supabase, d.property_id);
  revalidatePath(`/properties/${d.property_id}`);
  return { error: null, savedAt: Date.now() };
}

/**
 * Create the successor to a mandate, carrying its terms forward
 * (BACKLOG audit finding 6).
 *
 * Renewing used to mean a blank dialog and retyping the owner, type, commission,
 * reminder and notes — and the new row carried no link to the one it replaced,
 * so "were we on an exclusive in March" was an exercise in reading dates and
 * guessing. `renewed_from_id` (0036) makes the chain a fact.
 *
 * THE SUCCESSOR IS A DRAFT, never active. Activating it is a separate, deliberate
 * step, and the one-active-per-property index forces the old one to be
 * terminated first — so the sequence the business actually follows is enforced
 * by the database rather than described in a comment.
 *
 * The signed document is deliberately NOT copied. A renewal is a new agreement
 * and needs its own signature; pointing at the old PDF would make the evidence
 * chain assert something false.
 */
export async function renewMandate(mandateId: string): Promise<MandateActionState> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") {
    return { error: "Only admins manage mandates.", savedAt: null };
  }

  const { data: previous } = await supabase
    .from("mandates")
    .select("*")
    .eq("id", mandateId)
    .maybeSingle();
  if (!previous) return { error: "Mandate not found", savedAt: null };

  if (!canRenew(previous.status)) {
    return {
      error:
        previous.status === "terminated"
          ? "A terminated mandate cannot be renewed — that relationship ended. Create a new mandate instead."
          : `A ${previous.status} mandate has nothing to renew yet.`,
      savedAt: null,
    };
  }

  // One draft successor at a time, or Renew clicked twice quietly makes two.
  const { data: existing } = await supabase
    .from("mandates")
    .select("id")
    .eq("renewed_from_id", mandateId)
    .limit(1);
  if (existing && existing.length > 0) {
    return { error: "This mandate has already been renewed.", savedAt: null };
  }

  const dates = resolveRenewalDates(previous, toIsoDate(new Date()));

  const { data: created, error } = await supabase
    .from("mandates")
    .insert({
      org_id: previous.org_id,
      property_id: previous.property_id,
      renewed_from_id: previous.id,
      type: previous.type,
      status: "draft" as const,
      owner_contact_id: previous.owner_contact_id,
      commission_pct: previous.commission_pct,
      commission_notes: previous.commission_notes,
      renewal_reminder_days: previous.renewal_reminder_days,
      notes: previous.notes,
      start_date: dates.start_date,
      expiry_date: dates.expiry_date,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error) return { error: error.message, savedAt: null };

  await logEvent(supabase, {
    orgId: previous.org_id,
    actorId: profile.id,
    entityType: "mandate",
    entityId: created.id,
    eventType: "renewed",
    payload: {
      renewed_from: previous.id,
      property_id: previous.property_id,
      type: previous.type,
      previous_window: { start: previous.start_date, expiry: previous.expiry_date },
      new_window: { start: dates.start_date, expiry: dates.expiry_date },
    },
  });

  revalidatePath(`/properties/${previous.property_id}`);
  return { error: null, savedAt: Date.now() };
}

/** Admin-only guarded status change; `expired` stays cron-only. */
export async function setMandateStatus(
  mandateId: string,
  next: MandateStatus,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") return { error: "Only admins manage mandates." };

  const { data: m } = await supabase
    .from("mandates")
    .select("id, org_id, property_id, status, owner_contact_id")
    .eq("id", mandateId)
    .maybeSingle();
  if (!m) return { error: "Mandate not found" };

  const allowed = MANDATE_TRANSITIONS[m.status] ?? [];
  if (!allowed.includes(next)) {
    return { error: `Cannot move a ${m.status} mandate to ${next}.` };
  }

  // BACKLOG audit finding 8: a mandate is a contract with a person, and one
  // that names nobody is worth 10 points on the quality score and nothing in a
  // dispute. Checked on ACTIVATION rather than at insert, so a half-entered
  // draft can still be saved and finished later.
  if (next === "active" && !m.owner_contact_id) {
    return { error: "Add the owner contact before activating this mandate." };
  }

  const { error } = await supabase.from("mandates").update({ status: next }).eq("id", mandateId);
  if (error) {
    // 23505 here is the one-active-mandate-per-property index from 0036. The
    // raw message names an index, which tells the desk nothing about what to do.
    if (error.code === "23505") {
      return {
        error:
          "This property already has an active mandate. Terminate it first — only one can be live at a time.",
      };
    }
    return { error: error.message };
  }

  await logEvent(supabase, {
    orgId: m.org_id,
    actorId: profile.id,
    entityType: "mandate",
    entityId: mandateId,
    eventType: "status_changed",
    payload: { from: m.status, to: next },
  });
  if (m.status === "active") {
    await supersedeRenewalTasks(
      supabase,
      { id: m.id, org_id: m.org_id },
      profile.id,
      "mandate_no_longer_active",
    );
  }

  // 0053: the agency should not still be holding the owner's keys for a
  // property it no longer represents. `expired` is cron-only, so `terminated`
  // is the only end this action can reach; the nightly sweep covers the other.
  //
  // SERVICE ROLE, not the user's client: raise_key_recall_tasks is SECURITY
  // DEFINER and revoked from `authenticated` on purpose — granting it would let
  // any signed-in user pass any mandate id. This call site is already
  // admin-gated above, which is what makes the elevation safe.
  if (next === "terminated") {
    const { error: recallErr } = await createAdminClient().rpc("raise_key_recall_tasks", {
      p_mandate: mandateId,
      p_actor: profile.id,
    });
    // Not fatal: the mandate IS terminated and saying otherwise would be worse
    // than a missing task, which tonight's expire_mandates() will raise anyway.
    // Logged rather than swallowed — a discarded error is how a whole feature
    // silently does nothing (0045).
    if (recallErr) console.error("key recall task failed to raise", recallErr);
    else revalidatePath("/tasks");
  }

  await recomputeScores(supabase, m.property_id);
  revalidatePath(`/properties/${m.property_id}`);
  return { error: null };
}

/** Signed mandate agreement → private documents bucket + documents row. */
export async function uploadMandateDocument(
  _prev: MandateActionState,
  formData: FormData,
): Promise<MandateActionState> {
  const mandateId = String(formData.get("mandate_id") ?? "");
  const file = formData.get("file");
  if (!z.guid().safeParse(mandateId).success) return { error: "Missing mandate", savedAt: null };
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload", savedAt: null };
  }
  if (!ALLOWED_DOC_TYPES.has(file.type)) {
    return { error: "PDF, JPG or PNG only", savedAt: null };
  }
  if (file.size > MAX_DOC_BYTES) return { error: "File is over 15 MB", savedAt: null };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") return { error: "Only admins manage mandates.", savedAt: null };

  const { data: m } = await supabase
    .from("mandates")
    .select("id, org_id, property_id")
    .eq("id", mandateId)
    .maybeSingle();
  if (!m) return { error: "Mandate not found", savedAt: null };

  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${m.org_id}/mandates/${mandateId}/${Date.now()}-${safeName}`;
  const admin = createAdminClient();
  const upload = await admin.storage
    .from("documents")
    .upload(path, file, { contentType: file.type });
  if (upload.error) return { error: upload.error.message, savedAt: null };

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({
      org_id: m.org_id,
      entity_type: "mandate",
      entity_id: mandateId,
      doc_type: "mandate_agreement",
      title: file.name,
      storage_path: path,
      uploaded_by: profile.id,
    })
    .select("id")
    .single();
  if (docErr) {
    // the row was rejected — don't orphan the uploaded object
    await admin.storage.from("documents").remove([path]);
    return { error: docErr.message, savedAt: null };
  }

  const { error: linkErr } = await supabase
    .from("mandates")
    .update({ signed_document_id: doc.id })
    .eq("id", mandateId);
  if (linkErr) return { error: linkErr.message, savedAt: null };

  await logEvent(supabase, {
    orgId: m.org_id,
    actorId: profile.id,
    entityType: "mandate",
    entityId: mandateId,
    eventType: "document_uploaded",
    payload: { title: file.name },
  });

  revalidatePath(`/properties/${m.property_id}`);
  return { error: null, savedAt: Date.now() };
}

