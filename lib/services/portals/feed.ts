import { MAX_LIMIT } from "@/lib/services/public-listings";
import type { DialectRenderer } from "./dialects/types";
import { eligibilityFor, eligibilityInputFromFeed } from "./eligibility";
import { buildFeedListings, type PublicListingRow, type SupplementRow } from "./feed-listing";
import type { PortalDefinition } from "./registry";

/** 25 × 100 = 2,500 listings — the ceiling gnk-web reads the site feed with. */
export const MAX_PAGES = 25;

export interface AssembleArgs {
  portal: PortalDefinition;
  renderer: DialectRenderer;
  settings: Record<string, string>;
  supplements: readonly SupplementRow[];
  supabaseUrl: string;
  /** one page of `public_listings()` at this offset; throws on a database error */
  fetchPage: (offset: number) => Promise<PublicListingRow[]>;
}

export type AssembleResult =
  | { ok: true; body: string; count: number; truncated: boolean }
  | { ok: false; error: string };

/**
 * The portal feed is a PROJECTION of the site feed: page through
 * public_listings(), keep the references the supplement (selection ∩ public)
 * names, drop what the portal's requirements refuse, render. A page that
 * fails is an error — never an empty document, because every pull portal
 * treats an empty feed as "remove everything". No selection means no query.
 */
export async function assemblePortalFeed(a: AssembleArgs): Promise<AssembleResult> {
  const wanted = new Set(a.supplements.map((s) => s.reference));
  const rows: PublicListingRow[] = [];
  let truncated = false;
  if (wanted.size > 0) {
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await a.fetchPage(page * MAX_LIMIT);
        for (const r of batch) if (wanted.has(r.reference)) rows.push(r);
        if (rows.length === wanted.size || batch.length < MAX_LIMIT) break;
        if (page === MAX_PAGES - 1) truncated = true;
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const listings = buildFeedListings(rows, a.supplements, a.supabaseUrl).filter(
    (l) => eligibilityFor(a.portal, eligibilityInputFromFeed(l)).ok,
  );
  const body = listings.length ? a.renderer.render(listings, a.settings) : a.renderer.empty();
  return { ok: true, body, count: listings.length, truncated };
}
