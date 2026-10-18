import type { FeedListing } from "@/lib/services/portals/feed-listing";

/**
 * A dialect is a pure function from listings to a document. This interface is
 * the seam the spec names: a push adapter (not planned) would implement a
 * sibling interface reading the same `FeedListing`.
 *
 * It lives here rather than in `index.ts` so a dialect can implement it without
 * importing the module that imports every dialect — with two dialects that
 * would be a real import cycle, not a type-only one.
 */
export interface DialectRenderer {
  /** the whole document; each listing's update date is its `revisionAt` (falling back to `row.updated_at`) */
  render(listings: readonly FeedListing[], settings: Record<string, string>): string;
  /**
   * One listing exactly as the portal receives it, with its update date LEFT
   * OUT — the input of the export revision (0150 portal_export_state). Two
   * calls on unchanged data must return the same bytes, and any change to what
   * the portal receives for the listing must change them.
   */
  fingerprint(listing: FeedListing, settings: Record<string, string>): string;
  /** what a DISABLED portal's URL answers: valid, and empty, so the portal clears its copy */
  empty(): string;
  contentType: string;
}
