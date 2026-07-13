"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { assembleEvidence } from "@/lib/services/evidence";
import { renderEvidencePdf } from "@/lib/services/evidence-pdf";
import { logEvent } from "@/lib/services/events";
import { sha256Hex } from "@/lib/services/hash";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";

export type ReportActionState = {
  error: string | null;
  savedAt: number | null;
  documentId: string | null;
  chainOk: boolean | null;
  rowCount: number | null;
};

const optionalGuid = z
  .string()
  .optional()
  .transform((v) => (v && z.guid().safeParse(v).success ? v : undefined));

const optionalDate = z
  .string()
  .optional()
  .transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined));

const generateSchema = z.object({
  contact_id: z.guid("Pick a contact"),
  property_id: optionalGuid,
  from: optionalDate,
  to: optionalDate,
});

export async function generateEvidenceReport(
  _prev: ReportActionState,
  formData: FormData,
): Promise<ReportActionState> {
  const fail = (error: string): ReportActionState => ({
    error,
    savedAt: null,
    documentId: null,
    chainOk: null,
    rowCount: null,
  });

  const parsed = generateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const admin = createAdminClient();

  const data = await assembleEvidence(supabase, admin, profile.orgId, {
    contactId: d.contact_id,
    propertyId: d.property_id,
    from: d.from,
    to: d.to,
    withSlipImages: true,
  });
  if ("error" in data) return fail(data.error);
  if (data.rows.length === 0) return fail("No events found for this contact and filter.");

  const generatedAt = formatDateTime(new Date());
  let pdf: Buffer;
  try {
    pdf = await renderEvidencePdf(data, generatedAt);
  } catch (e) {
    return fail(`Could not render the PDF: ${(e as Error).message}`);
  }

  const stamp = Date.now();
  const path = `${profile.orgId}/reports/evidence-${d.contact_id}-${stamp}.pdf`;
  const upload = await admin.storage
    .from("documents")
    .upload(path, pdf, { contentType: "application/pdf" });
  if (upload.error) return fail(upload.error.message);

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({
      org_id: profile.orgId,
      entity_type: "contact",
      entity_id: d.contact_id,
      doc_type: "other",
      title: `Commission evidence — ${data.contact.name} — ${new Date(stamp).toISOString().slice(0, 10)}`,
      storage_path: path,
      uploaded_by: profile.id,
    })
    .select("id")
    .single();
  if (docErr) return fail(docErr.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: d.contact_id,
    eventType: "evidence_report_generated",
    payload: {
      document_id: doc.id,
      report_hash: data.reportHash,
      pdf_sha256: sha256Hex(pdf),
      rows: data.rows.length,
      chain_ok: data.chainOk,
      ...(d.property_id ? { property_id: d.property_id } : {}),
    },
  });

  revalidatePath("/reports/commission-evidence");
  return {
    error: null,
    savedAt: Date.now(),
    documentId: doc.id,
    chainOk: data.chainOk,
    rowCount: data.rows.length,
  };
}
