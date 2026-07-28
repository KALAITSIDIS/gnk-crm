import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { parseCspReport, violationKey } from "@/lib/services/csp-report";

/**
 * Collection point for Content-Security-Policy violation reports
 * (IMPROVEMENTS C1).
 *
 * The report-only policy shipped with nowhere to report TO, so violations
 * surfaced in each visitor's browser console and nowhere the operator could
 * see. Without this endpoint the advice "let report-only run in production for
 * a while" cannot be acted on at all.
 *
 * This endpoint is necessarily PUBLIC — browsers post reports without
 * credentials, and `proxy.ts` exempts it from the auth gate. That shapes every
 * decision here:
 *
 * - **It never writes to the database**, and above all never to `events`. The
 *   event log is append-only and hash-chained; letting an unauthenticated
 *   caller append to it would be indefensible.
 * - **The body is capped** so a large POST cannot be used to burn memory.
 * - **Nothing is echoed back** — the response is always an empty 204.
 * - **Reports are de-duplicated per instance.** The operator needs the distinct
 *   set of things the policy would block; one log line per page view would
 *   drown the rare, interesting violation in the common, boring one.
 */

// Reports are small; anything larger is not a browser.
const MAX_BODY_BYTES = 16_384;

/**
 * Violations already logged by THIS serverless instance. Deliberately in-memory
 * and per-instance: it is a flood guard, not a store. A cold start re-reports,
 * which is the behaviour we want — it keeps the signal alive over time without
 * ever accumulating unbounded state.
 */
const seen = new Set<string>();
const MAX_SEEN = 200;

export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Malformed input from the public internet is expected, not exceptional.
    return new NextResponse(null, { status: 204 });
  }

  for (const violation of parseCspReport(body)) {
    const key = violationKey(violation);
    if (seen.has(key)) continue;
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(key);

    const line =
      `[csp] ${violation.directive} blocked ${violation.blockedUri} ` +
      `on ${violation.documentPath}` +
      (violation.sourceFile ? ` (${violation.sourceFile}:${violation.lineNumber ?? 0})` : "");

    // The one deliberate console.* in application code: this route exists to
    // make violations visible, and stdout is what reaches the Vercel runtime
    // logs an operator can actually read. Sentry is env-gated and silent
    // without a DSN, so it cannot be the only sink.
    console.warn(line);
    Sentry.captureMessage(line, "warning");
  }

  // 204 regardless: a reporting endpoint must never give a caller feedback to
  // probe with, and a failed report must never surface to the user.
  return new NextResponse(null, { status: 204 });
}
