/**
 * Client-side image downscaling before upload (audit 2026-08-29 REL-05).
 *
 * MEASURED, NOT ASSUMED (2026-08-30, production probes): Vercel rejects
 * request bodies over ~4.5 MB with a platform 413 before any app code runs —
 * 3 MB → 200, 5/8/20 MB → 413. Camera originals commonly run 3–8 MB, so the
 * server action's 20 MB promise was undeliverable and the first real photo
 * upload would have failed with an opaque 413 that looks like a code fault.
 * The budget every upload is held to lives in lib/constants/upload.ts
 * (UPLOAD_REQUEST_BUDGET_BYTES), shared with the document forms.
 *
 * The fix costs nothing visible: renditions cap at 1600 px (thumb 400 / card
 * 800 / full 1600 — lib/services/media.ts), so re-encoding oversized photos
 * at MAX_EDGE_PX = 2000 in the browser loses nothing any surface renders.
 * The stored "original" becomes the downscaled file rather than the camera
 * original; true archival originals go through the bulk importer
 * (scripts/import/media.mts), which runs where the bytes are and never
 * meets the platform ceiling.
 *
 * The upload form also submits ONE FILE PER REQUEST (media-tab.tsx): the
 * ceiling applies to the whole body, so even downscaled photos batched into
 * one FormData could crest it together.
 *
 * NOTHING OVER THE BUDGET IS RETURNED (T-upload-size-honest): a file the
 * browser cannot resize, or whose re-encode is still too large, is refused
 * here with a message naming it — the platform's 413 would otherwise surface
 * as an unexplained failure.
 *
 * Canvas re-encode strips EXIF (orientation applied first via
 * createImageBitmap) — consistent with the server pipeline, which strips it
 * anyway. The pure decision logic lives in the exported helpers so it can be
 * unit-tested; only `downscaleForUpload` touches browser APIs.
 */

import { fitsUploadBudget, formatMegabytes, UPLOAD_REQUEST_BUDGET_BYTES } from "@/lib/constants/upload";

/** Long-edge target for client re-encode; > the 1600px "full" rendition. */
export const MAX_EDGE_PX = 2000;

const RE_ENCODE_QUALITY = 0.85;

/** Only files the server pipeline accepts anyway are worth re-encoding. */
const DECODABLE = ["image/jpeg", "image/png", "image/webp"];

export function needsClientDownscale(bytes: number, type: string): boolean {
  return bytes > UPLOAD_REQUEST_BUDGET_BYTES && DECODABLE.includes(type);
}

/** Fit (w, h) inside maxEdge preserving aspect; never enlarges. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const edge = Math.max(width, height);
  if (edge <= maxEdge) return { width, height };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Why a photo is not sent: it is over the budget and cannot be brought under it. */
function tooLargeText(name: string, bytes: number, resized: boolean): string {
  const size = formatMegabytes(bytes, "up");
  const limit = formatMegabytes(UPLOAD_REQUEST_BUDGET_BYTES, "down");
  const why = resized
    ? `is still ${size} after resizing — over the ${limit} limit for one upload`
    : `is ${size} — over the ${limit} limit for one upload, and this browser cannot resize it`;
  return `${name} ${why}. Nothing was uploaded. Use a smaller photo.`;
}

/**
 * Returns a file that fits the request budget: the file itself when it
 * already does, otherwise a JPEG re-encode at MAX_EDGE_PX. Throws a message
 * naming the file when it cannot be brought under the budget — not decodable,
 * not a type the browser can re-encode, or still too large after re-encoding
 * — so the caller says why instead of letting the platform answer 413.
 */
export async function downscaleForUpload(file: File): Promise<File> {
  if (!needsClientDownscale(file.size, file.type)) {
    if (fitsUploadBudget(file.size)) return file;
    throw new Error(tooLargeText(file.name, file.size, false));
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${file.name}: could not be read as an image`);
  }

  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE_PX);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error(`${file.name}: canvas unavailable in this browser`);
  }
  // JPEG has no alpha channel, and the HTML canvas spec serializes one by
  // compositing the pixels onto opaque BLACK — a transparent PNG would arrive
  // with a black background nobody chose. Lay the canvas on WHITE first: the
  // same flatten the server pipeline applies on purpose (lib/services/media.ts).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolveBlob) =>
    canvas.toBlob(resolveBlob, "image/jpeg", RE_ENCODE_QUALITY),
  );
  if (!blob) throw new Error(`${file.name}: could not be re-encoded`);
  // a 2000px JPEG is normally a fraction of the budget; a noisy panorama can
  // still crest it, and then it is refused here rather than by the platform
  if (!fitsUploadBudget(blob.size)) throw new Error(tooLargeText(file.name, blob.size, true));

  const stem = file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
}
