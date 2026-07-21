import Link from "next/link";
import { FileCheck2, ShieldCheck, ShieldX } from "lucide-react";
import { DocumentDownloadButton } from "@/components/features/shared/document-download-button";
import { VerifyReport } from "@/components/features/reports/verify-report";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const supabase = await createClient();

  // nightly hash-chain verification cache (0016), RLS-scoped to the org
  const { data: chainCheck } = await supabase
    .from("chain_checks")
    .select("checked_at, ok")
    .maybeSingle();

  // Generated evidence reports the caller may see (RLS hides admin_only from
  // non-admins). Matched on storage_path, not doc_type: the path is written by
  // generation and frozen by the protect_document_columns trigger, so this
  // query is correct even in an environment that has not run migration 0015
  // yet (and regardless of a later title edit). Uploader names resolved
  // separately — no FK embed needed.
  const { data: reports } = await supabase
    .from("documents")
    .select("id, title, created_at, uploaded_by")
    .like("storage_path", "%/reports/evidence-%")
    .order("created_at", { ascending: false })
    .limit(50);
  const uploaderIds = [...new Set((reports ?? []).map((r) => r.uploaded_by).filter(Boolean))] as string[];
  const { data: uploaders } = uploaderIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", uploaderIds)
    : { data: [] };
  const uploaderById = new Map((uploaders ?? []).map((u) => [u.id, u.full_name]));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Reports</h1>
        <p className="text-sm text-text-2">Generated documents are stored and evented.</p>
      </div>

      {chainCheck ? (
        <div
          className={cn(
            "flex max-w-2xl items-center gap-2 rounded-[10px] border px-4 py-3 text-sm font-medium",
            chainCheck.ok
              ? "border-success/30 bg-success/10 text-success"
              : "border-danger/30 bg-danger/10 text-danger",
          )}
        >
          {chainCheck.ok ? <ShieldCheck className="size-4" /> : <ShieldX className="size-4" />}
          Nightly event hash-chain check: {chainCheck.ok ? "OK" : "FAILING"} · last verified{" "}
          {formatDateTime(chainCheck.checked_at)}
        </div>
      ) : null}

      <Link
        href="/reports/commission-evidence"
        className="flex max-w-2xl items-start gap-3 rounded-[10px] border border-border bg-surface p-5 transition-colors hover:border-brand-300"
      >
        <FileCheck2 className="mt-0.5 size-5 shrink-0 text-brand-700" />
        <span>
          <span className="block text-sm font-semibold text-text-1">
            Commission evidence report
          </span>
          <span className="block text-sm text-text-2">
            Chronological, hash-verified activity record for a contact — viewings with signed
            slips, offers, stage changes — as a stored PDF.
          </span>
        </span>
      </Link>

      <section className="max-w-2xl overflow-x-auto rounded-[10px] border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-1">
            Generated reports {reports?.length ? `(${reports.length})` : ""}
          </h2>
        </div>
        {(reports ?? []).length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-2">
            No generated reports visible to you yet — build one from the commission evidence
            report above.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                <th className="px-4 py-2">Report</th>
                <th className="px-4 py-2">Generated</th>
                <th className="px-4 py-2">By</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {(reports ?? []).map((r) => (
                <tr key={r.id} className="border-b border-border/60 align-middle">
                  <td className="px-4 py-2 text-text-1">{r.title}</td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-2">
                    {formatDateTime(r.created_at)}
                  </td>
                  <td className="px-4 py-2 text-text-2">
                    {(r.uploaded_by && uploaderById.get(r.uploaded_by)) || ""}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <DocumentDownloadButton documentId={r.id} label="Download" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <VerifyReport />
    </div>
  );
}
