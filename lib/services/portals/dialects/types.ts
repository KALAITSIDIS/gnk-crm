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
  render(listings: readonly FeedListing[], settings: Record<string, string>): string;
  /** what a DISABLED portal's URL answers: valid, and empty, so the portal clears its copy */
  empty(): string;
  contentType: string;
}
