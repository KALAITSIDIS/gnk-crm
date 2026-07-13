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
  await recomputeScores(supabase, d.property_id);
  revalidatePath(`/properties/${d.property_id}`);
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
    .select("id, org_id, property_id, status")
    .eq("id", mandateId)
    .maybeSingle();
  if (!m) return { error: "Mandate not found" };

  const allowed = MANDATE_TRANSITIONS[m.status] ?? [];
  if (!allowed.includes(next)) {
    return { error: `Cannot move a ${m.status} mandate to ${next}.` };
  }

  const { error } = await supabase.from("mandates").update({ status: next }).eq("id", mandateId);
  if (error) return { error: error.message };

  await logEvent(supabase, {
    orgId: m.org_id,
    actorId: profile.id,
    entityType: "mandate",
    entityId: mandateId,
    eventType: "status_changed",
    payload: { from: m.status, to: next },
  });
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
    .upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type });
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
  if (docErr) return { error: docErr.message, savedAt: null };

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

/**
 * Signed URL for the mandate agreement. Access = whoever can read the
 * documents row under RLS (doc 04: file bodies via signed URLs only).
 */
export async function getMandateDocumentUrl(
  documentId: string,
): Promise<{ url: string | null; error: string | null }> {
  const supabase = await createClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return { url: null, error: "Document not found" };

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("documents")
    .createSignedUrl(doc.storage_path, 120);
  if (error) return { url: null, error: error.message };
  return { url: data.signedUrl, error: null };
}
