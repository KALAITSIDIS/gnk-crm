import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { describeRequestHeaders } from "@/lib/services/csp-echo";

/**
 * TEMPORARY DIAGNOSTIC — IMPROVEMENTS C1. See `lib/services/csp-echo.ts` for
 * what it answers and why it is safe to serve unauthenticated. Delete both,
 * plus the `CSP_ECHO_PATH` lines in `proxy.ts`, once C1 is root-caused.
 *
 * `force-dynamic` is load-bearing, not boilerplate: a prerendered answer would
 * describe the request headers of the BUILD, which is precisely the mistake
 * that sent the last round of this investigation after an edge-cache theory.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(describeRequestHeaders(await headers()), {
    headers: { "Cache-Control": "no-store" },
  });
}
