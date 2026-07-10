import sharp from "sharp";

/**
 * Media pipeline (doc 02 §A7): strip EXIF → renditions thumb 400 / card 800 /
 * full 1600 WebP → optional watermark on `full` when the property is publicly
 * visible. Sharp discards metadata by default — we never call withMetadata()
 * on renditions, which is what guarantees GPS/EXIF removal.
 */

export const RENDITIONS = [
  { name: "thumb", width: 400 },
  { name: "card", width: 800 },
  { name: "full", width: 1600 },
] as const;
export type RenditionName = (typeof RENDITIONS)[number]["name"];

export const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp"];
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

  for (const { name, width } of RENDITIONS) {
    let pipeline = sharp(await base.clone().toBuffer())
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: name === "thumb" ? 72 : 80 });

    if (name === "full" && options.watermark) {
      // scale watermark to ~25% of image width, bottom-right
      const targetWidth = Math.min(width, meta.width);
      const wm = await sharp(options.watermark)
        .resize({ width: Math.round(targetWidth * 0.25) })
        .png()
        .toBuffer();
      pipeline = sharp(
        await sharp(await base.clone().toBuffer())
          .resize({ width, withoutEnlargement: true })
          .toBuffer(),
      )
        .composite([{ input: wm, gravity: "southeast" }])
        .webp({ quality: 80 });
      watermarked = true;
    }

    out[name] = await pipeline.toBuffer();
  }

  return { renditions: out, width: meta.width, height: meta.height, watermarked };
}

/** True when this visibility level gets a watermark on public renditions (doc 02 §A7). */
export function shouldWatermark(visibility: string): boolean {
  return visibility === "public" || visibility === "partner";
}
