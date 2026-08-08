"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { sha256Hex } from "@/lib/services/hash";
import { binaryBody } from "@/lib/services/storage-upload";
import { renderViewingConfirmationPdf } from "@/lib/services/viewing-confirmation-pdf";
import { SLIP_GDPR_LINE } from "@/lib/services/viewings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";

export type ConfirmationActionState = {
  error: string | null;
  savedAt: number | null;
  documentId: string | null;
};

const fail = (error: string): ConfirmationActionState => ({
  error,
  savedAt: null,
  documentId: null,
});

/**
 * Generate the branded viewing confirmation (IMPROVEMENTS B4) and file it
 * against the viewing.
 *
 * Follows `generateEvidenceReport` deliberately, including its unwind order:
 * a failed `documents` insert removes the uploaded file, and a failed event
 * removes BOTH the row and the file. Guardrail 1 — no stored document without
 * its event — matters here for the same reason it does for the evidence report:
 * a PDF in the bucket with nothing in the hash-chained log is a document whose
 * provenance cannot be shown.
 *
 * Regenerating is allowed and each run files a new document. The confirmation
 * is not evidential (the signed slip is), and a viewing that gets rescheduled
 * needs a fresh sheet with the new time — suppressing the second one would be
 * the wrong default.
 */
export async function generateViewingConfirmation(
  _prev: ConfirmationActionState,
  formData: FormData,
): Promise<ConfirmationActionState> {
  const viewingId = String(formData.get("viewing_id") ?? "");
  if (!viewingId) return fail("Missing viewing");

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: v } = await supabase
    .from("viewings")
    .select(
      `id, org_id, agent_id, scheduled_at, duration_min,
       properties(reference, address),
       contacts(display_name),
       agent:profiles!agent_id(full_name, email, phone_e164)`,
    )
    .eq("id", viewingId)
    .maybeSingle();
  if (!v) return fail("Viewing not found");

  // Mirrors the slip's rule and the RLS policy: the viewing's agent or an admin.
  if (profile.role !== "admin" && v.agent_id !== profile.id) {
    return fail("You can only generate confirmations for your own viewings.");
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", v.org_id)
    .maybeSingle();

  const property = v.properties as { reference: string; address: string | null } | null;
  // `display_name` is the generated column the rest of the app renders — it
  // already falls back to company_name, so a corporate buyer with no personal
  // name reads correctly instead of blank.
  const contact = v.contacts as { display_name: string | null } | null;
  const agent = v.agent as {
    full_name: string;
    email: string | null;
    phone_e164: string | null;
  } | null;

  let pdf: Buffer;
  try {
    pdf = await renderViewingConfirmationPdf({
      orgName: org?.name ?? "Agency",
      agentName: agent?.full_name ?? "—",
      agentEmail: agent?.email ?? null,
      agentPhone: agent?.phone_e164 ?? null,
      attendeeName: contact?.display_name ?? "—",
      propertyRef: property?.reference ?? "—",
      propertyAddress: property?.address ?? null,
      viewingWhen: formatDateTime(v.scheduled_at),
      durationLabel: `${v.duration_min} minutes`,
      gdprLine: SLIP_GDPR_LINE,
      generatedAtLabel: formatDateTime(new Date()),
    });
  } catch (e) {
    return fail(`Could not render the confirmation: ${(e as Error).message}`);
  }

  const admin = createAdminClient();
  const path = `${v.org_id}/viewings/confirmation-${viewingId}-${Date.now()}.pdf`;
  const upload = await admin.storage
    .from("documents")
    .upload(path, binaryBody(pdf, "application/pdf"), { contentType: "application/pdf" });
  if (upload.error) return fail(upload.error.message);

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({
      org_id: v.org_id,
      entity_type: "viewing",
      entity_id: viewingId,
      doc_type: "viewing_confirmation",
      title: `Viewing confirmation — ${property?.reference ?? "—"} — ${formatDateTime(v.scheduled_at)}`,
      storage_path: path,
      uploaded_by: profile.id,
      visibility: "internal",
    })
    .select("id")
    .single();
  if (docErr || !doc) {
    await admin.storage.from("documents").remove([path]); // no orphaned file
    return fail(docErr?.message ?? "Could not file the confirmation");
  }

  try {
    await logEvent(supabase, {
      orgId: v.org_id,
      actorId: profile.id,
      entityType: "viewing",
      entityId: viewingId,
      eventType: "viewing_confirmation_generated",
      payload: { document_id: doc.id, pdf_sha256: sha256Hex(pdf) },
    });
  } catch (e) {
    // guardrail 1: no stored document without its event — roll both back
    await admin.from("documents").delete().eq("id", doc.id);
    await admin.storage.from("documents").remove([path]);
    return fail(`Rolled back: ${(e as Error).message}`);
  }

  revalidatePath(`/viewings/${viewingId}`);
  return { error: null, savedAt: Date.now(), documentId: doc.id };
}

/**
 * Short-lived signed URL for the most recent confirmation. The RLS-checked read
 * of `documents` gates access; the service role then signs the private-bucket
 * URL, exactly as `getSlipDownloadUrl` does.
 */
export async function getViewingConfirmationUrl(
  viewingId: string,
): Promise<{ url: string | null; error: string | null }> {
  const supabase = await createClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("storage_path")
    .eq("entity_type", "viewing")
    .eq("entity_id", viewingId)
    .eq("doc_type", "viewing_confirmation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!doc?.storage_path) return { url: null, error: "No confirmation generated yet" };

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("documents")
    .createSignedUrl(doc.storage_path, 120);
  if (error) return { url: null, error: error.message };
  return { url: data.signedUrl, error: null };
}
