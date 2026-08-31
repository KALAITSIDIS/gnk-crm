import type { Database } from "@/lib/supabase/database.types";

export type MediaKind = Database["public"]["Enums"]["media_kind"];

/**
 * MEDIA-K (2026-09-02): the kinds an UPLOAD may set. The enum has carried
 * floor_plan since 0001 while both insert paths hardcoded photo — plans hid
 * as generic documents. Only raster-uploadable kinds belong here:
 * video/virtual_tour are external_url kinds with no upload pipeline.
 *
 * Lives in a validators file, NOT lib/actions/media.ts — a "use server"
 * file may only export async functions (documented production crash, see
 * lib/validators/documents.ts).
 *
 * Floor plans stay INTERNAL: the feed and share links filter kind='photo'
 * in SQL (0073/0041, pinned by RLS test 49), floor plans are never
 * cover-eligible, and they do not count toward the photo quality score.
 * NB "internal" is metadata-level — renditions still land in the public
 * media bucket; a plan's URL is fetchable by whoever holds it.
 */
export const UPLOADABLE_MEDIA_KINDS = ["photo", "floor_plan"] as const satisfies
  readonly MediaKind[];
