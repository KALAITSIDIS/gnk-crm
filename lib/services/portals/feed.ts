import { MAX_LIMIT } from "@/lib/services/public-listings";
import type { DialectRenderer } from "./dialects/types";
import { eligibilityFor, eligibilityInputFromFeed } from "./eligibility";
import { buildFeedListings, type PublicListingRow, type SupplementRow } from "./feed-listing";
import type { PortalDefinition } from "./registry";

/** the CRM's own ceiling, chosen on 2026-09-14 to match what gnk-web reads the site feed with */
export const MAX_PAGES = 25;

export interface AssembleArgs {
  portal: PortalDefinition;
  renderer: DialectRenderer;
  settings: Record<string, string>;
  supplements: readonly SupplementRow[];
  supabaseUrl: string;
  /**
   * one page of `public_listings()` — the caller MUST use exactly `limit` as
   * the page size, because a short page means the last page; throws on a
   * database error
   */
  fetchPage: (offset: number, limit: number) => Promise<PublicListingRow[]>;
  /** override MAX_PAGES — tests build small windows instead of twenty-five pages */
  maxPages?: number;
}

export type AssembleResult =
  | { ok: true; body: string; count: number; selected: number; missing: number }
  | { ok: false; error: string };

/**
 * The portal feed is a PROJECTION of the site feed: page through
 * public_listings(), keep the references the supplement (selection ∩ public)
 * names, drop what the portal's requirements refuse, render. A page that
 * fails is an error — never an empty document, because every pull portal
 * treats an empty feed as "remove everything". No selection means no query.
 *
 * A scan that never completes (every page full, the ceiling reached before
 * every wanted reference turned up) is ALSO an error, for the same reason —
 * an incomplete scan cannot tell "not on this feed" from "would be here on
 * the next page". A scan that DOES complete (a short page ends it) but still
 * misses a reference is not an error: the listing may have gone non-public
 * between the supplement call and the paging, so it is served with the miss
 * reported rather than the whole feed refused.
 */
export async function assemblePortalFeed(a: AssembleArgs): Promise<AssembleResult> {
  const wanted = new Set(a.supplements.map((s) => s.reference));
  const maxPages = a.maxPages ?? MAX_PAGES;
  const limit = MAX_LIMIT;
  const rows: PublicListingRow[] = [];
  const seen = new Set<string>();
  if (wanted.size > 0) {
    try {
      let hitCeiling = true;
      for (let page = 0; page < maxPages; page++) {
        const batch = await a.fetchPage(page * limit, limit);
        // selection is re-checked in buildFeedListings; this copy is what
        // makes the early stop and the row budget possible, and `seen` keeps
        // a reference that a window shift between page fetches returned
        // twice from being emitted twice
        for (const r of batch) {
          if (wanted.has(r.reference) && !seen.has(r.reference)) {
            seen.add(r.reference);
            rows.push(r);
          }
        }
        if (seen.size === wanted.size || batch.length < limit) {
          hitCeiling = false;
          break;
        }
      }
      if (hitCeiling && seen.size < wanted.size) {
        return { ok: false, error: "feed truncated at the page ceiling" };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const listings = buildFeedListings(rows, a.supplements, a.supabaseUrl).filter(
    (l) => eligibilityFor(a.portal, eligibilityInputFromFeed(l)).ok,
  );
  const body = listings.length ? a.renderer.render(listings, a.settings) : a.renderer.empty();
  return { ok: true, body, count: listings.length, selected: wanted.size, missing: wanted.size - seen.size };
}
