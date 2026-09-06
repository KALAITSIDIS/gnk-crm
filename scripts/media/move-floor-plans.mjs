#!/usr/bin/env node
/**
 * One-off: move every non-photograph rendition out of the PUBLIC `media`
 * bucket into the private `documents` bucket (audit A07, 2026-09-06).
 *
 * Until lib/services/media-bucket.ts, floor-plan renditions were uploaded to
 * the public bucket beside photographs. New uploads go to the right bucket;
 * this moves what was already there. Paths do not change — only the bucket —
 * so `property_media` needs no update: the page decides the bucket from
 * `kind` at read time.
 *
 * DRY RUN BY DEFAULT. Pass --apply to move. Idempotent: an object already in
 * `documents` (or absent from `media`) is reported and skipped.
 *
 *   node --env-file=.env.local scripts/media/move-floor-plans.mjs            # local, dry run
 *   node --env-file=.env.local scripts/media/move-floor-plans.mjs --apply
 *   node --env-file=<the operator's secret file> scripts/media/move-floor-plans.mjs --apply   # hosted
 *
 * Reads SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY
 * from the environment. Never prints either. On 2026-09-06 production held 12
 * media rows, all photographs, so it had nothing to move; the script exists
 * for the day it does, and for local stacks with test residue.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (via --env-file).");
  process.exit(2);
}
const apply = process.argv.includes("--apply");
const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: rows, error } = await supabase
  .from("property_media")
  .select("id, property_id, kind, path_thumb, path_card, path_full")
  .neq("kind", "photo")
  .order("id");
if (error) {
  console.error("could not list property_media:", error.message);
  process.exit(1);
}

const paths = rows.flatMap((r) => [r.path_thumb, r.path_card, r.path_full]).filter(Boolean);
console.log(`${rows.length} non-photo media row(s), ${paths.length} rendition path(s)${apply ? "" : " — DRY RUN, pass --apply to move"}`);

let moved = 0, skipped = 0, failed = 0;
for (const path of paths) {
  // Present in the public bucket? (list the parent, match the name)
  const dir = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const { data: listing } = await supabase.storage.from("media").list(dir, { search: name });
  const inPublic = (listing ?? []).some((o) => o.name === name);
  if (!inPublic) {
    skipped++;
    console.log(`  skip  ${path} (not in media — already moved, or never there)`);
    continue;
  }
  if (!apply) {
    console.log(`  would move  ${path}`);
    continue;
  }
  const { error: copyErr } = await supabase.storage
    .from("media")
    .copy(path, path, { destinationBucket: "documents" });
  if (copyErr && !/already exists|Duplicate/i.test(copyErr.message)) {
    failed++;
    console.error(`  FAIL  ${path}: copy: ${copyErr.message}`);
    continue;
  }
  const { error: rmErr } = await supabase.storage.from("media").remove([path]);
  if (rmErr) {
    failed++;
    console.error(`  FAIL  ${path}: copied but not removed from media: ${rmErr.message}`);
    continue;
  }
  moved++;
  console.log(`  moved ${path}`);
}
console.log(`moved ${moved}, skipped ${skipped}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
