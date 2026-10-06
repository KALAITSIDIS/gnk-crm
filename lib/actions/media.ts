"use server";

import { removeObjectsBestEffort } from "@/lib/services/storage";
import { mediaBucketFor } from "@/lib/services/media-bucket";
import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile, type CurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { notifySiteIfPublic } from "@/lib/services/site-revalidate";
import {
  ACCEPTED_MIME,
  MAX_UPLOAD_BYTES,
  processPropertyImage,
  RENDITIONS,
  renditionExt,
  renditionMime,
  shouldWatermark,
  type RenditionName,
} from "@/lib/services/media";
import {
  discardAttemptObjects,
  insertDefinitelyRefused,
  mayInsertPropertyMedia,
  putAttemptObjects,
  reportMediaUpload,
  type AttemptObject,
} from "@/lib/services/media-upload";
import { recomputeQualityScore, recomputeQuietly } from "@/lib/services/quality-score";
import { UPLOADABLE_MEDIA_KINDS } from "@/lib/validators/media";
import { binaryBody } from "@/lib/services/storage-upload";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type MediaActionState = {
  error: string | null;
  savedAt: number | null;
  /** files this request committed — an error can follow earlier saved files */
  saved?: number;
  /** a SAVED upload whose follow-up (its timeline line) did not complete */
  warning?: string | null;
};

const WATERMARK_PATH = "branding/watermark.png"; // uploaded via Settings (T5.4)

const NOT_ALLOWED = "Upload not allowed — this property isn't assigned to you.";

/**
 * Upload photographs or floor plans to one listing (DECISIONS
 * T-media-upload-authz for the order and the failure semantics).
 *
 * 1. EVERYTHING IS CHECKED BEFORE ANYTHING PRIVILEGED RUNS: the input, every
 *    file in the batch, the caller (getCurrentProfile reads the profile
 *    through RLS, so an unauthenticated, aal1 or deactivated session has no
 *    profile), and the caller's right to ADD media to THIS listing —
 *    `mayInsertPropertyMedia`, the insert policy said in the application. A
 *    property READ is not that right: every member of the organisation can
 *    read every listing. A check that cannot be answered refuses.
 * 2. Only then the service role: the watermark, the pipeline, the uploads.
 * 3. The row is inserted on the caller's SESSION, so RLS still has the last
 *    word — a reassignment or deactivation since step 1 is refused there.
 * 4. An attempt that does not commit is compensated: every object it may have
 *    written is removed once every upload has settled, and a removal that
 *    cannot be verified is reported, not claimed. An insert whose answer was
 *    LOST is read back; unless the row is found, the files are kept and the
 *    outcome is reported as unknown — a committed row is never left pointing
 *    at deleted files.
 * 5. After a commit, nothing turns the upload into a failure: the event, the
 *    score and the site knock are follow-ups.
 *
 * The media tab sends one file per request (REL-05). A direct call may send
 * several: they are processed in order, and a failure stops the batch with a
 * result that says how many were saved — those stay.
 */
export async function uploadPropertyMedia(
  _prev: MediaActionState,
  formData: FormData,
): Promise<MediaActionState> {
  const propertyId = formData.get("property_id");
  if (typeof propertyId !== "string" || !z.guid().safeParse(propertyId).success) {
    return { error: "Missing property", savedAt: null };
  }

  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  // MEDIA-K (2026-09-02): the upload names its kind; junk falls back to
  // photo rather than erroring (the property-documents idiom — a form can
  // post anything). Only raster-uploadable kinds are offered.
  const rawKind = String(formData.get("kind") ?? "photo");
  const kind = (UPLOADABLE_MEDIA_KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as (typeof UPLOADABLE_MEDIA_KINDS)[number])
    : "photo";
  if (files.length === 0) return { error: "Pick at least one image", savedAt: null };
  // the whole batch, before a byte is processed or stored
  for (const file of files) {
    if (!ACCEPTED_MIME.includes(file.type)) {
      return { error: `${file.name}: only JPEG/PNG/WebP accepted`, savedAt: null };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return { error: `${file.name}: exceeds 20 MB`, savedAt: null };
    }
  }

  const supabase = await createClient();
  let profile: CurrentProfile;
  try {
    profile = await getCurrentProfile(supabase);
  } catch {
    // signed out, aal1 (require_aal2 hides the profile) or deactivated
    return { error: "Sign in again (with your second factor) to upload.", savedAt: null };
  }

  const { data: property, error: propertyErr } = await supabase
    .from("properties")
    .select("id, org_id, visibility, assigned_agent_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (propertyErr) {
    return { error: "Could not check your permission for this property — nothing was uploaded.", savedAt: null };
  }
  if (!property) return { error: "Property not found", savedAt: null };
  if (!mayInsertPropertyMedia(profile, property)) return { error: NOT_ALLOWED, savedAt: null };

  const { data: existing, error: galleryErr } = await supabase
    .from("property_media")
    .select("id, sort_order, is_cover")
    .eq("property_id", propertyId);
  // an unread gallery would number from 0 and crown a second cover
  if (galleryErr) {
    return { error: "Could not read this property's gallery — nothing was uploaded.", savedAt: null };
  }
  let nextSort = Math.max(-1, ...(existing ?? []).map((m) => m.sort_order)) + 1;
  let hasCover = (existing ?? []).some((m) => m.is_cover);

  // ---- privileged work starts here, for an authorised caller only ----
  const admin = createAdminClient();

  // org watermark is optional until Settings ships it
  let watermark: Buffer | null = null;
  // floor plans skip the watermark: they never reach the feed or a share
  // link (kind='photo' filters, RLS test 49), and a watermark across plan
  // lines destroys the one thing a plan is for
  if (kind === "photo" && shouldWatermark(property.visibility)) {
    const { data: wmFile } = await admin.storage.from("media").download(WATERMARK_PATH);
    if (wmFile) watermark = Buffer.from(await wmFile.arrayBuffer());
  }

  let saved = 0;
  let warning: string | null = null;
  let failure: string | null = null;

  for (const file of files) {
    const input = Buffer.from(await file.arrayBuffer());
    let processed;
    try {
      processed = await processPropertyImage(input, { watermark });
    } catch {
      failure = `${file.name}: unreadable image`;
      break;
    }

    // ONE id per attempt: it names every object the attempt writes AND the
    // row it inserts, so an object without a row is recognisable as one
    const attemptId = randomUUID();
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const originalPath = `properties/${property.id}/original/${attemptId}.${ext}`;
    const renditionPath = (r: RenditionName) =>
      `properties/${property.id}/${attemptId}_${r}.${renditionExt(r)}`;

    // original (with EXIF) → private documents bucket, always. Renditions →
    // the bucket the KIND decides (media-bucket.ts): public for a photograph,
    // private for a floor plan, which until 2026-09-06 sat in the public
    // bucket under a guessable path (A07). Bodies wrapped via binaryBody() so
    // Vercel doesn't UTF-8-corrupt them (see helper).
    const renditionBucket = mediaBucketFor(kind);
    // ...and only a PHOTOGRAPH gets the portal JPEG: every other kind's
    // renditions live in the private bucket, where nothing — no portal feed,
    // no public page — ever reads one.
    const stored = RENDITIONS.filter((r) => r.name !== "jpeg" || kind === "photo");
    const objects: AttemptObject[] = [
      { bucket: "documents", path: originalPath, body: binaryBody(input, file.type), contentType: file.type },
      ...stored.map(({ name }) => ({
        bucket: renditionBucket,
        path: renditionPath(name),
        body: binaryBody(processed.renditions[name], renditionMime(name)),
        contentType: renditionMime(name),
      })),
    ];
    const context = { propertyId: property.id, attemptId };

    const put = await putAttemptObjects(admin.storage, objects);
    if (put.failed.length > 0) {
      const removed = await discardAttemptObjects(admin.storage, objects, put.foreign, {
        ...context,
        why: "upload failed",
      });
      failure =
        `${file.name}: Upload failed: ${put.failed[0].reason}` +
        (removed ? "" : " — some of its files could not be removed and have been reported");
      break;
    }

    // 0088: the ORIGINAL bytes, so "this photograph is already on <reference>"
    // is a fact the worklist can state (a warning, never a score change — a
    // development's units share exteriors). The upload event carries it too.
    const contentSha256 = createHash("sha256").update(input).digest("hex");

    const { data: row, error: insertErr } = await supabase
      .from("property_media")
      .insert({
        id: attemptId,
        org_id: property.org_id,
        property_id: property.id,
        kind,
        storage_path_original: originalPath,
        path_thumb: renditionPath("thumb"),
        path_card: renditionPath("card"),
        path_full: renditionPath("full"),
        // 0095: the portal feed's own copy — portal_supplement() returns only
        // photos that have one, and only a photo has one at all
        path_jpeg: kind === "photo" ? renditionPath("jpeg") : null,
        width: processed.width,
        height: processed.height,
        content_sha256: contentSha256,
        sort_order: nextSort,
        // only photos are cover-eligible: a floor-plan cover would score the
        // 5 cover points while the feed (photos-only) shows no cover at all
        is_cover: kind === "photo" && !hasCover,
        watermarked: processed.watermarked,
        exif_stripped: true,
        created_by: profile.id,
      })
      .select("id")
      .single();

    let mediaId = row?.id ?? null;
    if (insertErr && insertDefinitelyRefused(insertErr)) {
      // the database ran the insert and refused it (RLS, a constraint): no
      // row can reference these objects
      const removed = await discardAttemptObjects(admin.storage, objects, put.foreign, {
        ...context,
        why: "row refused",
      });
      const why =
        insertErr.code === "42501" || insertErr.message.includes("row-level security")
          ? NOT_ALLOWED
          : insertErr.message;
      failure =
        `${file.name}: ${why}` +
        (removed ? "" : " Some of its files could not be removed and have been reported.");
      break;
    }
    if (insertErr) {
      // The answer was lost: the row may have committed. Ask the database.
      const { data: found, error: readErr } = await supabase
        .from("property_media")
        .select("id")
        .eq("id", attemptId)
        .maybeSingle();
      if (readErr || !found) {
        // Not found is not proof either — the insert may still be landing.
        // Keep the files (a committed row must never point at deleted ones)
        // and say so; the attempt id finds them if they turn out orphaned.
        reportMediaUpload("[media upload] row outcome unknown — files kept", "insert_unknown", {
          ...context,
          paths: objects.map((o) => `${o.bucket}/${o.path}`),
          readBack: readErr ? "failed" : "absent",
        });
        failure = `${file.name}: could not confirm whether it was saved — refresh the page before uploading it again.`;
        break;
      }
      mediaId = found.id;
    }

    // ---- committed: from here on, nothing un-saves this file ----
    saved++;
    nextSort++;
    if (kind === "photo") hasCover = true;

    try {
      await logEvent(supabase, {
        orgId: property.org_id,
        actorId: profile.id,
        entityType: "property",
        entityId: property.id,
        eventType: "media_uploaded",
        // No file name: it is whatever the uploader's machine called the file
        // ("Andreou villa front.jpg"), and the chain is beyond erasure (SEC-03).
        // The id names the photo; the digest of its bytes says WHICH image it
        // was, and outlives the row — the row never stored the name at all.
        payload: { media_id: mediaId ?? attemptId, kind, watermarked: processed.watermarked, content_sha256: contentSha256 },
      });
    } catch {
      reportMediaUpload("[media upload] saved, but its media_uploaded event was not written", "event", {
        ...context,
      });
      warning = "Saved, but its timeline entry could not be written — this has been reported.";
    }
  }

  if (saved > 0) {
    await recomputeQuietly(supabase, property.id);
    await notifySiteIfPublic(supabase, property.id);
    revalidatePath(`/properties/${property.id}`);
    revalidatePath("/properties");
  }
  if (failure) {
    return {
      error: saved > 0 ? `${saved} of ${files.length} saved, then ${failure}` : failure,
      savedAt: saved > 0 ? Date.now() : null,
      saved,
      warning,
    };
  }
  return { error: null, savedAt: Date.now(), saved, warning };
}

/** Result object, not throw — thrown server-action messages are stripped in
 * prod, and RLS filters a denied update to 0 rows with no error at all. */
export async function setMediaCover(
  propertyId: string,
  mediaId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // set the new cover first (with row-count proof), clear the old one after —
  // a denied call must not leave the property coverless. kind='photo' in the
  // predicate: only photos are cover-eligible (MEDIA-K) — enforced HERE, not
  // in the UI, because a form can post any media id
  const { data: setRows, error } = await supabase
    .from("property_media")
    .update({ is_cover: true })
    .eq("id", mediaId)
    .eq("property_id", propertyId)
    .eq("kind", "photo")
    .select("id");
  if (error) return { error: error.message };
  if (!setRows || setRows.length === 0) {
    return { error: "Cover not changed — only admins and listing managers manage photos." };
  }

  const { error: clearErr } = await supabase
    .from("property_media")
    .update({ is_cover: false })
    .eq("property_id", propertyId)
    .eq("is_cover", true)
    .neq("id", mediaId);
  if (clearErr) return { error: clearErr.message };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "media_cover_set",
    payload: { media_id: mediaId },
  });
  await recomputeQualityScore(supabase, propertyId);
  await notifySiteIfPublic(supabase, propertyId);
  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
  return { error: null };
}

/**
 * The description a screen reader, and a search engine, actually reads.
 *
 * WHY THIS DID NOT EXIST. `property_media.alt` has been in the schema since
 * migration 0001, the public feed exposes it, and the marketing site reads it
 * with `text(img.alt)` and falls back to the listing title. Every layer was
 * built except the one that writes it — so on 2026-09-05 all eighteen published
 * photographs carried `alt: {}`, not because nobody filled them in but because
 * nothing could.
 *
 * MULTILANG, like every other public string here. The column is jsonb and the
 * site's `text()` prefers `en`, so English is what is written; el and ru follow
 * the same shape when they land, and an existing translation is preserved
 * rather than overwritten by an English-only edit.
 *
 * Empty DELETES the key rather than storing "". Not for the site's sake — its
 * `text()` trims before testing, so a blank string falls through to el, then ru,
 * then the title exactly as an absent one does. It is so that `{}` stays the
 * single meaning of "no description": anything that ever asks whether a
 * photograph HAS one — a coverage count, a translation pass, the jsonb key test
 * — gets one answer instead of two that look different and mean the same.
 *
 * A cleared alt is a real change to what the feed publishes, and since
 * T-etag-from-body (2026-09-06) it CANNOT be missed: the feed's validator is
 * sha256 of the bytes the route sends, so any change to what the feed says
 * moves it whether or not a SQL-side hash saw it coming.
 *
 * The history is still worth carrying, because it is why the validator moved
 * home. `public_listings_etag` — now only the SNAPSHOT segment, the name
 * gnk-web compares across pages — hashed a photo's id, sort order and cover
 * flag, and 0086 folded alt in after this action gave alt its first write path
 * and 0085 put it in the feed body. This is one of two media paths that do NOT
 * recompute the quality score (which is what incidentally touches
 * `properties.updated_at` for upload, set-cover and delete); the other is
 * moveMedia, whose sort_order was already in the fingerprint — so before 0086
 * an edit here was the only media change that hash could not see. 0086's own
 * header says "the ONE"; that is the overstatement, and it stays because an
 * applied migration is never rewritten.
 */
export async function setMediaAlt(
  propertyId: string,
  mediaId: string,
  alt: string,
): Promise<{ error: string | null }> {
  const trimmed = alt.trim();
  if (trimmed.length > 300) {
    return { error: "Keep it under 300 characters — it is read aloud, not published as copy." };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // Read the existing value so another language is not lost by an English edit.
  const { data: current, error: readErr } = await supabase
    .from("property_media")
    .select("alt")
    .eq("id", mediaId)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (readErr) return { error: readErr.message };
  if (!current) return { error: "That photograph is not on this property." };

  const existing = (current.alt ?? {}) as Record<string, string>;
  const next = { ...existing };
  if (trimmed) next.en = trimmed;
  else delete next.en;

  // Row-count proof rather than trusting the update: RLS decides whether this
  // profile may write, and a silent zero-row update would look like success.
  const { data: rows, error } = await supabase
    .from("property_media")
    .update({ alt: next })
    .eq("id", mediaId)
    .eq("property_id", propertyId)
    .select("id");
  if (error) return { error: error.message };
  if (!rows || rows.length === 0) {
    return { error: "Not saved — only admins and listing managers manage photos." };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "media_alt_set",
    // the text itself, so the timeline shows what was written without a join
    payload: { media_id: mediaId, alt: trimmed || null },
  });
  await notifySiteIfPublic(supabase, propertyId);
  revalidatePath(`/properties/${propertyId}`);
  return { error: null };
}

export async function moveMedia(
  propertyId: string,
  mediaId: string,
  direction: "up" | "down",
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: items, error: listErr } = await supabase
    .from("property_media")
    .select("id, sort_order")
    .eq("property_id", propertyId)
    .order("sort_order");
  if (listErr) return { error: listErr.message };

  const index = (items ?? []).findIndex((m) => m.id === mediaId);
  if (index < 0) return { error: "Photo not found" };
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= items!.length) return { error: null }; // already at the edge

  const a = items![index];
  const b = items![swapWith];
  const { data: aRows, error: aErr } = await supabase
    .from("property_media")
    .update({ sort_order: b.sort_order })
    .eq("id", a.id)
    .select("id");
  if (aErr) return { error: aErr.message };
  if (!aRows || aRows.length === 0) {
    return { error: "Order not changed — only admins and listing managers manage photos." };
  }
  const { data: bRows, error: bErr } = await supabase
    .from("property_media")
    .update({ sort_order: a.sort_order })
    .eq("id", b.id)
    .select("id");
  if (bErr || !bRows || bRows.length === 0) {
    // half-swapped (the other photo vanished mid-flight) — restore a's slot
    await supabase.from("property_media").update({ sort_order: a.sort_order }).eq("id", a.id);
    return { error: bErr?.message ?? "Order not changed — the other photo no longer exists." };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "media_reordered",
    payload: { media_id: mediaId, direction },
  });
  await notifySiteIfPublic(supabase, propertyId);
  revalidatePath(`/properties/${propertyId}`);
  return { error: null };
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
    .select("id, kind, storage_path_original, path_thumb, path_card, path_full, path_jpeg, is_cover, content_sha256");
  if (error) return { error: error.message, deleted: 0 };
  if (!deletedRows || deletedRows.length === 0) {
    return {
      error:
        "Nothing was deleted — the photos may already be gone, or your role can't delete photos (admin / listing manager only).",
      deleted: 0,
    };
  }

  const admin = createAdminClient();
  // Renditions live in the bucket their KIND decides (media-bucket.ts), so a
  // mixed delete removes from each bucket what it holds.
  for (const bucket of ["media", "documents"] as const) {
    const paths = deletedRows
      .filter((m) => mediaBucketFor(m.kind) === bucket)
      .flatMap((m) => [m.path_thumb, m.path_card, m.path_full, m.path_jpeg])
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      await removeObjectsBestEffort(admin.storage, bucket, paths, "media bulk delete: renditions");
    }
  }
  const originalPaths = deletedRows
    .map((m) => m.storage_path_original)
    .filter((p): p is string => Boolean(p));
  await removeObjectsBestEffort(admin.storage, "documents", originalPaths, "media bulk delete: originals");

  // keep a cover: promote the first remaining PHOTO if the cover was deleted
  // (MEDIA-K: a floor plan must never become the cover — see the upload path)
  if (deletedRows.some((m) => m.is_cover)) {
    const { data: rest } = await supabase
      .from("property_media")
      .select("id")
      .eq("property_id", propertyId)
      .eq("kind", "photo")
      .order("sort_order")
      .limit(1);
    if (rest?.[0]) {
      await supabase.from("property_media").update({ is_cover: true }).eq("id", rest[0].id);
    }
  }

  // One event per photo (guardrail 1) — the timeline keeps per-photo
  // granularity. The photo is named by its id and the digest of its bytes,
  // taken from the ROW the delete just returned. Until T-media-file-name-shape
  // this read the photo's file name back out of its `media_uploaded` event with
  // the admin client and copied it forward — typed text the chain fed itself
  // (SEC-03). Nothing is looked up now, so nothing depends on who is deleting.
  for (const m of deletedRows) {
    await logEvent(supabase, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "property",
      entityId: propertyId,
      eventType: "media_deleted",
      payload: {
        media_id: m.id,
        // an imported photo whose digest was never backfilled has none to give
        ...(m.content_sha256 ? { content_sha256: m.content_sha256 } : {}),
        ...(deletedRows.length > 1 ? { bulk: true } : {}),
      },
    });
  }

  await recomputeQualityScore(supabase, propertyId);
  await notifySiteIfPublic(supabase, propertyId);
  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
  return { error: null, deleted: deletedRows.length };
}
