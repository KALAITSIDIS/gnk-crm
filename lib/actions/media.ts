"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import {
  ACCEPTED_MIME,
  MAX_UPLOAD_BYTES,
  processPropertyImage,
  shouldWatermark,
} from "@/lib/services/media";
import { recomputeQualityScore } from "@/lib/services/quality-score";
import { binaryBody } from "@/lib/services/storage-upload";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type MediaActionState = { error: string | null; savedAt: number | null };

const WATERMARK_PATH = "branding/watermark.png"; // uploaded via Settings (T5.4)

export async function uploadPropertyMedia(
  _prev: MediaActionState,
  formData: FormData,
): Promise<MediaActionState> {
  const propertyId = formData.get("property_id");
  if (typeof propertyId !== "string") return { error: "Missing property", savedAt: null };

  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { error: "Pick at least one image", savedAt: null };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // RLS-checked read also proves the caller may touch this property
  const { data: property } = await supabase
    .from("properties")
    .select("id, org_id, visibility")
    .eq("id", propertyId)
    .maybeSingle();
  if (!property) return { error: "Property not found", savedAt: null };

  const admin = createAdminClient();

  // org watermark is optional until Settings ships it
  let watermark: Buffer | null = null;
  if (shouldWatermark(property.visibility)) {
    const { data: wmFile } = await admin.storage.from("media").download(WATERMARK_PATH);
    if (wmFile) watermark = Buffer.from(await wmFile.arrayBuffer());
  }

  const { data: existing } = await supabase
    .from("property_media")
    .select("id, sort_order, is_cover")
    .eq("property_id", propertyId);
  let nextSort = Math.max(-1, ...(existing ?? []).map((m) => m.sort_order)) + 1;
  let hasCover = (existing ?? []).some((m) => m.is_cover);

  for (const file of files) {
    if (!ACCEPTED_MIME.includes(file.type)) {
      return { error: `${file.name}: only JPEG/PNG/WebP accepted`, savedAt: null };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return { error: `${file.name}: exceeds 20 MB`, savedAt: null };
    }

    const input = Buffer.from(await file.arrayBuffer());
    let processed;
    try {
      processed = await processPropertyImage(input, { watermark });
    } catch {
      return { error: `${file.name}: unreadable image`, savedAt: null };
    }

    const id = randomUUID();
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const originalPath = `properties/${propertyId}/original/${id}.${ext}`;
    const renditionPath = (r: string) => `properties/${propertyId}/${id}_${r}.webp`;

    // original (with EXIF) → private documents bucket; renditions → public media bucket.
    // Bodies wrapped via binaryBody() so Vercel doesn't UTF-8-corrupt them (see helper).
    const uploads = [
      admin.storage
        .from("documents")
        .upload(originalPath, binaryBody(input, file.type), { contentType: file.type }),
      admin.storage
        .from("media")
        .upload(renditionPath("thumb"), binaryBody(processed.renditions.thumb, "image/webp"), {
          contentType: "image/webp",
        }),
      admin.storage
        .from("media")
        .upload(renditionPath("card"), binaryBody(processed.renditions.card, "image/webp"), {
          contentType: "image/webp",
        }),
      admin.storage
        .from("media")
        .upload(renditionPath("full"), binaryBody(processed.renditions.full, "image/webp"), {
          contentType: "image/webp",
        }),
    ];
    const results = await Promise.all(uploads);
    const failed = results.find((r) => r.error);
    if (failed?.error) return { error: `Upload failed: ${failed.error.message}`, savedAt: null };

    const { data: row, error: insertErr } = await supabase
      .from("property_media")
      .insert({
        org_id: property.org_id,
        property_id: propertyId,
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
        created_by: profile.id,
      })
      .select("id")
      .single();
    if (insertErr) return { error: insertErr.message, savedAt: null };
    hasCover = true;

    await logEvent(supabase, {
      orgId: property.org_id,
      actorId: profile.id,
      entityType: "property",
      entityId: propertyId,
      eventType: "media_uploaded",
      payload: { media_id: row.id, file: file.name, watermarked: processed.watermarked },
    });
  }

  await recomputeQualityScore(supabase, propertyId);
  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
  return { error: null, savedAt: Date.now() };
}

export async function setMediaCover(propertyId: string, mediaId: string): Promise<void> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { error: clearErr } = await supabase
    .from("property_media")
    .update({ is_cover: false })
    .eq("property_id", propertyId)
    .eq("is_cover", true);
  if (clearErr) throw new Error(clearErr.message);

  const { error } = await supabase
    .from("property_media")
    .update({ is_cover: true })
    .eq("id", mediaId);
  if (error) throw new Error(error.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "media_cover_set",
    payload: { media_id: mediaId },
  });
  await recomputeQualityScore(supabase, propertyId);
  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
}

export async function moveMedia(
  propertyId: string,
  mediaId: string,
  direction: "up" | "down",
): Promise<void> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: items } = await supabase
    .from("property_media")
    .select("id, sort_order")
    .eq("property_id", propertyId)
    .order("sort_order");
  if (!items) return;

  const index = items.findIndex((m) => m.id === mediaId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= items.length) return;

  const a = items[index];
  const b = items[swapWith];
  await supabase.from("property_media").update({ sort_order: b.sort_order }).eq("id", a.id);
  await supabase.from("property_media").update({ sort_order: a.sort_order }).eq("id", b.id);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "media_reordered",
    payload: { media_id: mediaId, direction },
  });
  revalidatePath(`/properties/${propertyId}`);
}

export async function deleteMedia(propertyId: string, mediaId: string): Promise<{ error: string | null }> {
  const { error } = await deleteMediaBulk(propertyId, [mediaId]);
  return { error };
}

/**
 * Delete one or more photos: rows first (RLS-checked, `.select()` returns only
 * what was actually deleted — so a permission-denied delete can't strand rows
 * pointing at removed files), then storage objects, cover promotion, events.
 */
export async function deleteMediaBulk(
  propertyId: string,
  mediaIds: string[],
): Promise<{ error: string | null; deleted: number }> {
  if (mediaIds.length === 0) return { error: null, deleted: 0 };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: deletedRows, error } = await supabase
    .from("property_media")
    .delete()
    .eq("property_id", propertyId)
    .in("id", mediaIds)
    .select("id, storage_path_original, path_thumb, path_card, path_full, is_cover");
  if (error) return { error: error.message, deleted: 0 };
  if (!deletedRows || deletedRows.length === 0) {
    return {
      error:
        "Nothing was deleted — the photos may already be gone, or your role can't delete photos (admin / listing manager only).",
      deleted: 0,
    };
  }

  const admin = createAdminClient();
  const mediaPaths = deletedRows
    .flatMap((m) => [m.path_thumb, m.path_card, m.path_full])
    .filter((p): p is string => Boolean(p));
  if (mediaPaths.length) await admin.storage.from("media").remove(mediaPaths);
  const originalPaths = deletedRows
    .map((m) => m.storage_path_original)
    .filter((p): p is string => Boolean(p));
  if (originalPaths.length) await admin.storage.from("documents").remove(originalPaths);

  // keep a cover: promote the first remaining photo if the cover was deleted
  if (deletedRows.some((m) => m.is_cover)) {
    const { data: rest } = await supabase
      .from("property_media")
      .select("id")
      .eq("property_id", propertyId)
      .order("sort_order")
      .limit(1);
    if (rest?.[0]) {
      await supabase.from("property_media").update({ is_cover: true }).eq("id", rest[0].id);
    }
  }

  // Recover each photo's original filename from its media_uploaded event —
  // property_media never stored it, and "Photo deleted" alone tells the
  // timeline reader nothing (audit 2026-07-16). Best-effort: a miss just
  // renders the bare line, as before.
  const { data: uploadEvents } = await supabase
    .from("events")
    .select("payload")
    .eq("entity_type", "property")
    .eq("entity_id", propertyId)
    .eq("event_type", "media_uploaded")
    .limit(1000);
  const fileByMedia = new Map<string, string>();
  for (const e of uploadEvents ?? []) {
    const p = e.payload as { media_id?: unknown; file?: unknown } | null;
    if (typeof p?.media_id === "string" && typeof p.file === "string") {
      fileByMedia.set(p.media_id, p.file);
    }
  }

  // one event per photo (guardrail 1) — the timeline keeps per-photo granularity
  for (const m of deletedRows) {
    const file = fileByMedia.get(m.id);
    await logEvent(supabase, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "property",
      entityId: propertyId,
      eventType: "media_deleted",
      payload: {
        media_id: m.id,
        ...(file ? { file } : {}),
        ...(deletedRows.length > 1 ? { bulk: true } : {}),
      },
    });
  }

  await recomputeQualityScore(supabase, propertyId);
  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
  return { error: null, deleted: deletedRows.length };
}
