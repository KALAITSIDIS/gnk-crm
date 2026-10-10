import { EXPORT_FAILED_MESSAGE } from "@/lib/constants/export";

/**
 * Reading an export route's answer in the browser (the "Export CSV" button,
 * `components/features/shared/export-csv-button.tsx`; DECISIONS
 * T-export-complete). Pure, so the decisions are unit-tested without a DOM.
 */

export const EXPORT_SESSION_ENDED_MESSAGE =
  "Your session has ended, so nothing was downloaded. Sign in again, then export.";

/** Where the proxy sends a request without a usable session (proxy.ts). */
const SIGN_IN_PATHS = ["/login", "/login/verify", "/security"];

/**
 * A CSV only when the route said so: a 2xx `text/csv` that was NOT redirected.
 * fetch follows the proxy's 307 to a sign-in page and reports a 200 — saving
 * that page as a .csv is exactly the "looks downloaded" outcome to refuse.
 */
export function isCsvAnswer(res: Pick<Response, "ok" | "redirected" | "headers">): boolean {
  return res.ok && !res.redirected && (res.headers.get("content-type") ?? "").startsWith("text/csv");
}

/** The route's `attachment; filename="…"`; every export route sets one. */
export function csvFilenameOf(disposition: string | null): string {
  return /filename="([^"]+)"/.exec(disposition ?? "")?.[1] ?? "export.csv";
}

/**
 * What to tell the user when the answer is not a CSV: the route's own reason
 * when it gave one (`readExportRows`: too many records, or failed), "sign in
 * again" when the session had ended, else the generic failure — a crashed
 * route answers an empty 500, and its reason is not the user's to read.
 */
export async function exportRefusalMessage(res: Response): Promise<string> {
  if (res.redirected && SIGN_IN_PATHS.includes(pathOf(res.url))) return EXPORT_SESSION_ENDED_MESSAGE;
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return EXPORT_FAILED_MESSAGE;
  try {
    const error = ((await res.json()) as { error?: unknown } | null)?.error;
    return typeof error === "string" && error.trim() ? error : EXPORT_FAILED_MESSAGE;
  } catch {
    return EXPORT_FAILED_MESSAGE;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
