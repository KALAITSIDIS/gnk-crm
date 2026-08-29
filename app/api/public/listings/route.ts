import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient } from "@/lib/supabase/public";
import { callerIpHash } from "@/lib/services/caller-ip";
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
 * 34 columns of published listings and nothing else.
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

  // The validator hashes the row COUNT as well as max(updated_at): unpublishing
  // a listing lowers the count without moving the maximum, and a site polling
  // on a max()-only ETag would keep serving something no longer for sale.
  const etagRes = await supabase.rpc("public_listings_etag", { p_org_slug: org });
  if (etagRes.error) {
    return NextResponse.json(
      { error: "Feed unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { limit, offset } = parseFeedParams(params);
  // The page is part of the identity: two offsets of the same feed are not the
  // same response, and an ETag that ignored them would let a cache serve page 1
  // for a request for page 2.
  const etag = `W/"${etagRes.data}-${limit}-${offset}"`;

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "public, max-age=60" },
    });
  }

  const { data, error } = await supabase.rpc("public_listings", {
    p_org_slug: org,
    p_limit: limit,
    p_offset: offset,
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
  return NextResponse.json(
    { org, count: Array.isArray(listings) ? listings.length : 0, limit, offset, listings },
    {
      status: 200,
      headers: {
        ETag: etag,
        // Short and public: a marketing site may poll, and a stale minute costs
        // nothing next to hammering the database.
        "Cache-Control": "public, max-age=60",
        // It is a feed of already-public data, so cross-origin reads are the
        // intended use. GET only — there is no write surface to protect.
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    },
  );
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
