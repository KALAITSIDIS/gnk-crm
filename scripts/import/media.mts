/**
 * Bulk photo importer (doc 09 `photo_folder`, audit 2026-08-29 REL-06).
 *
 *   node --env-file=.env.local scripts/import/media.mts --file properties.csv \
 *        [--media-root import-media] [--dry-run] [--append] [--org <uuid>]
 *
 * Reads the SAME properties.csv the row importer takes, and for every row
 * with a `photo_folder` value processes each image in
 * `<media-root>/<folder>/` through the app's REAL pipeline — the functions
 * every UI upload runs, imported relatively the way recompute-scores.mts
 * already imports quality-score.ts (their runtime imports are alias-free, so
 * node's type stripping runs them without a build step):
 *
 *   EXIF/GPS stripped, thumb/card/full WebP renditions, watermark on `full`
 *   for public/partner listings, original (with EXIF) into the PRIVATE
 *   documents bucket, renditions into the public media bucket, a
 *   property_media row per photo, one `media_uploaded` event per photo
 *   (actor null, source marked), quality score recomputed per property.
 *
 * WHY A SCRIPT AND NOT THE UI. Vercel rejects request bodies over ~4.5 MB
 * with 413 — MEASURED on production 2026-08-30 (3 MB → 200; 5/8/20 MB →
 * 413) — so camera originals cannot travel through the server action at
 * all, and a real portfolio at 5–15 photos per listing would be hours of
 * clicking besides. This script runs where the bytes already are and talks
 * to Storage directly; the 20 MB per-image cap is the pipeline's own.
 *
 * IDEMPOTENT BY DEFAULT: a property that already has photos is SKIPPED
 * (re-running an onboarding batch must not double every gallery). Pass
 * `--append` to add to existing galleries; files are ordered by natural
 * filename sort (photo2 before photo10), and the first imported photo
 * becomes the cover only when the property has none.
 *
 * Buffers are passed to storage-js directly: the UTF-8 corruption that
 * binaryBody() guards against is a Vercel-runtime behaviour — Node sends a
 * Buffer as-is (see lib/services/storage-upload.ts's own header).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
import {
  ACCEPTED_MIME,
  MAX_UPLOAD_BYTES,
  processPropertyImage,
  shouldWatermark,
} from "../../lib/services/media.ts";
import { recomputeQualityScore } from "../../lib/services/quality-score.ts";
import { Report, parseCsv, resolveOrg, serviceClient } from "./_shared.mts";

const { values: args } = nodeParseArgs({
  options: {
    file: { type: "string", short: "f" },
    "media-root": { type: "string", default: "import-media" },
    "dry-run": { type: "boolean", default: false },
    append: { type: "boolean", default: false },
    org: { type: "string" },
  },
});
if (!args.file) {
  console.error(
    "Usage: --file <properties.csv> [--media-root import-media] [--dry-run] [--append] [--org <uuid>]",
  );
  process.exit(1);
}
const dryRun = Boolean(args["dry-run"]);
const mediaRoot = resolve(String(args["media-root"]));
const report = new Report("media", String(args.file), dryRun);

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** photo2 before photo10 — plain lexicographic sort would interleave them. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

const supabase = serviceClient();
const orgId = await resolveOrg(supabase, args.org);
const WATERMARK_PATH = "branding/watermark.png"; // same fixed path the action uses

let watermarkCache: Buffer | null | undefined; // undefined = not fetched yet
async function orgWatermark(): Promise<Buffer | null> {
  if (watermarkCache !== undefined) return watermarkCache;
  const { data } = await supabase.storage.from("media").download(WATERMARK_PATH);
  watermarkCache = data ? Buffer.from(await data.arrayBuffer()) : null;
  return watermarkCache;
}

const csv = parseCsv(readFileSync(resolve(String(args.file)), "utf8"));
const withPhotos = csv
  .map((row, i) => ({ row, line: i + 2 })) // header is line 1, like the row importers
  .filter(({ row }) => (row.photo_folder ?? "").trim() !== "");

console.log(
  `${dryRun ? "[DRY RUN] " : ""}media import: ${withPhotos.length} of ${csv.length} CSV rows carry photo_folder; media root ${mediaRoot}`,
);

for (const { row, line } of withPhotos) {
  const reference = (row.reference ?? "").trim();
  const folder = row.photo_folder.trim();
  const dir = join(mediaRoot, folder);

  if (!reference) {
    report.add({ row: line, outcome: "error", detail: `photo_folder "${folder}" but no reference` });
    continue;
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    report.add({ row: line, outcome: "error", ref: reference, detail: `folder not found: ${dir}` });
    continue;
  }

  const files = readdirSync(dir)
    .filter((f) => MIME_BY_EXT[extname(f).toLowerCase()])
    .sort(naturalCompare);
  if (files.length === 0) {
    report.add({ row: line, outcome: "skipped", ref: reference, detail: `no images in ${dir}` });
    continue;
  }

  const { data: property, error: propErr } = await supabase
    .from("properties")
    .select("id, org_id, visibility")
    .eq("org_id", orgId)
    .eq("reference", reference)
    .maybeSingle();
  if (propErr || !property) {
    report.add({ row: line, outcome: "error", ref: reference, detail: "property not found — import rows first" });
    continue;
  }

  const { data: existing, error: exErr } = await supabase
    .from("property_media")
    .select("id, sort_order, is_cover")
    .eq("property_id", property.id);
  if (exErr) {
    report.add({ row: line, outcome: "error", ref: reference, detail: exErr.message });
    continue;
  }
  if ((existing ?? []).length > 0 && !args.append) {
    report.add({
      row: line,
      outcome: "skipped",
      ref: reference,
      detail: `already has ${existing!.length} photo(s) — pass --append to add (idempotent re-run guard)`,
    });
    continue;
  }

  if (dryRun) {
    report.add({
      row: line,
      outcome: "created",
      ref: reference,
      detail: `WOULD import ${files.length} photo(s) from ${folder}/ (${files.join(", ")})`,
    });
    continue;
  }

  let nextSort = Math.max(-1, ...(existing ?? []).map((m) => m.sort_order)) + 1;
  let hasCover = (existing ?? []).some((m) => m.is_cover);
  const watermark = shouldWatermark(property.visibility) ? await orgWatermark() : null;
  let imported = 0;
  let failed: string | null = null;

  for (const name of files) {
    const full = join(dir, name);
    const input = readFileSync(full);
    const mime = MIME_BY_EXT[extname(name).toLowerCase()];
    if (!ACCEPTED_MIME.includes(mime)) {
      failed = `${name}: unsupported type`;
      break;
    }
    if (input.length > MAX_UPLOAD_BYTES) {
      failed = `${name}: ${(input.length / 1024 / 1024).toFixed(1)} MB exceeds the 20 MB pipeline cap`;
      break;
    }

    let processed;
    try {
      processed = await processPropertyImage(input, { watermark });
    } catch {
      failed = `${name}: unreadable image`;
      break;
    }

    const id = randomUUID();
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const originalPath = `properties/${property.id}/original/${id}.${ext}`;
    const renditionPath = (r: string) => `properties/${property.id}/${id}_${r}.webp`;

    const uploads = await Promise.all([
      supabase.storage.from("documents").upload(originalPath, input, { contentType: mime }),
      supabase.storage
        .from("media")
        .upload(renditionPath("thumb"), processed.renditions.thumb, { contentType: "image/webp" }),
      supabase.storage
        .from("media")
        .upload(renditionPath("card"), processed.renditions.card, { contentType: "image/webp" }),
      supabase.storage
        .from("media")
        .upload(renditionPath("full"), processed.renditions.full, { contentType: "image/webp" }),
    ]);
    const uploadErr = uploads.find((r) => r.error)?.error;
    if (uploadErr) {
      failed = `${name}: upload failed — ${uploadErr.message}`;
      break;
    }

    const { data: mediaRow, error: insertErr } = await supabase
      .from("property_media")
      .insert({
        org_id: property.org_id,
        property_id: property.id,
        kind: "photo",
        storage_path_original: originalPath,
        path_thumb: renditionPath("thumb"),
        path_card: renditionPath("card"),
        path_full: renditionPath("full"),
        width: processed.width,
        height: processed.height,
        sort_order: nextSort++,
        is_cover: !hasCover,
        watermarked: processed.watermarked,
        exif_stripped: true,
        created_by: null,
      })
      .select("id")
      .single();
    if (insertErr) {
      // don't strand the uploaded files — mirror the action's cleanup
      await supabase.storage
        .from("media")
        .remove([renditionPath("thumb"), renditionPath("card"), renditionPath("full")]);
      await supabase.storage.from("documents").remove([originalPath]);
      failed = `${name}: ${insertErr.message}`;
      break;
    }
    hasCover = true;
    imported++;

    const { error: eventErr } = await supabase.from("events").insert({
      org_id: property.org_id,
      actor_id: null, // service-role import — bypasses the 0071 self-attribution policy by role, like the sweeps
      entity_type: "property",
      entity_id: property.id,
      event_type: "media_uploaded",
      payload: { media_id: mediaRow.id, file: name, watermarked: processed.watermarked, source: "import_script" },
    });
    if (eventErr) {
      failed = `${name}: photo stored but its event failed — ${eventErr.message}`;
      break;
    }
  }

  if (imported > 0) {
    // the same recompute every UI save runs — photos are 15+ of the score
    await recomputeQualityScore(supabase as Parameters<typeof recomputeQualityScore>[0], property.id);
  }

  if (failed) {
    report.add({
      row: line,
      outcome: "error",
      ref: reference,
      detail: `${imported}/${files.length} imported, then: ${failed}`,
    });
  } else {
    report.add({
      row: line,
      outcome: "created",
      ref: reference,
      detail: `${imported} photo(s) from ${folder}/${hasCover && imported > 0 && (existing ?? []).length === 0 ? " (first is cover)" : ""}`,
    });
  }
}

const reportPath = report.finish();
void reportPath;
