/**
 * How the browser sends an upload to a server action (T-upload-size-honest).
 *
 * Two rules, for every form that posts a file:
 *
 * 1. NOTHING OVER THE REQUEST BUDGET IS SENT (lib/constants/upload.ts). Vercel
 *    answers a body over ~4.5 MB with a platform 413 before any app code runs
 *    (MEASURED 2026-08-30, DECISIONS T-media-import), so a server-side size
 *    check past the budget can never be reached. The gate runs here, before
 *    the request, and says what the file's size is and what to do.
 * 2. A REQUEST THAT NEVER COMES BACK IS A MESSAGE, NOT A THROW. A server
 *    action whose response is not an RSC payload (the platform's error page,
 *    a dropped connection) rejects on the client; under useActionState that
 *    rejection lands on the route's error boundary. Here it becomes an
 *    UNKNOWN outcome — the write may have committed before the answer was
 *    lost, and none of these uploads is idempotent — worded as such, the
 *    house idiom of components/features/deals/outcome-actions.tsx.
 *    The rejection itself goes to the caller's `onRejected` (the forms pass
 *    Sentry.captureException): the error boundary used to report it, and a
 *    platform 413 never reaches the server's logs — this report is the one
 *    signal that the request budget is set too high.
 *
 * Pure of React and of any browser-only API, so the decisions are unit-tested;
 * the forms (components/features/shared/use-upload-form.ts, media-tab.tsx)
 * only show what these return.
 */

import { UPLOAD_REQUEST_BUDGET_BYTES, uploadSizeRefusal } from "@/lib/constants/upload";

export type UploadActionState = {
  error: string | null;
  savedAt: number | null;
  /**
   * Set by an action that answered but cannot say whether the upload
   * committed (its `error` then says what to check). Shown as an UNKNOWN
   * outcome — kept until dismissed, the page re-read — not as a plain
   * refusal. No action sets it yet: T-document-insert-outcome's
   * `documentNotConfirmed` answers are meant to carry it.
   */
  unconfirmed?: boolean;
};

/**
 * Hand a lost request to the caller's reporter. A reporter that throws must
 * not turn an answer on the form back into a throw (the error boundary).
 */
export function reportRejection(onRejected: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    onRejected?.(error);
  } catch {
    // the report is best-effort; the user's message is not
  }
}

export type UploadOutcome =
  /** never sent: over the limit */
  | { kind: "refused"; text: string }
  /** sent, and no usable answer came back: it may or may not have been saved */
  | { kind: "unconfirmed"; text: string }
  /** the server answered with a refusal */
  | { kind: "error"; text: string }
  | { kind: "saved" };

/**
 * Submit one upload form's data to its action. Never throws. `limit` lowers
 * the ceiling for a form with its own smaller cap (branding); nothing can
 * raise it past the request budget.
 */
export async function submitUpload<S extends UploadActionState>(
  formData: FormData,
  action: (prev: S, formData: FormData) => Promise<S>,
  options: {
    initialState: S;
    limit?: number;
    tooLargeAdvice: string;
    unconfirmedText: string;
    /** told of a call that rejected (never of an answered refusal) */
    onRejected?: (error: unknown) => void;
  },
): Promise<UploadOutcome> {
  const refusal = uploadSizeRefusal(
    formData.get("file"),
    options.limit ?? UPLOAD_REQUEST_BUDGET_BYTES,
    options.tooLargeAdvice,
  );
  if (refusal) return { kind: "refused", text: refusal };

  let state: S;
  try {
    state = await action(options.initialState, formData);
  } catch (error) {
    reportRejection(options.onRejected, error);
    return { kind: "unconfirmed", text: options.unconfirmedText };
  }
  // the server's own "could not confirm": an unknown outcome, in its words
  if (state.error && state.unconfirmed) return { kind: "unconfirmed", text: state.error };
  if (state.error) return { kind: "error", text: state.error };
  if (state.savedAt) return { kind: "saved" };
  // an answer that claims neither: not a success the user should trust
  return { kind: "unconfirmed", text: options.unconfirmedText };
}

/**
 * Said when one photo's request never came back. Named by the file the user
 * chose; a retry is not idempotent, so check the gallery first.
 */
export function photoUploadUnconfirmedText(name: string): string {
  return `Could not confirm whether ${name} was saved — reload the page and check the photos before uploading it again.`;
}

/**
 * The media tab's loop: each photo is prepared (resized under the budget —
 * lib/services/client-image.ts) and sent in ITS OWN request, in order. The
 * first failure stops the run; photos saved before it stay saved. Never
 * throws: a preparation refusal, an answered refusal and a request that never
 * came back all come back as `failed`, and `unconfirmed` marks the last kind.
 */
export async function uploadOneByOne(
  files: readonly File[],
  steps: {
    prepare: (file: File) => Promise<File>;
    send: (file: File) => Promise<{ error: string | null; warning?: string | null }>;
    onProgress?: (position: number, total: number) => void;
    onWarning?: (text: string) => void;
    /** told of a send that rejected (never of a refused preparation or answer) */
    onRejected?: (error: unknown) => void;
  },
): Promise<{ done: number; failed: string | null; unconfirmed: boolean }> {
  let done = 0;
  for (const original of files) {
    steps.onProgress?.(done + 1, files.length);
    let file: File;
    try {
      file = await steps.prepare(original);
    } catch (err) {
      const text = err instanceof Error ? err.message : `${original.name}: unreadable image`;
      return { done, failed: text, unconfirmed: false };
    }
    let answer: { error: string | null; warning?: string | null };
    try {
      answer = await steps.send(file);
    } catch (error) {
      reportRejection(steps.onRejected, error);
      return { done, failed: photoUploadUnconfirmedText(original.name), unconfirmed: true };
    }
    // saved, with a follow-up that did not complete — said, not hidden
    if (answer.warning) steps.onWarning?.(answer.warning);
    if (answer.error) return { done, failed: answer.error, unconfirmed: false };
    done++;
  }
  return { done, failed: null, unconfirmed: false };
}
