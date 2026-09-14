import sharp, { type Sharp } from "sharp";

/**
 * Media pipeline (doc 02 §A7): strip EXIF → renditions thumb 400 / card 800 /
 * full 1600 WebP, plus (0095) `jpeg` 1600 JPEG — the full rendition's twin for
 * portal feeds, because RERA takes JPEG/PNG only and four other portals leave
 * the format undocumented → optional watermark on `full` AND `jpeg` when the
 * property is publicly visible, and alpha flattened to WHITE on the JPEG,
 * which cannot carry it. Sharp discards metadata by default — we never call
 * withMetadata() on renditions, which is what guarantees GPS/EXIF removal.
 */

/**
 * ONE definition of what a rendition is. Width, encoder, the extension its
 * object carries, the content type it is served with, and whether the org
 * watermark goes on it — all of it here, so nothing downstream re-derives a
 * rendition's properties from its NAME (`name === "jpeg" ? … : …` scattered
 * across the upload, the importer and the backfill is how the four of them
 * drift apart).
 */
export const RENDITIONS = [
  { name: "thumb", width: 400, format: "webp", ext: "webp", mime: "image/webp", watermark: false },
  { name: "card", width: 800, format: "webp", ext: "webp", mime: "image/webp", watermark: false },
  { name: "full", width: 1600, format: "webp", ext: "webp", mime: "image/webp", watermark: true },
  { name: "jpeg", width: 1600, format: "jpeg", ext: "jpg", mime: "image/jpeg", watermark: true },
] as const;
export type Rendition = (typeof RENDITIONS)[number];
export type RenditionName = Rendition["name"];

const rendition = (name: RenditionName): Rendition => RENDITIONS.find((r) => r.name === name)!;

/** Storage extension per rendition: `<id>_full.webp`, `<id>_jpeg.jpg`. */
export function renditionExt(name: RenditionName): Rendition["ext"] {
  return rendition(name).ext;
}
export function renditionMime(name: RenditionName): Rendition["mime"] {
  return rendition(name).mime;
}

/**
 * How the portal JPEG is encoded — here, and in scripts/media/backfill-jpeg.mts,
 * so a photo backfilled from its `full` WebP is the same file the pipeline
 * would have produced.
 */
export const JPEG_ENCODE = { quality: 85, mozjpeg: true } as const;

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

  // JPEG has no alpha channel: a transparent PNG would otherwise be flattened
  // against sharp's default BLACK, and a portal would receive a photograph
  // with a black background nobody chose.
  const encode = (p: Sharp, r: Rendition) =>
    r.format === "jpeg"
      ? p.flatten({ background: "#ffffff" }).jpeg(JPEG_ENCODE)
      : p.webp({ quality: r.name === "thumb" ? 72 : 80 });

  const source = await base.clone().toBuffer();
  // the mark is scaled to the rendition it goes on, so it is cached BY that
  // width — `full` and `jpeg` share one today, a third width would get its own
  const marks = new Map<number, Buffer>();
  for (const r of RENDITIONS) {
    // one pipeline per rendition: sharp applies the composite after the resize,
    // so there is no intermediate encode/decode between them
    let pipeline = sharp(source).resize({ width: r.width, withoutEnlargement: true });
    if (r.watermark && options.watermark) {
      // scale watermark to ~25% of image width, bottom-right
      const targetWidth = Math.min(r.width, meta.width);
      let mark = marks.get(targetWidth);
      if (!mark) {
        mark = await sharp(options.watermark)
          .resize({ width: Math.round(targetWidth * 0.25) })
          .png()
          .toBuffer();
        marks.set(targetWidth, mark);
      }
      pipeline = pipeline.composite([{ input: mark, gravity: "southeast" }]);
      watermarked = true;
    }
    out[r.name] = await encode(pipeline, r).toBuffer();
  }

  return { renditions: out, width: meta.width, height: meta.height, watermarked };
}

/** True when this visibility level gets a watermark on public renditions (doc 02 §A7). */
export function shouldWatermark(visibility: string): boolean {
  return visibility === "public" || visibility === "partner";
}
