#!/usr/bin/env node
/**
 * One-off after 0095: give every existing photo its JPEG rendition.
 *
 * Reads the stored `full` WebP (already EXIF-free and watermarked as policy
 * had it), re-encodes to JPEG at the same width, uploads beside it, and sets
 * path_jpeg. Idempotent: rows with path_jpeg are skipped, so it can be rerun
 * after a partial failure. Service role, like the importers.
 *
 *   node --env-file=.env.local scripts/media/backfill-jpeg.mts          # local
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/media/backfill-jpeg.mts   # hosted
 */
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: rows, error } = await supabase
  .from("property_media")
  .select("id, path_full")
  .eq("kind", "photo")
  .is("path_jpeg", null)
  .not("path_full", "is", null);
if (error) {
  console.error(error.message);
  process.exit(1);
}

let done = 0;
let failed = 0;
for (const row of rows ?? []) {
  const full = row.path_full as string;
  const jpegPath = full.replace(/_full\.webp$/, "_jpeg.jpg");
  if (jpegPath === full) {
    console.warn(`skip ${row.id}: unexpected path ${full}`);
    failed++;
    continue;
  }
  const dl = await supabase.storage.from("media").download(full);
  if (dl.error || !dl.data) {
    console.warn(`skip ${row.id}: download failed — ${dl.error?.message}`);
    failed++;
    continue;
  }
  const jpeg = await sharp(Buffer.from(await dl.data.arrayBuffer()))
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  const up = await supabase.storage
    .from("media")
    .upload(jpegPath, jpeg, { contentType: "image/jpeg", upsert: true });
  if (up.error) {
    console.warn(`skip ${row.id}: upload failed — ${up.error.message}`);
    failed++;
    continue;
  }
  const upd = await supabase
    .from("property_media")
    .update({ path_jpeg: jpegPath })
    .eq("id", row.id)
    .select("id");
  if (upd.error || !upd.data?.length) {
    console.warn(`skip ${row.id}: row update failed — ${upd.error?.message ?? "0 rows"}`);
    failed++;
    continue;
  }
  done++;
}
console.log(`backfill-jpeg: ${done} written, ${failed} skipped, ${(rows ?? []).length} candidates`);
process.exit(failed ? 1 : 0);
