/**
 * The one limit every browser upload is held to, and what the forms say about
 * it (T-upload-size-honest). Shared by the photo resize (lib/services/
 * client-image.ts), the document and branding forms
 * (components/features/shared/use-upload-form.ts) and their labels, so a form
 * and its label cannot disagree.
 *
 * MEASURED, NOT ASSUMED (2026-08-30, production probes — DECISIONS
 * T-media-import): Vercel rejects a request body over ~4.5 MB with a platform
 * 413 before any app code runs — 3 MB → 200, 5/8/20 MB → 413. Next 16 then
 * throws on the client ("An unexpected response was received from the
 * server"), so an oversized upload used to land the user on the error
 * boundary. The server actions' own caps (15 MB documents, 20 MB photos and
 * report PDFs, `bodySizeLimit: "25mb"` in next.config.ts) are unreachable
 * through the platform: a file over this budget is never sent.
 *
 * Pure: no browser or server API, so it runs in both and in the unit tests.
 */

/** Keep each request comfortably under the measured ~4.5 MB platform 413. */
export const UPLOAD_REQUEST_BUDGET_BYTES = 3_500_000;

/**
 * The branding PNG's own cap — `uploadBranding` (lib/actions/settings.ts)
 * refuses past it, and its form refuses before sending. Below the budget.
 */
export const BRANDING_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The repo's MB: every server cap is written `N * 1024 * 1024` and called
 * "N MB" (documents 15, photos and report PDFs 20, branding 2), which is also
 * the unit Windows Explorer shows a file's size in.
 */
const BYTES_PER_MB = 1024 * 1024;

export type MegabyteRounding = "nearest" | "up" | "down";

/**
 * "X.X MB". A LIMIT is shown rounded DOWN and a refused SIZE rounded UP, so a
 * limit is never overstated and a refused file always reads larger than the
 * limit it broke (never "3.3 MB is over the 3.3 MB limit").
 */
export function formatMegabytes(bytes: number, rounding: MegabyteRounding = "nearest"): string {
  // bytes × 10 / 2^20 is exact in floating point for any real file size, so
  // ceil/floor never trip over a representation error
  const tenths = (bytes * 10) / BYTES_PER_MB;
  const rounded =
    rounding === "up" ? Math.ceil(tenths) : rounding === "down" ? Math.floor(tenths) : Math.round(tenths);
  return `${(rounded / 10).toFixed(1)} MB`;
}

/** True when a body of `bytes` may be sent; `limit` defaults to the request budget. */
export function fitsUploadBudget(bytes: number, limit: number = UPLOAD_REQUEST_BUDGET_BYTES): boolean {
  return bytes <= limit;
}

/** The limit as the forms print it: "3.3 MB". */
export const UPLOAD_LIMIT_TEXT = formatMegabytes(UPLOAD_REQUEST_BUDGET_BYTES, "down");

/** What a document form accepts, said once for the three of them. */
export const DOCUMENT_FILE_HINT = `PDF, JPG or PNG · up to ${UPLOAD_LIMIT_TEXT}`;

/**
 * What to do with a document over the limit. Documents are evidence, so the
 * browser never re-encodes them: the user makes the smaller file.
 */
export const DOCUMENT_TOO_LARGE_ADVICE =
  "Compress the PDF or split it into parts; for a scan or a photo, use a smaller image.";

/**
 * Said when a document upload's request never came back (a network drop, a
 * platform error page): the file and its row may or may not have been saved,
 * and the action is not idempotent — a blind retry can store it twice.
 */
export const DOCUMENT_UPLOAD_UNCONFIRMED_TEXT =
  "Could not confirm whether the document was saved — reload the page and check the list before uploading it again.";

/**
 * The pre-submit gate: a refusal to show, or null to send. `entry` is the
 * form's `file` field. Nothing chosen, a text value or an empty file input is
 * let through — the server answers those in its own words. The enforced limit
 * is the smaller of `limit` and the request budget: a caller's own cap can
 * lower the ceiling, never lift it past what the platform delivers.
 */
export function uploadSizeRefusal(
  entry: FormDataEntryValue | null,
  limit: number,
  advice: string,
): string | null {
  if (entry === null || typeof entry === "string") return null;
  const cap = Math.min(limit, UPLOAD_REQUEST_BUDGET_BYTES);
  if (fitsUploadBudget(entry.size, cap)) return null;
  return `${entry.name} is ${formatMegabytes(entry.size, "up")} — over the ${formatMegabytes(cap, "down")} limit for one upload. Nothing was uploaded. ${advice}`;
}
