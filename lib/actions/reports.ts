"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { assembleEvidence, EVENTS_PER_FAMILY } from "@/lib/services/evidence";
import { renderEvidencePdf } from "@/lib/services/evidence-pdf";
import { logEvent } from "@/lib/services/events";
import { extractSha256Hex, sha256Hex } from "@/lib/services/hash";
import { binaryBody } from "@/lib/services/storage-upload";
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

// The message is a key into reports.evidence.errors, resolved at catch time so
// the action's strings translate with the rest of the module.
const generateSchema = z.object({
  contact_id: z.guid("pickContact"),
  property_id: optionalGuid,
  deal_id: optionalGuid,
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

  const t = await getTranslations("reports.evidence.errors");

  const parsed = generateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.message;
    return fail(key === "pickContact" ? t("pickContact") : t("invalidInput"));
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const admin = createAdminClient();

  const data = await assembleEvidence(supabase, admin, profile.orgId, {
    contactId: d.contact_id,
    propertyId: d.property_id,
    dealId: d.deal_id,
    from: d.from,
    to: d.to,
    withSlipImages: true,
    verifyChain: true, // an evidential PDF must carry a real chain result
    generatedBy: { name: profile.fullName, role: profile.role },
  });
  if ("errorKey" in data) return fail(t(data.errorKey, { message: data.message ?? "" }));
  if (data.rows.length === 0) return fail(t("noEvents"));
  if (data.truncated) return fail(t("truncated", { max: EVENTS_PER_FAMILY }));

  const generatedAt = formatDateTime(new Date());
  let pdf: Buffer;
  try {
    pdf = await renderEvidencePdf(data, generatedAt);
  } catch (e) {
    return fail(t("renderFailed", { message: (e as Error).message }));
  }

  const stamp = Date.now();
  const path = `${profile.orgId}/reports/evidence-${d.contact_id}-${stamp}.pdf`;
  const upload = await admin.storage
    .from("documents")
    .upload(path, binaryBody(pdf, "application/pdf"), { contentType: "application/pdf" });
  if (upload.error) return fail(upload.error.message);

  const row = {
    org_id: profile.orgId,
    entity_type: "contact" as const,
    entity_id: d.contact_id,
    title: `Commission evidence — ${data.contact.name} — ${new Date(stamp).toISOString().slice(0, 10)}`,
    storage_path: path,
    uploaded_by: profile.id,
    // an admin's report carries the full org record — keep it admin-only
    visibility: profile.role === "admin" ? "admin_only" : "internal",
  };
  let { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({ ...row, doc_type: "evidence_report" })
    .select("id")
    .single();
  if (docErr?.message.includes("invalid input value for enum")) {
    // Transitional: a deployment can reach an environment that has not run
    // migration 0015 yet. Generating the report matters more than its label —
    // 0016's backfill (keyed on this storage_path) relabels these rows when
    // the migration lands. Remove once every environment is on 0015+.
    ({ data: doc, error: docErr } = await supabase
      .from("documents")
      .insert({ ...row, doc_type: "other" })
      .select("id")
      .single());
  }
  if (docErr || !doc) {
    await admin.storage.from("documents").remove([path]); // no orphaned file
    return fail(docErr?.message ?? t("storeFailed"));
  }

  try {
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
        chain_ok: data.chain === "verified",
        ...(d.property_id ? { property_id: d.property_id } : {}),
        ...(d.deal_id ? { deal_id: d.deal_id } : {}),
      },
    });
  } catch (e) {
    // guardrail 1: no stored report without its event — roll the report back
    await admin.from("documents").delete().eq("id", doc.id);
    await admin.storage.from("documents").remove([path]);
    return fail(t("rolledBack", { message: (e as Error).message }));
  }

  revalidatePath("/reports/commission-evidence");
  revalidatePath("/reports");
  return {
    error: null,
    savedAt: Date.now(),
    documentId: doc.id,
    chainOk: data.chain === "verified",
    rowCount: data.rows.length,
  };
}

/* ------------------------------------------------------------------ */
/* Verify a report: recompute a PDF's SHA-256 (or accept a pasted     */
/* digest) and match it against the evidence_report_generated event   */
/* log. RLS-scoped like generation: admins verify any org report,     */
/* agents verify reports they generated.                              */
/* ------------------------------------------------------------------ */

export type VerifyReportState = {
  error: string | null;
  /** null until a verification ran */
  result: {
    matched: boolean;
    sha256: string;
    generatedAt: string | null;
    reportHash: string | null;
    rows: number | null;
  } | null;
};

export async function verifyEvidenceReport(
  _prev: VerifyReportState,
  formData: FormData,
): Promise<VerifyReportState> {
  const fail = (error: string): VerifyReportState => ({ error, result: null });

  const t = await getTranslations("reports.verify.errors");
  const file = formData.get("file");
  const pasted = formData.get("sha256");
  let sha: string | null = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > 20 * 1024 * 1024) return fail(t("tooLarge"));
    sha = sha256Hex(Buffer.from(await file.arrayBuffer()));
  } else if (typeof pasted === "string" && pasted.trim()) {
    sha = extractSha256Hex(pasted);
    if (!sha) return fail(t("notAHash"));
  } else {
    return fail(t("noInput"));
  }

  const supabase = await createClient();
  await getCurrentProfile(supabase); // auth gate; RLS scopes the query below

  const { data: hit, error } = await supabase
    .from("events")
    .select("occurred_at, payload")
    .eq("event_type", "evidence_report_generated")
    .eq("payload->>pdf_sha256", sha)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return fail(error.message);

  if (!hit) return { error: null, result: { matched: false, sha256: sha, generatedAt: null, reportHash: null, rows: null } };

  const p = (hit.payload ?? {}) as Record<string, unknown>;
  return {
    error: null,
    result: {
      matched: true,
      sha256: sha,
      generatedAt: hit.occurred_at,
      reportHash: typeof p.report_hash === "string" ? p.report_hash : null,
      rows: Number(p.rows) || null,
    },
  };
}
