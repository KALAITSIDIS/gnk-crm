import type { Database } from "@/lib/supabase/database.types";

export type MediaKind = Database["public"]["Enums"]["media_kind"];

/** The two buckets 0001 created: `media` is PUBLIC (any URL is readable by anyone), `documents` is not. */
export type MediaBucket = "media" | "documents";

/**
 * Which bucket a media row's RENDITIONS live in, decided by what the row is.
 *
 * Until 2026-09-06 every rendition went to the public `media` bucket, because
 * the pipeline was built for photographs and floor plans were bolted onto it
 * (MEDIA-K, 2026-09-02). The feed and the share links select `kind = 'photo'`,
 * so a plan never appeared on the site — but its renditions sat in a public
 * bucket under a guessable path, readable by anyone who had the URL or could
 * enumerate it (the audit's A07). A plan is the one thing about a property a
 * seller may hold under confidentiality.
 *
 * So: a photograph's renditions are public, because publishing them is what
 * they are for; everything else goes to the private bucket and is served to
 * the desk through a signed URL, the same way the original (EXIF-bearing)
 * upload always has been. ONE function decides, read by the upload, the
 * delete, the page that renders the tab, and the one-off move script — the
 * bucket is never spelled next to a rendition path again
 * (lib/services/media-bucket.test.ts scans for it).
 */
export function mediaBucketFor(kind: MediaKind | string): MediaBucket {
  return kind === "photo" ? "media" : "documents";
}
