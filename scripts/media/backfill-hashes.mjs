#!/usr/bin/env node
/**
 * Fill `property_media.content_sha256` for rows uploaded before 0088, from the
 * ORIGINAL bytes in the private `documents` bucket (the same bytes the upload
 * now hashes at the moment they arrive).
 *
 * DRY RUN BY DEFAULT — prints what it would set. Pass --apply to write.
 * Idempotent: only rows whose hash is null are touched; a row whose original
 * is missing from storage is reported and skipped, never guessed.
 *
 *   node --env-file=.env.local scripts/media/backfill-hashes.mjs
 *   node --env-file=.env.local scripts/media/backfill-hashes.mjs --apply
 *   node --env-file=<the operator's secret file> scripts/media/backfill-hashes.mjs --apply   # hosted
 *
 * Reads SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.
 * Never prints either. Writes ONLY the derived column — no event, because a
 * hash is a fact about bytes that already exist, not a change anyone made.
 */
import { createHash } from "node:crypto";
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
  .select("id, property_id, kind, storage_path_original")
  .is("content_sha256", null)
  .order("id");
if (error) {
  console.error("could not list property_media:", error.message);
  process.exit(1);
}
console.log(`${rows.length} row(s) without a hash${apply ? "" : " — DRY RUN, pass --apply to write"}`);

let set = 0, skipped = 0, failed = 0;
for (const row of rows) {
  if (!row.storage_path_original) {
    skipped++;
    console.log(`  skip  ${row.id}: no original recorded`);
    continue;
  }
  const { data: blob, error: dlErr } = await supabase.storage
    .from("documents")
    .download(row.storage_path_original);
  if (dlErr || !blob) {
    skipped++;
    console.log(`  skip  ${row.id}: original not downloadable (${dlErr?.message ?? "empty"})`);
    continue;
  }
  const sha = createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex");
  if (!apply) {
    console.log(`  would set  ${row.id} (${row.kind}) ${sha.slice(0, 12)}…`);
    continue;
  }
  const { error: upErr } = await supabase
    .from("property_media")
    .update({ content_sha256: sha })
    .eq("id", row.id)
    .is("content_sha256", null);
  if (upErr) {
    failed++;
    console.error(`  FAIL  ${row.id}: ${upErr.message}`);
    continue;
  }
  set++;
  console.log(`  set   ${row.id} (${row.kind}) ${sha.slice(0, 12)}…`);
}
console.log(`set ${set}, skipped ${skipped}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
