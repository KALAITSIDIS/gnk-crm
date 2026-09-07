import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient } from "@/lib/supabase/public";
import { callerIpHash } from "@/lib/services/caller-ip";
import { feedEtag } from "@/lib/services/feed-etag";
import { absolutizeListingImages, parseFeedParams } from "@/lib/services/public-listings";

/**
 * The public listing feed (IMPROVEMENTS C3, migration 0066).
 *
 * PUBLIC AND UNAUTHENTICATED BY DESIGN — a marketing site polls it. `proxy.ts`
 * exempts `/api/public/` from the auth gate, alongside `/p/`.
 *
 * THE BLAST RADIUS IS THE POINT. This route holds the ANON client, exactly like
 * `/p/[token]`: not the service role, which bypasses RLS, and not the app's
 * server client, which carries a session. The anon key can reach precisely the
 * three functions 0066 grants it by name, and `public_listings` enumerates its
 * own column allowlist in SQL. Nothing this file does can widen that — if this
 * handler were rewritten to select whatever it liked, it would still get back
 * 36 columns of published listings and nothing else — 34 at 0066, plus
 * `images` (0073) and `adviser_view` (0085). The number is here for
 * orientation only; what enforces it is the allowlist in the migration — 0085
 * names 14 of them at its own apply — and RLS test 41, which pins all 36
 * against the generated types on every push.
 *
 * `?org=` is required and is a SLUG, because the feed is per-agency: without it
 * a multi-tenant deployment would blend two agencies' listings into one feed.
 */
export const dynamic = "force-dynamic";

/** Requests per IP per 15-minute window before the feed starts refusing. */
const RATE_LIMIT = 120;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const org = params.get("org")?.trim();
  if (!org) {
    return NextResponse.json(
      { error: "An `org` slug is required." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const supabase = createPublicClient();

  // Rate limit first, so a flood costs one counter round trip rather than a
  // full feed query. Reuses the 0023 idiom against its own counter table —
  // sharing one would let this exhaust a buyer's share-link budget.
  const overBudget = await supabase.rpc("note_public_listing_hit", {
    p_ip_hash: await callerIpHash(),
    p_limit: RATE_LIMIT,
  });
  if (overBudget.data === true) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "900" } },
    );
  }

  // The snapshot names the feed as a whole (row count | max(updated_at) | photo
  // fingerprint). It is NOT the validator any more — see feedEtag() — it is
  // the segment gnk-web compares across pages to notice the feed moving under
  // a multi-page read, so it still has to be there and still has to be SQL's.
  const snapshot = await supabase.rpc("public_listings_etag", { p_org_slug: org });
  if (snapshot.error) {
    return NextResponse.json(
      { error: "Feed unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { limit, offset, reference } = parseFeedParams(params);
  // 0088: `?reference=` asks for ONE listing (case-insensitive; the site
  // matches that way and then redirects to the canonical spelling). Absent,
  // the feed. Passed only when present so a pre-0088 database — which has no
  // fourth parameter — still answers the plain feed during a rollout.
  const { data, error } = await supabase.rpc("public_listings", {
    p_org_slug: org,
    p_limit: limit,
    p_offset: offset,
    ...(reference ? { p_reference: reference } : {}),
  });
  if (error) {
    return NextResponse.json(
      { error: "Feed unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // FEED-1 (0073): SQL returns rendition paths relative to the public media
  // bucket; the route knows the project URL, so the site gets absolute URLs.
  // NEXT_PUBLIC_SUPABASE_URL is inlined at build time (see proxy.ts note).
  const listings = absolutizeListingImages(
    (data ?? []) as Array<{ images?: unknown }>,
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
  );

  // Serialised ONCE: the validator is a digest of these bytes and these bytes
  // are what goes out, so the ETag and the body cannot be two facts. Until
  // 2026-09-06 the validator was SQL's snapshot alone, and twice a change to
  // the body slipped past it (alt text — 0086; an area rename — DECISIONS
  // T-deferred-sweep), each time answering If-None-Match with 304 and no body
  // for text that had changed. A 304 now costs the feed query it used to skip;
  // the site's cache never sends If-None-Match (it revalidates on time), and a
  // validator that could lie was the dearer thing.
  const body = JSON.stringify({
    org,
    count: listings.length,
    limit,
    offset,
    ...(reference ? { reference } : {}),
    listings,
  });
  const etag = feedEtag(String(snapshot.data), body);

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "public, max-age=60" },
    });
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
      // Short and public: a marketing site may poll, and a stale minute costs
      // nothing next to hammering the database.
      "Cache-Control": "public, max-age=60",
      // It is a feed of already-public data, so cross-origin reads are the
      // intended use. GET only — there is no write surface to protect.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "If-None-Match",
      "Access-Control-Max-Age": "86400",
    },
  });
}
