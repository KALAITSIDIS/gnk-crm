import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isTrustedForwarder } from "@/lib/services/forwarder";
import { DEFAULT_LIMIT, runEnquiryAlertWorker } from "@/lib/services/enquiry-alert-worker";

/**
 * The desk-alert sweep (0101): sends whatever the enquiry route's `after()`
 * never reached — an invocation killed after the commit, a provider that
 * answered 503, a lease that lapsed — from the `notification_jobs` rows the
 * door wrote. The route's accelerator makes the alert fast; this makes it
 * RECOVERABLE. Both run the same worker; the database owns the state.
 *
 * NOT A PUBLIC SURFACE. proxy.ts lets `/api/internal/` past the session gate
 * because a scheduler has no session; the gate here is `CRON_SECRET` as a
 * bearer token, compared in constant time over digests (the forwarder's
 * helper). The name is Vercel's own: a `crons` entry in vercel.json sends
 * `Authorization: Bearer $CRON_SECRET` unprompted, and a `pg_net` job from
 * the database sends the same header from a vault secret. No secret
 * configured means nothing runs — the sweep fails CLOSED, unlike the enquiry
 * meter, because nothing is lost by refusing: the rows keep waiting.
 *
 * WHO CALLS IT, TODAY AND WHEN ARMED (docs/10 §2, "the desk-alert sweep"):
 *   - Vercel cron, daily (`vercel.json`): the most a Hobby plan allows, so a
 *     row the accelerator missed is sent within a day rather than never;
 *   - `pg_net` + `pg_cron` every two minutes, once the operator installs the
 *     extension on the hosted project (supabase/activation/…): the cadence
 *     the retry schedule was written for;
 *   - a person, with curl and the secret, after an incident.
 *
 * Bounded: at most `limit` rows per call (default 5, never more than 20),
 * each a single provider attempt with an 8 s timeout, inside `maxDuration`.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_LIMIT = 20;

const json = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function sweep(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[enquiry-alert] sweep refused — CRON_SECRET is not set; pending desk alerts wait");
    return json({ error: "The sweep is not armed on this deployment." }, 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (!isTrustedForwarder(presented, secret)) return json({ error: "Unauthorized." }, 401);

  const asked = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(asked, MAX_LIMIT) : DEFAULT_LIMIT;

  try {
    const run = await runEnquiryAlertWorker(createAdminClient(), {
      workerId: `sweep:${randomUUID()}`,
      limit,
    });
    return json({ ok: true, ...run }, 200);
  } catch (err) {
    // The worker promises never to throw; if it does, say so without its words.
    console.error("[enquiry-alert] sweep threw:", err instanceof Error ? err.name : String(err));
    return json({ error: "The sweep failed." }, 500);
  }
}

export async function GET(request: NextRequest) {
  return sweep(request);
}

export async function POST(request: NextRequest) {
  return sweep(request);
}
