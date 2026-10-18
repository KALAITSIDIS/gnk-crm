import { createHash } from "node:crypto";
import { MAX_LIMIT } from "@/lib/services/public-listings";
import type { DialectRenderer } from "./dialects/types";
import { eligibilityFor, eligibilityInputFromFeed, photoMeetsMinimum, type EligibilityReason } from "./eligibility";
import { buildFeedListings, type FeedListing, type FeedRow, type SupplementRow } from "./feed-listing";
import type { PullReason } from "./pull-note";
import type { PortalDefinition } from "./registry";

/** the CRM's own ceiling, chosen on 2026-09-14 to match what gnk-web reads the site feed with */
export const MAX_PAGES = 25;

/**
 * At most this many selected references the scan did not find are looked up
 * one by one before the feed is served; more than that is a scan that went
 * wrong, not a few listings that left the website between two reads.
 */
export const MAX_RECHECK = 25;

/** One listing's export fingerprint, as sync_portal_export (0150) takes it. */
export interface RevisionRow {
  reference: string;
  sha256: string;
}

export interface AssembleArgs {
  portal: PortalDefinition;
  renderer: DialectRenderer;
  settings: Record<string, string>;
  supplements: readonly SupplementRow[];
  supabaseUrl: string;
  /**
   * one page of `public_listings()`, CHECKED (feed-listing.ts parseListingRows)
   * — the caller MUST use exactly `limit` as the page size, because a short
   * page means the last page; throws on a database error or a hollow answer
   */
  fetchPage: (offset: number, limit: number) => Promise<FeedRow[]>;
  /**
   * one listing of `public_listings()` by reference (its `p_reference`), CHECKED
   * — the re-check of a selected reference the scan did not find; throws on a
   * database error or a hollow answer
   */
  fetchByReference?: (reference: string) => Promise<FeedRow[]>;
  /**
   * Record each listing's fingerprint and answer when each last changed
   * (0150 sync_portal_export). Absent, or throwing, and every listing is dated
   * by its row's `updated_at` — the feed still goes out; `revisions` says so.
   */
  syncRevisions?: (rows: readonly RevisionRow[]) => Promise<ReadonlyMap<string, string>>;
  /** the listing's page on the public website (site-url.ts), or null */
  listingUrl?: (reference: string) => string | null;
  /** override MAX_PAGES — tests build small windows instead of twenty-five pages */
  maxPages?: number;
}

export type ExclusionCounts = Partial<Record<EligibilityReason, number>>;

export type AssembleResult =
  | {
      ok: true;
      body: string;
      /** listings in the document */
      count: number;
      /** selected listings the portal could see: the supplement (selection ∩ on the website) */
      selected: number;
      /** selected references the completed scan did not find (they left the site between two reads) */
      missing: number;
      /** found, but kept out by the portal's requirements */
      excluded: number;
      excludedByReason: ExclusionCounts;
      /** of the excluded, how many only for photos whose JPEG renditions are missing (isRenditionGap) */
      renditionGaps: number;
      /** where the dates came from: synced (0150), fallback (updated_at — the sync failed or answered incompletely), none (no sync given) */
      revisions: "synced" | "fallback" | "none";
    }
  | {
      ok: false;
      reason: PullReason;
      error: string;
      selected: number;
    };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * A listing kept out ONLY for its photo count, while the WEBSITE shows at
 * least as many photos as the portal needs and more than the portal got: the
 * photos exist, their JPEG renditions do not. That is the pipeline's fault
 * (a stalled backfill, a direct write that landed rows without path_jpeg),
 * never the desk's — uploads and the importer write the rendition with the
 * row. Counted and recorded so Settings → Portals can say so; never a reason
 * to refuse the feed (see assemblePortalFeed).
 */
function isRenditionGap(portal: PortalDefinition, l: FeedListing, reasons: readonly EligibilityReason[]): boolean {
  if (reasons.length !== 1 || reasons[0] !== "too_few_photos") return false;
  const sitePhotos = Array.isArray(l.row.images) ? l.row.images.length : 0;
  return sitePhotos >= portal.requirements.minPhotos && l.images.length < sitePhotos;
}

/**
 * The portal feed is a PROJECTION of the site feed: page through
 * public_listings(), keep the references the supplement (selection ∩ public)
 * names, drop what the portal's requirements refuse, date each listing by
 * when its rendering last changed, render. A page that fails is an error —
 * never an empty document, because every pull portal treats an empty feed as
 * "remove everything". No selection means no query.
 *
 * A scan that never completes (the ceiling reached before an empty page or
 * every wanted reference) is ALSO an error, for the same reason — an
 * incomplete scan cannot tell "not on this feed" from "would be here on the
 * next page". A scan that DOES complete but misses references asks for each
 * by reference (at most MAX_RECHECK): one still on the website goes in — the
 * scan skipped it (an offset window that moved, a hollow page) — and one that
 * is not is served without, its departure a real one. More misses than that,
 * or none of the selection found at all, is refused: every selected listing
 * leaving the website between two reads a few milliseconds apart is not a
 * race anyone will see, while a hollow page postgrest-js turned into `[]` is.
 *
 * NO WITHHOLDING FOR EXCLUSIONS (portal integrations audit 2026-10-18,
 * finding 5, decided against after review). A listing that fails the
 * portal's requirements is left out and the smaller document is served, even
 * when that leaves it empty: a 503 makes the portal keep its WHOLE previous
 * copy, so sold, withdrawn and deselected listings would stay up with it, and
 * a stale price would stay advertised. Exclusions are made visible instead —
 * counted by reason in every pull record and listed with their fixes on
 * Settings → Portals.
 */
export async function assemblePortalFeed(a: AssembleArgs): Promise<AssembleResult> {
  const wanted = new Set(a.supplements.map((s) => s.reference));
  const maxPages = a.maxPages ?? MAX_PAGES;
  const limit = MAX_LIMIT;
  const rows: FeedRow[] = [];
  const seen = new Set<string>();
  const fail = (reason: PullReason, error: string): AssembleResult => ({
    ok: false,
    reason,
    error,
    selected: wanted.size,
  });

  if (wanted.size > 0) {
    try {
      // fetchUpTo's rule: advance by what arrived and stop only on an EMPTY
      // page (or once every wanted reference is in hand) — a short page is
      // not the last one when PostgREST's max_rows is set below the limit
      let completed = false;
      let offset = 0;
      for (let page = 0; page < maxPages; page++) {
        const batch = await a.fetchPage(offset, limit);
        if (batch.length > limit) throw new Error("public listings: a page longer than was asked for");
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
        if (seen.size === wanted.size || batch.length === 0) {
          completed = true;
          break;
        }
        offset += batch.length;
      }
      if (!completed) return fail("truncated", "feed truncated at the page ceiling");

      // A reference the scan missed is either a listing that left the website
      // between the supplement and the paging (served without it), or a row
      // the scan skipped — an offset window that moved when another listing
      // left, a hollow page. Ask for each by reference: one still public goes
      // in; too many to ask about is a scan that went wrong.
      const unseen = [...wanted].filter((r) => !seen.has(r));
      if (unseen.length && a.fetchByReference) {
        if (unseen.length > MAX_RECHECK) {
          return fail(
            "listings_incomplete",
            `the site feed scan missed ${unseen.length} of the ${wanted.size} selected listing(s)`,
          );
        }
        for (const reference of unseen) {
          const hit = (await a.fetchByReference(reference)).find((r) => r.reference === reference);
          if (hit) {
            seen.add(reference);
            rows.push(hit);
          }
        }
      }
    } catch (e) {
      return fail("listings_failed", e instanceof Error ? e.message : String(e));
    }
    if (seen.size === 0) {
      return fail("listings_incomplete", `the site feed answered none of the ${wanted.size} selected listing(s)`);
    }
  }

  let found: FeedListing[];
  try {
    found = buildFeedListings(rows, a.supplements, a.supabaseUrl, a.listingUrl);
  } catch (e) {
    return fail("render_failed", e instanceof Error ? e.message : String(e));
  }

  const listings: FeedListing[] = [];
  const excludedByReason: ExclusionCounts = {};
  let excluded = 0;
  let gaps = 0;
  for (const l of found) {
    const e = eligibilityFor(a.portal, eligibilityInputFromFeed(l));
    if (e.ok) {
      // a portal with a minimum photo size receives only the photos that meet
      // it — JamesEdition refuses a listing with any low-resolution image, and
      // eligibility has already made sure enough of them remain
      listings.push(
        a.portal.requirements.minImage
          ? { ...l, images: l.images.filter((i) => photoMeetsMinimum(a.portal, i)) }
          : l,
      );
      continue;
    }
    excluded++;
    if (isRenditionGap(a.portal, l, e.reasons)) gaps++;
    for (const r of e.reasons) excludedByReason[r] = (excludedByReason[r] ?? 0) + 1;
  }
  const missing = wanted.size - seen.size;

  let revisions: "synced" | "fallback" | "none" = "none";
  try {
    // Synced on EVERY successful assembly, an empty one included: the sync
    // also forgets the listings no longer in the feed, so one that leaves in
    // a pull serving nothing comes back new, like any other (0150).
    if (a.syncRevisions) {
      const fingerprints = listings.map((l) => ({
        reference: l.row.reference,
        sha256: sha256(a.renderer.fingerprint(l, a.settings)),
      }));
      let changedAt: ReadonlyMap<string, string> | null = null;
      try {
        changedAt = await a.syncRevisions(fingerprints);
      } catch {
        changedAt = null;
      }
      // every listing must come back dated, or none is trusted: a partial
      // answer would mix two clocks in one document
      if (changedAt && listings.every((l) => changedAt!.has(l.row.reference))) {
        for (const l of listings) l.revisionAt = changedAt.get(l.row.reference)!;
        revisions = "synced";
      } else {
        revisions = "fallback";
      }
    }
    const body = listings.length ? a.renderer.render(listings, a.settings) : a.renderer.empty();
    return {
      ok: true,
      body,
      count: listings.length,
      selected: wanted.size,
      missing,
      excluded,
      excludedByReason,
      renditionGaps: gaps,
      revisions,
    };
  } catch (e) {
    return fail("render_failed", e instanceof Error ? e.message : String(e));
  }
}
