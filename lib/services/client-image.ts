/**
 * Client-side image downscaling before upload (audit 2026-08-29 REL-05).
 *
 * MEASURED, NOT ASSUMED (2026-08-30, production probes): Vercel rejects
 * request bodies over ~4.5 MB with a platform 413 before any app code runs —
 * 3 MB → 200, 5/8/20 MB → 413. Camera originals commonly run 3–8 MB, so the
 * server action's 20 MB promise was undeliverable and the first real photo
 * upload would have failed with an opaque 413 that looks like a code fault.
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
 * Canvas re-encode strips EXIF (orientation applied first via
 * createImageBitmap) — consistent with the server pipeline, which strips it
 * anyway. The pure decision logic lives in the exported helpers so it can be
 * unit-tested; only `downscaleForUpload` touches browser APIs.
 */

/** Keep each request comfortably under the measured ~4.5 MB platform 413. */
export const UPLOAD_REQUEST_BUDGET_BYTES = 3_500_000;

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

/**
 * Returns the file itself when it already fits the request budget; otherwise
 * a JPEG re-encode at MAX_EDGE_PX. Throws with the file's name when the
 * browser cannot decode it — the caller surfaces that instead of letting the
 * platform answer 413 with no explanation.
 */
export async function downscaleForUpload(file: File): Promise<File> {
  if (!needsClientDownscale(file.size, file.type)) return file;

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
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolveBlob) =>
    canvas.toBlob(resolveBlob, "image/jpeg", RE_ENCODE_QUALITY),
  );
  if (!blob) throw new Error(`${file.name}: could not be re-encoded`);

  const stem = file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
}
