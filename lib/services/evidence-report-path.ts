/**
 * A commission-evidence report is a contact document whose storage path is
 * `<org>/reports/evidence-<contact>-<stamp>.pdf` (lib/actions/reports.ts).
 *
 * Identified by PATH, never by doc_type: storage_path is NOT NULL (0001) and a
 * session cannot change it (0002 protect_document_columns), while a session
 * may relabel doc_type. The same rule as app/(app)/reports/page.tsx and 0016's
 * backfill.
 *
 * Erasure and the retention purge never destroy one (ERA-1): the report's
 * SHA-256 is recorded in its `evidence_report_generated` event, and the
 * erasure spec keeps generated evidence PDFs because "the hash is the point"
 * (docs/superpowers/specs/2026-07-21-gdpr-contact-erasure-design.md).
 */
export const EVIDENCE_REPORT_PATH_LIKE = "%/reports/evidence-%";

export function isEvidenceReportPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.includes("/reports/evidence-");
}
