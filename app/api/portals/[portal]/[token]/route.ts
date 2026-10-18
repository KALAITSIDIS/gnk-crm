import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchUpTo } from "@/lib/supabase/fetch-all";
import { createPublicClient } from "@/lib/supabase/public";
import { rowsOf } from "@/lib/supabase/rows";
import { feedEtag } from "@/lib/services/feed-etag";
import { DIALECT_RENDERERS } from "@/lib/services/portals/dialects";
import { assemblePortalFeed, MAX_PAGES, type RevisionRow } from "@/lib/services/portals/feed";
import { parseListingRows, parseSupplementRows } from "@/lib/services/portals/feed-listing";
import { recordPortalPullAfter, type PullRecord } from "@/lib/services/portals/pull-note";
import { portalById } from "@/lib/services/portals/registry";
import { publicListingUrl } from "@/lib/services/portals/site-url";
import { MAX_LIMIT } from "@/lib/services/public-listings";

/**
 * The portal feed (spec 2026-09-14 §The feed route; migrations 0095, 0150).
 *
 * PUBLIC AND UNAUTHENTICATED BY DESIGN, like /api/public/listings beside it:
 * a portal's crawler pulls it on its own schedule. `proxy.ts` exempts
 * `/api/portals/`. It READS with the anon client, whose reach is the two
 * readers 0150 grants anon by name, and WRITES — the pull record and the
 * export revision — with the service role, through the two functions 0150
 * grants nobody else (the enquiry door's precedent, 0087). So a token holder
 * can read the feed and nothing more: they cannot write the telemetry or the
 * dates over PostgREST.
 *
 * The token in the path is the whole of the caller's proof. A wrong one costs
 * one indexed lookup and a 404 and is NOT metered: there is nothing behind
 * it to protect, and a counter row would be the shared-lock problem REL-03
 * removed from the site feed on 2026-09-13.
 *
 * THE TOKEN GOES TO THE DATABASE AS IT IS, and the database hashes it (0150).
 * The column holds sha256(token), so a dump, an export or a member's read of
 * it holds no credential: the readers hash what they are given, and the
 * stored value hashed again is not the stored value. Every URL issued since
 * 0097 keeps working — the column did not change.
 *
 * WHAT EACH ANSWER MEANS (portal integrations audit 2026-10-18, finding 2).
 *   200 + document  — the selected listings that pass the portal's
 *                     requirements; an EMPTY document only when nothing is
 *                     selected, or every selected listing left the website
 *                     or failed requirements the desk controls.
 *   200 + empty     — the portal is DISABLED (no-store): every pull portal
 *                     treats absence as removal, so the empty document clears
 *                     our listings there; a 404 would leave them stale.
 *   503             — a fault: a database answer that failed, was hollow,
 *                     malformed or shorter than the connection's own count of
 *                     the selection; a scan that was truncated or found none
 *                     of the selected listings; invalid stored settings.
 *                     Never an empty document, because the portal would
 *                     withdraw everything for a reason that is nobody's
 *                     decision.
 *   404             — unknown portal, a token that is not token-shaped, or a
 *                     token that matches nothing (or a lookup that failed —
 *                     the two look identical from outside, on purpose).
 * Every answer to a valid token is RECORDED (record_portal_pull): what the
 * portal asked for, what it got, and why — so the settings page can tell a
 * failing feed from a portal that stopped asking.
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
 * withholds — never the point of an approximate location: the SQL itself
 * returns null lat/lng when `location_approx` is set, and every renderer
 * double-checks the flag it still receives (dialects/approx-guard.test.ts).
 *
 * No CORS headers and no OPTIONS handler: a portal's crawler is
 * server-to-server, so no browser ever preflights this.
 *
 * `max-age` is 300: a portal pulls between once and three times a day, so five
 * minutes of edge cache costs a portal nothing it would notice and spares the
 * database the burst when several pull together. The ETag is the body's own
 * digest: each listing's date is its export revision, so the bytes change
 * exactly when what the portal receives changes, and an unchanged feed
 * answers 304.
 */
export const dynamic = "force-dynamic";

const MAX_AGE_SECONDS = 300;
const CACHE_CONTROL = `public, max-age=${MAX_AGE_SECONDS}`;
const NO_STORE = { "Cache-Control": "no-store" } as const;
const TOKEN = /^[0-9a-f]{64}$/;
/** PostgREST answers at most `max_rows` (1000, supabase/config.toml) per call; the supplement is read in pages of at most this. */
const SUPPLEMENT_PAGE = 1000;
/** The assembler's own budget, shared: a selection it could never finish scanning is refused before the round trips, not after. */
const SUPPLEMENT_CEILING = MAX_PAGES * MAX_LIMIT;

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
const unavailable = () =>
  NextResponse.json({ error: "Feed unavailable." }, { status: 503, headers: NO_STORE });

const isSettingsObject = (v: unknown) => v === null || (typeof v === "object" && !Array.isArray(v));

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

  const connection = await supabase.rpc("portal_feed_connection", { p_portal: portalId, p_token: token });
  // A wrong token, a database that would not answer and an answer with no
  // rows in it all look identical from outside, on purpose: none tells a
  // guesser that a token was close, and none becomes a document.
  if (connection.error || !Array.isArray(connection.data)) {
    if (connection.error) {
      console.error(`[portal-feed] ${portalId}: connection lookup failed — ${connection.error.message}`);
    }
    return notFound();
  }
  const row = connection.data[0] as
    | { org_slug?: unknown; enabled?: unknown; settings?: unknown; selected_count?: unknown }
    | undefined;
  if (!row) return notFound();

  // Read at the top, never inside the deferred record: the request's headers
  // are the request's, and the record runs after the response has gone.
  const userAgent = request.headers.get("user-agent") ?? "";
  const record = (r: Omit<PullRecord, "token" | "userAgent" | "portalId">) =>
    recordPortalPullAfter(createAdminClient, { token, userAgent, portalId, ...r });
  const failed = (reason: PullRecord["reason"], message: string, counts: Partial<PullRecord> = {}) => {
    console.error(`[portal-feed] ${portalId}: ${message}`);
    record({ outcome: "failed", served: null, selected: null, excluded: null, reason, detail: {}, ...counts });
    return unavailable();
  };

  // The token matched a connection, so this is the portal asking; a row of
  // the wrong shape is a skewed or re-routed answer, and `!row.enabled` on it
  // would serve the empty document — a withdrawal nobody chose.
  if (
    typeof row.enabled !== "boolean" ||
    typeof row.org_slug !== "string" ||
    !row.org_slug ||
    !isSettingsObject(row.settings) ||
    typeof row.selected_count !== "number" ||
    !Number.isInteger(row.selected_count) ||
    row.selected_count < 0
  ) {
    return failed("connection_malformed", "connection lookup answered a row of the wrong shape");
  }
  const orgSlug = row.org_slug;
  const selectedCount = row.selected_count;

  // Disabled is a VALID feed with nothing in it — see the header. It must be
  // a document rather than an error, and it must never be cached: the desk
  // flips the switch back and the next pull has to see the listings again.
  if (!row.enabled) {
    record({ outcome: "disabled", served: 0, selected: null, excluded: null, reason: null, detail: {} });
    return new NextResponse(renderer.empty(), {
      status: 200,
      headers: { "Content-Type": renderer.contentType, ...NO_STORE },
    });
  }

  // The supplement is the selection ∩ what the site feed shows, ordered by
  // reference (unique per org: a page over an unordered set can repeat a row
  // and skip another), read until an EMPTY page — so a lowered max_rows
  // cannot end the read early — and checked row by row. A failure, a hollow
  // answer or a malformed row is a 503, never an empty document.
  let supplementRows: unknown[];
  try {
    const read = await fetchUpTo<unknown>(
      (from, to) =>
        supabase
          .rpc("portal_feed_supplement", { p_token: token })
          .order("reference")
          .range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null; status?: number }>,
      "portal supplement",
      SUPPLEMENT_CEILING,
      SUPPLEMENT_PAGE,
    );
    if (read.more) {
      // the assembler would refuse a selection this size anyway (it scans at
      // most MAX_PAGES pages of MAX_LIMIT), so stop here
      return failed("selection_too_large", `selection exceeds ${SUPPLEMENT_CEILING} rows`);
    }
    supplementRows = read.rows;
  } catch (e) {
    return failed("supplement_failed", `supplement failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  const supplements = parseSupplementRows(supplementRows);
  if (!supplements) return failed("supplement_malformed", "supplement answered rows of the wrong shape");
  // The connection counted the selection itself. A supplement that came back
  // SHORTER is a lost page or a hollow answer postgrest-js turned into `[]` —
  // indistinguishable from an empty selection by its shape alone — OR a
  // listing sold, withdrawn or deselected between the two reads, which must
  // simply leave the feed. So count again: still short of a fresh count is a
  // fault; not short any more is a departure. (Longer is a listing that went
  // public between the reads: served as it now is.)
  if (supplements.length < selectedCount) {
    const recount = await supabase.rpc("portal_feed_connection", { p_portal: portalId, p_token: token });
    const fresh = Array.isArray(recount.data)
      ? (recount.data[0] as { enabled?: unknown; selected_count?: unknown } | undefined)
      : undefined;
    const freshCount =
      !recount.error && fresh?.enabled === true && typeof fresh.selected_count === "number"
        ? fresh.selected_count
        : null;
    if (freshCount === null || supplements.length < freshCount) {
      return failed(
        "supplement_incomplete",
        `supplement answered ${supplements.length} of the ${freshCount ?? selectedCount} selected listing(s)`,
        { selected: freshCount ?? selectedCount },
      );
    }
  }

  // Parsed, not cast: `settings` is jsonb the desk typed into a form, and the
  // dialect renders it straight into the document. The FEED's schema is the
  // lenient one (registry.ts), so only a value no portal could use stops it.
  const settings = portal.settingsSchema.safeParse(row.settings ?? {});
  if (!settings.success) {
    return failed("settings_invalid", `settings invalid — ${settings.error.issues[0]?.message}`, {
      selected: supplements.length,
    });
  }

  const result = await assemblePortalFeed({
    portal,
    renderer,
    settings: settings.data,
    supplements,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    listingUrl: (reference) => publicListingUrl(reference),
    // The assembler owns the page size; a short page is how it learns the scan
    // is over, so the offset and the limit go through exactly as given. A
    // hollow or malformed page THROWS — it is not a short page.
    fetchPage: async (offset, limit) => {
      const page = rowsOf(
        await supabase.rpc("public_listings", { p_org_slug: orgSlug, p_limit: limit, p_offset: offset }),
        "public listings",
      );
      const parsed = parseListingRows(page);
      if (!parsed) throw new Error("public listings: rows of the wrong shape");
      return parsed;
    },
    // the re-check of a selected listing the scan did not find (feed.ts)
    fetchByReference: async (reference) => {
      const parsed = parseListingRows(
        rowsOf(
          await supabase.rpc("public_listings", { p_org_slug: orgSlug, p_limit: 1, p_offset: 0, p_reference: reference }),
          "public listings by reference",
        ),
      );
      if (!parsed) throw new Error("public listings by reference: rows of the wrong shape");
      return parsed;
    },
    // service role (0150 sync_portal_export): only the route may date a
    // listing. One jsonb object {reference: changed_at} — a table answer would
    // be capped at max_rows. Anything else throws, and the assembler falls
    // back to updated_at for the whole document.
    syncRevisions: async (rows: readonly RevisionRow[]) => {
      const { data, error } = await createAdminClient().rpc("sync_portal_export", {
        p_token: token,
        p_rows: rows as unknown as never,
      });
      if (error) throw new Error(`sync_portal_export: ${error.message || `code ${error.code || "?"}`}`);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("sync_portal_export: no object");
      const out = new Map<string, string>();
      for (const [reference, at] of Object.entries(data as Record<string, unknown>)) {
        if (typeof at === "string" && !Number.isNaN(Date.parse(at))) out.set(reference, at);
      }
      return out;
    },
  });

  if (!result.ok) return failed(result.reason, result.error, { selected: result.selected });

  // Exclusions are served — they are the desk's data — but never silent: the
  // pull record carries them by reason for Settings → Portals.
  if (result.excluded > 0) {
    console.warn(`[portal-feed] ${portalId}: ${result.excluded} of ${result.selected} selected listing(s) excluded`);
  }
  if (result.missing > 0) {
    console.warn(`[portal-feed] ${portalId}: ${result.missing} selected reference(s) not in the site feed`);
  }
  if (result.revisions === "fallback") {
    console.warn(`[portal-feed] ${portalId}: export revisions unavailable — dates fell back to updated_at`);
  }

  const detail: Record<string, number | string> = { ...result.excludedByReason, revisions: result.revisions };
  if (result.missing) detail.missing = result.missing;
  if (result.renditionGaps) detail.rendition_gaps = result.renditionGaps;

  // Before the 304 check: a portal told "unchanged" has still pulled, and
  // "last requested" on the settings page means when it last ASKED.
  record({
    outcome: "served",
    served: result.count,
    selected: result.selected,
    excluded: result.excluded,
    reason: null,
    detail,
  });

  const etag = feedEtag(portalId, result.body);
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
