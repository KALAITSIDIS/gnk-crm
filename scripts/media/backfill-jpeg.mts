#!/usr/bin/env node
/**
 * One-off after 0095: give every existing photo its JPEG rendition.
 *
 * Reads the stored `full` WebP (already EXIF-free and watermarked as policy
 * had it), re-encodes to JPEG at the same width — the SAME encode the pipeline
 * uses (JPEG_ENCODE, alpha flattened to white) — uploads it beside the WebP,
 * and sets path_jpeg. Idempotent: rows with path_jpeg are skipped, so it can
 * be rerun after a partial failure. Service role, like the importers.
 *
 * PAGES, because PostgREST caps a select (1000 rows by default) and the filter
 * is `path_jpeg is null`: each pass's writes remove rows from the next query,
 * so the loop simply re-queries. It stops when a pass returns no row it has
 * not already tried — without that guard a run where every row is a skip
 * would fetch the same page forever.
 *
 * A row that throws (an unreadable object, an encoder refusing a file) is
 * counted and stepped over: one bad photo must not cost the tally of the
 * hundreds behind it. Skips go to stderr, the tally to stdout.
 *
 *   node --env-file=.env.local scripts/media/backfill-jpeg.mts          # local
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/media/backfill-jpeg.mts   # hosted
 */
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { JPEG_ENCODE, renditionExt } from "../../lib/services/media.ts";
import { mediaBucketFor } from "../../lib/services/media-bucket.ts";
import type { Database } from "../../lib/supabase/database.types.ts";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}
const supabase = createClient<Database>(url, key, { auth: { persistSession: false } });
/** A photograph's renditions are public — one function decides, everywhere. */
const bucket = mediaBucketFor("photo");

let done = 0;
let failed = 0;
let seen = 0;
/** every row this run has already tried — the loop's guard AND its tally */
const attempted = new Set<string>();

for (;;) {
  const { data: rows, error } = await supabase
    .from("property_media")
    .select("id, path_full")
    .eq("kind", "photo")
    .is("path_jpeg", null)
    .not("path_full", "is", null)
    .order("id");
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  // a pass that returns nothing new is the end: either every candidate is
  // written, or what is left are rows this run already failed on and would
  // fail on again — which is what stops the loop spinning forever
  const fresh = (rows ?? []).filter((r) => !attempted.has(r.id));
  if (fresh.length === 0) break;

  for (const row of fresh) {
    attempted.add(row.id);
    const full = row.path_full!;
    seen++;
    if (seen % 25 === 0) console.log(`backfill-jpeg: ${seen} processed, ${done} written…`);

    const jpegPath = full.replace(/_full\.webp$/, `_jpeg.${renditionExt("jpeg")}`);
    if (jpegPath === full) {
      console.error(`skip ${row.id}: unexpected path ${full}`);
      failed++;
      continue;
    }
    try {
      const dl = await supabase.storage.from(bucket).download(full);
      if (dl.error || !dl.data) throw new Error(`download failed — ${dl.error?.message}`);
      const jpeg = await sharp(Buffer.from(await dl.data.arrayBuffer()))
        .flatten({ background: "#ffffff" })
        .jpeg(JPEG_ENCODE)
        .toBuffer();
      const up = await supabase.storage
        .from(bucket)
        .upload(jpegPath, jpeg, { contentType: "image/jpeg", upsert: true });
      if (up.error) throw new Error(`upload failed — ${up.error.message}`);
      const upd = await supabase
        .from("property_media")
        .update({ path_jpeg: jpegPath })
        .eq("id", row.id)
        .select("id");
      // the service role has no RLS over it, but a row deleted mid-run updates
      // zero rows and reports no error at all: count that, never claim it
      if (upd.error || !upd.data?.length) {
        throw new Error(`row update failed — ${upd.error?.message ?? "0 rows"}`);
      }
      done++;
    } catch (err) {
      console.error(`skip ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
}

console.log(`backfill-jpeg: ${done} written, ${failed} skipped, ${attempted.size} candidates`);
process.exit(failed ? 1 : 0);
