import { after, NextResponse, type NextRequest } from "next/server";
import { createPublicClient } from "@/lib/supabase/public";
import { feedEtag } from "@/lib/services/feed-etag";
import { DIALECT_RENDERERS } from "@/lib/services/portals/dialects";
import { assemblePortalFeed } from "@/lib/services/portals/feed";
import type { SupplementRow } from "@/lib/services/portals/feed-listing";
import { portalById } from "@/lib/services/portals/registry";

/**
 * The portal feed (spec 2026-09-14 §The feed route; migration 0095).
 *
 * PUBLIC AND UNAUTHENTICATED BY DESIGN, like /api/public/listings beside it:
 * a portal's crawler pulls it on its own schedule. `proxy.ts` exempts
 * `/api/portals/`. Anon client only — its reach is the three functions 0095
 * grants by name.
 *
 * The token in the path is the whole of the caller's proof. A wrong one costs
 * one indexed lookup and a 404 and is NOT metered: there is nothing behind
 * it to protect, and a counter row would be the shared-lock problem REL-03
 * removed from the site feed on 2026-09-13.
 *
 * A DISABLED portal answers 200 with the dialect's EMPTY document, never 404:
 * every pull portal treats absence as removal, so an empty feed clears our
 * listings there and a 404 would leave them stale. For the same reason a
 * failed or truncated assembly is a 503, never an empty document.
 *
 * Nothing the database says reaches the body of an error: a raw Postgres
 * message would land in a third party's logs. Errors are logged here and the
 * body is generic.
 */
export const dynamic = "force-dynamic";

const MAX_AGE_SECONDS = 300;
const CACHE_CONTROL = `public, max-age=${MAX_AGE_SECONDS}`;
const NO_STORE = { "Cache-Control": "no-store" } as const;
const TOKEN = /^[0-9a-f]{64}$/;
/** PostgREST answers at most `max_rows` (1000, supabase/config.toml) per call; the supplement is read in pages of this size until a short page. */
const SUPPLEMENT_PAGE = 1000;

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
const unavailable = () =>
  NextResponse.json({ error: "Feed unavailable." }, { status: 503, headers: NO_STORE });

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ portal: string; token: string }> },
) {
  const { portal: portalId, token } = await ctx.params;

  // Everything decidable without the database first: an unknown portal, a
  // token that is not token-shaped, and a dialect this build has no renderer
  // for are all 404 before a single round trip.
  const portal = portalById(portalId);
  if (!portal || !TOKEN.test(token)) return notFound();
  const renderer = DIALECT_RENDERERS[portal.dialect];
  if (!renderer) return notFound();

  const supabase = createPublicClient();

  const connection = await supabase.rpc("portal_connection_by_token", {
    p_portal: portalId,
    p_token: token,
  });
  // A wrong token and a database that would not answer look identical from
  // outside, on purpose: neither tells a guesser that a token was close.
  if (connection.error) {
    console.error(`[portal-feed] ${portalId}: connection lookup failed — ${connection.error.message}`);
    return notFound();
  }
  const row = (connection.data ?? [])[0];
  if (!row) return notFound();

  // Disabled is a VALID feed with nothing in it — see the header. It must be
  // a document rather than an error, and it must never be cached: the desk
  // flips the switch back and the next pull has to see the listings again.
  if (!row.enabled) {
    return new NextResponse(renderer.empty(), {
      status: 200,
      headers: { "Content-Type": renderer.contentType, ...NO_STORE },
    });
  }

  const supplementPage = (from: number) =>
    supabase.rpc("portal_supplement", { p_token: token }).range(from, from + SUPPLEMENT_PAGE - 1);

  // The snapshot names the site feed as a whole and is the first segment of
  // the validator, exactly as on /api/public/listings. It needs nothing from
  // the supplement, so it goes out with the first page rather than after it.
  const [first, snapshot] = await Promise.all([
    supplementPage(0),
    supabase.rpc("public_listings_etag", { p_org_slug: row.org_slug }),
  ]);
  if (snapshot.error) {
    console.error(`[portal-feed] ${portalId}: snapshot failed — ${snapshot.error.message}`);
    return unavailable();
  }

  // The supplement is the selection ∩ what the site feed shows. PostgREST caps
  // a response at `max_rows`, so a page short of SUPPLEMENT_PAGE is the last
  // one. A failure here is a 503, never an empty document — see the header.
  const supplements: SupplementRow[] = [];
  let page = first;
  for (;;) {
    if (page.error) {
      console.error(`[portal-feed] ${portalId}: supplement failed — ${page.error.message}`);
      return unavailable();
    }
    const batch = (page.data ?? []) as unknown as SupplementRow[];
    supplements.push(...batch);
    if (batch.length < SUPPLEMENT_PAGE) break;
    page = await supplementPage(supplements.length);
  }

  const result = await assemblePortalFeed({
    portal,
    renderer,
    settings: (row.settings ?? {}) as Record<string, string>,
    supplements,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    // The assembler owns the page size; a short page is how it learns the scan
    // is over, so the offset and the limit go through exactly as given.
    fetchPage: async (offset, limit) => {
      const listings = await supabase.rpc("public_listings", {
        p_org_slug: row.org_slug,
        p_limit: limit,
        p_offset: offset,
      });
      if (listings.error) throw new Error(listings.error.message);
      return listings.data ?? [];
    },
  });
  if (!result.ok) {
    console.error(`[portal-feed] ${portalId}: ${result.error}`);
    return unavailable();
  }

  // Two ways a feed goes quietly wrong, both invisible from the portal's end —
  // it just sees fewer listings, or none at all.
  if (result.selected > 0 && result.count === 0) {
    console.warn(
      `[portal-feed] ${portalId}: ${result.selected} selected, nothing eligible — a stalled JPEG ` +
        "backfill zeroes every photo count; check Settings → Portals",
    );
  }
  if (result.missing > 0) {
    console.warn(
      `[portal-feed] ${portalId}: ${result.missing} selected reference(s) not in the site feed`,
    );
  }

  const etag = feedEtag(String(snapshot.data), result.body);

  // Registered BEFORE the 304 check, so "last pulled" on the settings page is
  // when the portal last asked and not when it last got bytes. It runs after
  // the response and can never fail the pull.
  const note = async (): Promise<void> => {
    try {
      const noted = await supabase.rpc("note_portal_pull", {
        p_token: token,
        p_ua: request.headers.get("user-agent") ?? "",
        p_count: result.count,
      });
      if (noted.error) {
        console.warn(`[portal-feed] ${portalId}: pull not noted — ${noted.error.message}`);
      }
    } catch (err) {
      console.warn(
        `[portal-feed] ${portalId}: pull not noted — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  try {
    after(note);
  } catch {
    // no request scope (a unit test, a script): send it inline, fire-and-
    // forget — the same fallback as lib/services/site-revalidate.ts
    void note();
  }

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": CACHE_CONTROL },
    });
  }

  return new NextResponse(result.body, {
    status: 200,
    headers: {
      "Content-Type": renderer.contentType,
      ETag: etag,
      "Cache-Control": CACHE_CONTROL,
    },
  });
}
