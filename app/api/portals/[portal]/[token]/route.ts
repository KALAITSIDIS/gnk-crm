import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient } from "@/lib/supabase/public";
import { feedEtag } from "@/lib/services/feed-etag";
import { DIALECT_RENDERERS } from "@/lib/services/portals/dialects";
import { assemblePortalFeed, MAX_PAGES } from "@/lib/services/portals/feed";
import type { SupplementRow } from "@/lib/services/portals/feed-listing";
import { notePortalPullAfter } from "@/lib/services/portals/pull-note";
import { portalById } from "@/lib/services/portals/registry";
import { MAX_LIMIT } from "@/lib/services/public-listings";

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
 * failed or truncated assembly is a 503, never an empty document. A disabled
 * connection's pull is still noted (count 0): that a portal keeps hitting an
 * empty feed is worth seeing on the settings page.
 *
 * Nothing the database says reaches the body of an error: a raw Postgres
 * message would land in a third party's logs. Errors are logged here and the
 * body is generic.
 *
 * THE TOKEN IS IN THE PATH, so it is in Vercel's access log by construction —
 * a URL is not a secret store. That is accepted rather than engineered
 * around: a portal's crawler configuration takes a URL and nothing else, so
 * there is no header to move it to. Regenerating the token in Settings →
 * Portals is the mitigation.
 *
 * WHAT THE TOKEN UNLOCKS is this feed of already-public listings PLUS, for
 * the listings the desk selected, the EXACT coordinates the site feed
 * withholds: `portal_supplement` (0095) returns `st_y/st_x(p.location)` for
 * selected rows, which `public_listings()` deliberately never does (0054
 * `location_approx`; the RLS suite pins `location` in the withheld list by
 * name). Never as an exact point for an approximate location: the function
 * carries `location_approx` beside the point — for such a row that point is
 * an area or district centroid, not the property — and every renderer drops
 * the point when the flag is set (dialects/approx-guard.test.ts). A leaked
 * URL therefore hands an anonymous reader the exact points of the selected
 * listings until Regenerate.
 *
 * No CORS headers and no OPTIONS handler, unlike /api/public/listings beside
 * it: a portal's crawler is server-to-server, so no browser ever preflights
 * this and an `Access-Control-Allow-Origin` would only invite one to try.
 *
 * `max-age` is 300 against the site feed's 60. A portal pulls between once and
 * three times a day, so five minutes of edge cache costs a portal nothing it
 * would notice and spares the database the burst when several pull together.
 */
export const dynamic = "force-dynamic";

const MAX_AGE_SECONDS = 300;
const CACHE_CONTROL = `public, max-age=${MAX_AGE_SECONDS}`;
const NO_STORE = { "Cache-Control": "no-store" } as const;
const TOKEN = /^[0-9a-f]{64}$/;
/** PostgREST answers at most `max_rows` (1000, supabase/config.toml) per call; the supplement is read in pages of this size until a short page. */
const SUPPLEMENT_PAGE = 1000;
/** The assembler's own budget, shared: a selection it could never finish scanning is refused before the round trips, not after. */
const SUPPLEMENT_CEILING = MAX_PAGES * MAX_LIMIT;

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

  // Read at the top, never inside the deferred note: the request's headers are
  // the request's, and the note runs after the response has gone.
  const userAgent = request.headers.get("user-agent") ?? "";
  const notePull = (count: number) =>
    notePortalPullAfter(supabase, { token, userAgent, count, portalId });

  // Disabled is a VALID feed with nothing in it — see the header. It must be
  // a document rather than an error, and it must never be cached: the desk
  // flips the switch back and the next pull has to see the listings again.
  if (!row.enabled) {
    notePull(0);
    return new NextResponse(renderer.empty(), {
      status: 200,
      headers: { "Content-Type": renderer.contentType, ...NO_STORE },
    });
  }

  // `.order("reference")` is NOT decoration: portal_supplement has no ORDER BY
  // of its own, and `.range()` over an unordered set is only stable while the
  // whole selection fits in one page. Above 1000 rows an unordered second page
  // can repeat a row and skip another, which is a listing silently missing
  // from the feed. Order first, then page.
  const supplementPage = (from: number) =>
    supabase
      .rpc("portal_supplement", { p_token: token })
      .order("reference")
      .range(from, from + SUPPLEMENT_PAGE - 1);

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
    // The generated type says `images: Json` because the codegen cannot see
    // through jsonb_agg; feed-listing.ts declares SupplementRow by hand and
    // pins its KEYS against that generated row, which is what makes this safe.
    const batch = (page.data ?? []) as unknown as SupplementRow[];
    supplements.push(...batch);
    if (batch.length < SUPPLEMENT_PAGE) break;
    if (supplements.length >= SUPPLEMENT_CEILING) {
      // The assembler would refuse a selection this size anyway (it scans at
      // most MAX_PAGES pages of MAX_LIMIT), so stop here rather than pay the
      // round trips to reach the same 503.
      console.error(`[portal-feed] ${portalId}: selection exceeds ${SUPPLEMENT_CEILING} rows`);
      return unavailable();
    }
    page = await supplementPage(supplements.length);
  }

  // Parsed, not cast: `settings` is jsonb the desk typed into a form, and the
  // dialect renders it straight into the document. A bad e-mail address would
  // otherwise reach the portal as a live contact node nobody can reply to,
  // and the registry's schema is the one place that says what is valid.
  const settings = portal.settingsSchema.safeParse(row.settings ?? {});
  if (!settings.success) {
    console.error(`[portal-feed] ${portalId}: settings invalid — ${settings.error.issues[0]?.message}`);
    return unavailable();
  }

  const result = await assemblePortalFeed({
    portal,
    renderer,
    settings: settings.data,
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

  // Before the 304 check: a portal told "unchanged" has still pulled, and
  // "last pulled" on the settings page means when it last ASKED. A 503 above
  // records NOTHING, deliberately — the desk should see the timestamp freeze,
  // and a note of 0 there would read exactly like a delisting.
  notePull(result.count);

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
