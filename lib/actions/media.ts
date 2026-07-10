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

    // original (with EXIF) → private documents bucket; renditions → public media bucket
    const uploads = [
      admin.storage.from("documents").upload(originalPath, input, { contentType: file.type }),
      admin.storage
        .from("media")
        .upload(renditionPath("thumb"), processed.renditions.thumb, { contentType: "image/webp" }),
      admin.storage
        .from("media")
        .upload(renditionPath("card"), processed.renditions.card, { contentType: "image/webp" }),
      admin.storage
        .from("media")
        .upload(renditionPath("full"), processed.renditions.full, { contentType: "image/webp" }),
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

export async function deleteMedia(propertyId: string, mediaId: string): Promise<void> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: media } = await supabase
    .from("property_media")
    .select("id, storage_path_original, path_thumb, path_card, path_full, is_cover")
    .eq("id", mediaId)
    .maybeSingle();
  if (!media) return;

  const { error } = await supabase.from("property_media").delete().eq("id", mediaId);
  if (error) throw new Error(error.message);

  const admin = createAdminClient();
  const mediaPaths = [media.path_thumb, media.path_card, media.path_full].filter(
    (p): p is string => Boolean(p),
  );
  if (mediaPaths.length) await admin.storage.from("media").remove(mediaPaths);
  if (media.storage_path_original) {
    await admin.storage.from("documents").remove([media.storage_path_original]);
  }

  // keep a cover: promote the first remaining photo if the cover was deleted
  if (media.is_cover) {
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

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "media_deleted",
    payload: { media_id: mediaId },
  });
  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
}
