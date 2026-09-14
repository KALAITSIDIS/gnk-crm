import sharp, { type Sharp } from "sharp";

/**
 * Media pipeline (doc 02 §A7): strip EXIF → renditions thumb 400 / card 800 /
 * full 1600 WebP, plus (0095) `jpeg` 1600 JPEG — the full rendition's twin for
 * portal feeds, because RERA takes JPEG/PNG only and four other portals leave
 * the format undocumented → optional watermark on `full` AND `jpeg` when the
 * property is publicly visible. Sharp discards metadata by default — we never
 * call withMetadata() on renditions, which is what guarantees GPS/EXIF removal.
 */

export const RENDITIONS = [
  { name: "thumb", width: 400, format: "webp" },
  { name: "card", width: 800, format: "webp" },
  { name: "full", width: 1600, format: "webp" },
  { name: "jpeg", width: 1600, format: "jpeg" },
] as const;
export type RenditionName = (typeof RENDITIONS)[number]["name"];

/** Storage extension per rendition: `<id>_full.webp`, `<id>_jpeg.jpg`. */
export function renditionExt(name: RenditionName): "webp" | "jpg" {
  return name === "jpeg" ? "jpg" : "webp";
}
export function renditionMime(name: RenditionName): "image/webp" | "image/jpeg" {
  return name === "jpeg" ? "image/jpeg" : "image/webp";
}

export const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp"];
/**
 * The PIPELINE's cap, reachable only by the bulk importer
 * (scripts/import/media.mts). Through the UI's server action the REAL ceiling
 * is Vercel's: request bodies over ~4.5 MB die with a platform 413 before any
 * app code runs — MEASURED on production 2026-08-30 (3 MB → 200; 5/8/20 MB →
 * 413). The browser therefore downscales oversized photos and submits one
 * file per request (lib/services/client-image.ts, media-tab.tsx).
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

export interface ProcessedImage {
  renditions: Record<RenditionName, Buffer>;
  width: number;
  height: number;
  watermarked: boolean;
}

export async function processPropertyImage(
  input: Buffer,
  options: { watermark?: Buffer | null } = {},
): Promise<ProcessedImage> {
  const base = sharp(input, { failOn: "error" }).rotate(); // apply EXIF orientation before stripping
  const meta = await base.metadata();
  if (!meta.width || !meta.height) throw new Error("Unreadable image");

  const out = {} as Record<RenditionName, Buffer>;
  let watermarked = false;

  const encode = (p: Sharp, name: RenditionName) =>
    name === "jpeg"
      ? p.jpeg({ quality: 85, mozjpeg: true })
      : p.webp({ quality: name === "thumb" ? 72 : 80 });
  const source = await base.clone().toBuffer();
  let wmBuffer: Buffer | null = null;
  for (const { name, width } of RENDITIONS) {
    let pipeline = sharp(source).resize({ width, withoutEnlargement: true });
    if ((name === "full" || name === "jpeg") && options.watermark) {
      if (!wmBuffer) {
        // scale watermark to ~25% of image width, bottom-right
        const targetWidth = Math.min(width, meta.width);
        wmBuffer = await sharp(options.watermark)
          .resize({ width: Math.round(targetWidth * 0.25) })
          .png()
          .toBuffer();
      }
      pipeline = sharp(await pipeline.toBuffer()).composite([{ input: wmBuffer, gravity: "southeast" }]);
      watermarked = true;
    }
    out[name] = await encode(pipeline, name).toBuffer();
  }

  return { renditions: out, width: meta.width, height: meta.height, watermarked };
}

/** True when this visibility level gets a watermark on public renditions (doc 02 §A7). */
export function shouldWatermark(visibility: string): boolean {
  return visibility === "public" || visibility === "partner";
}
