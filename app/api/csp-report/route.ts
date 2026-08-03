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

/**
 * Flood guard, not a filter.
 *
 * This was 16 KB, on the stated premise that "reports are small; anything
 * larger is not a browser". Production disproved it on 2026-08-03: two genuine
 * browser reports arrived and BOTH were answered 413, so real violations were
 * collected and silently thrown away — the precise failure the report-only
 * stage exists to avoid, since "no violations logged" then reads as "the policy
 * is clean".
 *
 * The premise was wrong because of the `report-to` shape: browsers BATCH
 * violations into one array, and every envelope repeats `originalPolicy` — this
 * app's entire CSP string, several hundred bytes each. A page with a dozen
 * violations therefore clears 16 KB on policy text alone. A representative
 * 24-violation batch measures ~23 KB (pinned by an E2E test).
 *
 * Note what this cap does and does not do: `request.text()` has already
 * materialised the whole body by the time it is checked, so this bounds the
 * PARSING and LOGGING work, not the transfer — the platform's own request limit
 * is what bounds that. Raising it is therefore cheap.
 */
const MAX_BODY_BYTES = 131_072;

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
    // Say so. The old code returned a bare 413, so a dropped report left no
    // trace but a status code in the access log — which is how two real
    // production drops went unnoticed until someone happened to look. Logging
    // the size makes the loss visible AND supplies the evidence to re-tune this
    // number, instead of guessing at it a second time.
    console.warn(`[csp] report DROPPED: ${raw.length} bytes exceeds ${MAX_BODY_BYTES}`);
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
