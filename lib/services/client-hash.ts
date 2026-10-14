/**
 * Browser-side SHA-256 for the verify-a-report form (T-upload-size-honest).
 *
 * The form used to post the whole PDF to `verifyEvidenceReport` only for the
 * server to hash it — and a request body over ~4.5 MB dies at Vercel's
 * platform 413 before any app code runs (MEASURED 2026-08-30, DECISIONS
 * T-media-import), which Next 16 turns into a client throw and the error
 * boundary. Hashing here means the PDF never leaves the device and has no
 * size limit; the action's existing digest path (`sha256` field, parsed by
 * `extractSha256Hex`) does the rest.
 *
 * Web Crypto only: lib/services/hash.ts imports node:crypto and cannot run in
 * the browser. Both produce the same lowercase 64-character hex, which is the
 * format the evidence_report_generated payloads carry.
 *
 * Pure of React: `verifyInBrowser` takes the server action as a step, so the
 * whole of the form's action is unit-tested (client-hash.test.ts).
 */

import type { VerifyReportState } from "@/lib/actions/reports";
import { reportRejection } from "@/lib/services/client-upload";

/** Lowercase hex SHA-256 of a file, computed in the browser. */
export async function sha256HexInBrowser(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // only in an insecure context (plain http off localhost) or a very old browser
    throw new Error("This browser cannot compute a SHA-256 here — paste the report's SHA-256 instead.");
  }
  const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The body the verify form sends: ONLY a `sha256` field, never the file.
 * A chosen PDF (the `file` field) is hashed here and wins over a pasted
 * digest — the action's own precedence. With no file, a pasted digest goes
 * through exactly as typed, because the action accepts loose paste (a footer
 * line, an e-mail) and extracts the digest itself. With neither, the body is
 * empty and the action says what to do.
 */
export async function verifyRequestBody(form: FormData): Promise<FormData> {
  const body = new FormData();
  const file = form.get("file");
  if (file !== null && typeof file !== "string" && file.size > 0) {
    body.set("sha256", await sha256HexInBrowser(file));
    return body;
  }
  const pasted = form.get("sha256");
  if (typeof pasted === "string") body.set("sha256", pasted);
  return body;
}

/**
 * Said when the chosen PDF could not be hashed here (no Web Crypto in an
 * insecure context, or an unreadable file). English for now: reports.verify in
 * messages/ has no key for it.
 */
export const VERIFY_HASH_FAILED_TEXT =
  "This browser could not read the PDF to check it — paste its SHA-256 instead.";

/**
 * Said when the check's request never came back. Verifying writes nothing, so
 * nothing was changed — but a plain "try again" can loop: an expired session
 * ("Not authenticated" from getCurrentProfile) or a deploy that retired the
 * action's id fails the same way on every retry, and a reload clears both.
 */
export const VERIFY_NO_ANSWER_TEXT =
  "The check did not complete — nothing was changed. Reload the page and try again.";

/**
 * The verify form's action, run in the BROWSER: hash a chosen PDF here, send
 * the server action (`verify`) only the digest body, and turn every failure
 * into an answer on the form — under useActionState a throw would land on the
 * route's error boundary. A request that never came back is handed to
 * `onRejected` (the form reports it to Sentry, as the error boundary did); a
 * PDF this browser cannot hash is a local limitation and is not reported.
 */
export async function verifyInBrowser(
  prev: VerifyReportState,
  form: FormData,
  steps: {
    verify: (prev: VerifyReportState, body: FormData) => Promise<VerifyReportState>;
    onRejected?: (error: unknown) => void;
  },
): Promise<VerifyReportState> {
  let body: FormData;
  try {
    body = await verifyRequestBody(form);
  } catch {
    return { error: VERIFY_HASH_FAILED_TEXT, result: null };
  }
  try {
    return await steps.verify(prev, body);
  } catch (error) {
    reportRejection(steps.onRejected, error);
    return { error: VERIFY_NO_ANSWER_TEXT, result: null };
  }
}
