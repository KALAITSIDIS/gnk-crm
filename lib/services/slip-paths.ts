/**
 * Where a viewing's signed-slip files live in the private `signatures`
 * bucket: `<org_id>/<viewing_id>.png` and `.pdf`. ONE definition, used by the
 * writer (`signViewingSlip`) and by both service-role readers
 * (`getSlipDownloadUrl`, the commission evidence pack).
 *
 * The readers DERIVE the name from the slip row's ids instead of trusting its
 * stored `signature_path` / `pdf_path`. Those columns are free text a session
 * may INSERT (column grant; `viewing_slips_insert` checks only the row's
 * organisation and the viewing's agent), and the readers fetch with the
 * service role, which no storage policy limits — so a slip of organisation B
 * naming `<A org>/<A viewing>.pdf` was served A's signed slip
 * (T-deal-child-org-isolation's review, reproduced on the local stack). The
 * row's `org_id` is the caller's (RLS), so the derived name is always in the
 * caller's own organisation's folder; and since 0129 its `viewing_id` is that
 * organisation's viewing too. Every row the app has written stores exactly
 * this name (the pattern has not changed since T4.2).
 */
export function slipObjectPath(orgId: string, viewingId: string, kind: "png" | "pdf"): string {
  return `${orgId}/${viewingId}.${kind}`;
}
