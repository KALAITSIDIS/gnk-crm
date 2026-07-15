"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { sha256Hex } from "@/lib/services/hash";
import { renderSlipPdf } from "@/lib/services/slip-pdf";
import { SLIP_GDPR_LINE } from "@/lib/services/viewings";
import { binaryBody } from "@/lib/services/storage-upload";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";
import { signSlipSchema } from "@/lib/validators/viewings";

export type SlipActionState = { error: string | null; savedAt: number | null };

export async function signViewingSlip(
  _prev: SlipActionState,
  formData: FormData,
): Promise<SlipActionState> {
  const parsed = signSlipSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: v } = await supabase
    .from("viewings")
    .select(
      `id, org_id, agent_id, scheduled_at,
       properties(reference, address),
       agent:profiles!agent_id(full_name)`,
    )
    .eq("id", d.viewing_id)
    .maybeSingle();
  if (!v) return { error: "Viewing not found", savedAt: null };

  // Only the viewing's agent or an admin may sign (mirrors the RLS insert
  // policy). Guarding here avoids orphaned uploads for unauthorized users.
  if (profile.role !== "admin" && v.agent_id !== profile.id) {
    return { error: "You can only sign slips for your own viewings.", savedAt: null };
  }

  // One slip per viewing (unique constraint is the backstop).
  const { data: existing } = await supabase
    .from("viewing_slips")
    .select("id")
    .eq("viewing_id", d.viewing_id)
    .maybeSingle();
  if (existing) return { error: "This viewing already has a signed slip.", savedAt: null };

  const png = Buffer.from(d.signature_data.replace(/^data:image\/png;base64,/, ""), "base64");
  const sha256 = sha256Hex(png);

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", v.org_id)
    .maybeSingle();

  const property = v.properties as { reference: string; address: string | null } | null;
  const agentName = (v.agent as { full_name: string } | null)?.full_name ?? "—";
  const signedAt = new Date();

  const admin = createAdminClient();
  const sigPath = `${v.org_id}/${d.viewing_id}.png`;
  const pngUpload = await admin.storage
    .from("signatures")
    .upload(sigPath, binaryBody(png, "image/png"), { contentType: "image/png", upsert: false });
  if (pngUpload.error) return { error: pngUpload.error.message, savedAt: null };

  let pdfPath: string | null = null;
  try {
    const pdf = await renderSlipPdf({
      orgName: org?.name ?? "Agency",
      agentName,
      signerName: d.signer_name,
      propertyRef: property?.reference ?? "—",
      propertyAddress: property?.address ?? null,
      viewingWhen: formatDateTime(v.scheduled_at),
      gdprLine: SLIP_GDPR_LINE,
      signatureDataUrl: d.signature_data,
      signedAtLabel: formatDateTime(signedAt),
      sha256,
    });
    pdfPath = `${v.org_id}/${d.viewing_id}.pdf`;
    const pdfUpload = await admin.storage
      .from("signatures")
      .upload(pdfPath, binaryBody(pdf, "application/pdf"), {
        contentType: "application/pdf",
        upsert: false,
      });
    if (pdfUpload.error) return { error: pdfUpload.error.message, savedAt: null };
  } catch (e) {
    return { error: `Could not render slip PDF: ${(e as Error).message}`, savedAt: null };
  }

  const geolocation =
    d.lat !== undefined && d.lng !== undefined
      ? `SRID=4326;POINT(${d.lng} ${d.lat})`
      : null;

  const { error: insErr } = await supabase.from("viewing_slips").insert({
    org_id: v.org_id,
    viewing_id: d.viewing_id,
    signer_name: d.signer_name,
    signature_path: sigPath,
    signature_sha256: sha256,
    geolocation,
    pdf_path: pdfPath,
    created_by: profile.id,
  });
  if (insErr) {
    // 23505 unique_violation → someone signed between our check and insert
    return {
      error: insErr.code === "23505" ? "This viewing already has a signed slip." : insErr.message,
      savedAt: null,
    };
  }

  await logEvent(supabase, {
    orgId: v.org_id,
    actorId: profile.id,
    entityType: "viewing",
    entityId: d.viewing_id,
    eventType: "viewing_slip_signed",
    payload: { sha256, signer_name: d.signer_name, geotagged: geolocation !== null },
  });

  revalidatePath(`/viewings/${d.viewing_id}/sign`);
  revalidatePath("/viewings");
  return { error: null, savedAt: Date.now() };
}

/**
 * Short-lived signed URL for a slip PDF. The RLS-checked read of the slip
 * gates access (admin or the viewing's agent); the service role then signs the
 * private-bucket URL (doc 04: signatures served via server action only).
 */
export async function getSlipDownloadUrl(
  viewingId: string,
): Promise<{ url: string | null; error: string | null }> {
  const supabase = await createClient();
  const { data: slip } = await supabase
    .from("viewing_slips")
    .select("pdf_path")
    .eq("viewing_id", viewingId)
    .maybeSingle();
  if (!slip?.pdf_path) return { url: null, error: "No slip found" };

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("signatures")
    .createSignedUrl(slip.pdf_path, 120);
  if (error) return { url: null, error: error.message };
  return { url: data.signedUrl, error: null };
}
