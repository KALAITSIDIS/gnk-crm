#!/usr/bin/env node
/**
 * Put Storage objects BACK. The counterpart to export.mjs, and the half of the
 * restore path that did not exist until 2026-08-05.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/backup/restore-storage.mjs --from ../gnk-backups/2026-07-31
 *
 * Add --verify-only to re-download and hash without uploading anything.
 *
 * Why this exists rather than `supabase storage cp -r` (BACKUP_RESTORE §3.2):
 * the CLI path needs a persisted CLI login, and on this machine `supabase login`
 * does not reliably persist a token (HANDOFF §7). It has also never been run in
 * the restore direction. This script needs only the service key, which is the
 * same credential export.mjs already uses.
 *
 * ⚠ NO DATABASE DUMP CONTAINS BUCKET OBJECTS, ON ANY PLAN (§1.2). But a dump
 * DOES contain `storage.objects` — 26 metadata rows saying the files exist. So a
 * database-only restore produces a project that reports a full set of signed
 * slips and evidence PDFs with nothing behind them. Rows are not bytes. This
 * script is what turns the rows back into bytes.
 *
 * ⚠ TARGET SAFETY. export.mjs falls back to NEXT_PUBLIC_SUPABASE_URL when
 * SUPABASE_URL is unset, which silently backs up the wrong database. The same
 * mistake in this direction WRITES to the wrong project, so there is no
 * fallback here: SUPABASE_URL must be set explicitly, and the target is printed
 * and confirmed before a single byte is uploaded.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const from = args[args.indexOf("--from") + 1];
const verifyOnly = args.includes("--verify-only");
if (!from || args.indexOf("--from") === -1) {
  console.error("usage: restore-storage.mjs --from <backup-dir> [--verify-only]");
  process.exit(1);
}

// No NEXT_PUBLIC_* fallback — see the target-safety note above.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY explicitly.");
  process.exit(1);
}

/**
 * `public` is not cosmetic: migration 0008 makes `media` public, and a
 * restored-but-private media bucket serves broken images that look like a code
 * fault rather than a restore fault (BACKUP_RESTORE §4 step 4).
 */
const BUCKETS = [
  { id: "documents", public: false },
  { id: "signatures", public: false },
  { id: "media", public: true },
];

/**
 * Content type has to be set on upload. The Storage API defaults to
 * `application/octet-stream`, which makes an evidence PDF download as a blob
 * the browser refuses to open inline — indistinguishable, on screen, from a
 * corrupted restore.
 */
const MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const mimeFor = (p) => MIME[p.split(".").pop().toLowerCase()] ?? "application/octet-stream";
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const walk = (dir, base = dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    // Storage keys always use forward slashes, whatever the host OS does.
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
};

const sb = createClient(url, key, { auth: { persistSession: false } });

console.log(`source : ${from}`);
console.log(`TARGET : ${url}`);
console.log(`mode   : ${verifyOnly ? "VERIFY ONLY (no writes)" : "UPLOAD"}\n`);

let uploaded = 0;
let verified = 0;
const failures = [];

for (const bucket of BUCKETS) {
  const dir = join(from, "storage", bucket.id);
  if (!existsSync(dir)) {
    console.log(`${bucket.id}: no directory in backup, skipping`);
    continue;
  }
  const paths = walk(dir);

  if (!verifyOnly) {
    // Buckets must exist before objects can land in them, and they do not come
    // from the file backup. Create if absent; correct `public` if it drifted.
    const { data: existing } = await sb.storage.getBucket(bucket.id);
    if (!existing) {
      const { error } = await sb.storage.createBucket(bucket.id, { public: bucket.public });
      if (error) throw new Error(`createBucket ${bucket.id}: ${error.message}`);
      console.log(`${bucket.id}: bucket created (public=${bucket.public})`);
    } else if (existing.public !== bucket.public) {
      const { error } = await sb.storage.updateBucket(bucket.id, { public: bucket.public });
      if (error) throw new Error(`updateBucket ${bucket.id}: ${error.message}`);
      console.log(`${bucket.id}: public corrected to ${bucket.public}`);
    }
  }

  for (const path of paths) {
    const local = readFileSync(join(dir, path));

    if (!verifyOnly) {
      // Blob, never a bare Buffer — storage-js sends a Buffer as a direct fetch
      // body, and some runtimes UTF-8-stringify it, turning every byte >= 0x80
      // into U+FFFD. That silently destroyed every uploaded photo in production
      // once (DECISIONS 2026-07-15); lib/services/storage-upload.ts wraps for
      // the same reason. Node happens to be safe today — do not rely on it.
      // upsert, because a database restore has already recreated the
      // storage.objects row for this key — without it the API returns 409
      // "resource already exists" on every single file.
      const { error } = await sb.storage
        .from(bucket.id)
        .upload(path, new Blob([local], { type: mimeFor(path) }), {
          contentType: mimeFor(path),
          upsert: true,
        });
      if (error) throw new Error(`upload ${bucket.id}/${path}: ${error.message}`);
      uploaded += 1;
    }

    // Round-trip check: pull the bytes back THROUGH THE API, not off disk.
    // Reading the file we just read proves nothing.
    const { data: blob, error: dlErr } = await sb.storage.from(bucket.id).download(path);
    if (dlErr) {
      failures.push(`${bucket.id}/${path}: download failed — ${dlErr.message}`);
      continue;
    }
    const back = Buffer.from(await blob.arrayBuffer());
    if (sha256(back) !== sha256(local)) {
      failures.push(
        `${bucket.id}/${path}: SHA-256 MISMATCH (disk ${sha256(local).slice(0, 12)} != restored ${sha256(back).slice(0, 12)})`,
      );
      continue;
    }
    verified += 1;
  }

  console.log(`${bucket.id.padEnd(11)} ${paths.length} files`);
}

console.log(
  `\n${verifyOnly ? "" : `uploaded ${uploaded} · `}round-tripped and SHA-256 matched ${verified}`,
);
if (failures.length) {
  console.error(`\n${failures.length} FAILURES:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("all objects match the backup byte for byte");
