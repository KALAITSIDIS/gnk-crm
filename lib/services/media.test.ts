import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { processPropertyImage, RENDITIONS } from "./media";

/**
 * T1.4 acceptance: an uploaded JPEG carrying GPS EXIF must produce renditions
 * with NO EXIF (verified via sharp metadata).
 */

let gpsJpeg: Buffer;

beforeAll(async () => {
  gpsJpeg = await sharp({
    create: { width: 2400, height: 1600, channels: 3, background: { r: 30, g: 80, b: 140 } },
  })
    .jpeg({ quality: 90 })
    .withExif({
      IFD0: { Make: "TestCam", Model: "GPSShooter 3000", Copyright: "gnk-test" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "34/1 46/1 1200/100",
        GPSLongitudeRef: "E",
        GPSLongitude: "32/1 25/1 3000/100",
      },
    })
    .toBuffer();
});

describe("processPropertyImage (T1.4)", () => {
  it("input fixture really contains EXIF (incl. GPS block)", async () => {
    const meta = await sharp(gpsJpeg).metadata();
    expect(meta.exif, "test fixture must carry EXIF").toBeDefined();
    expect(meta.exif!.toString("binary")).toContain("TestCam");
  });

  it("strips ALL EXIF from every rendition", async () => {
    const { renditions } = await processPropertyImage(gpsJpeg);
    for (const { name } of RENDITIONS) {
      const meta = await sharp(renditions[name]).metadata();
      expect(meta.exif, `${name} rendition must have no EXIF`).toBeUndefined();
    }
  });

  it("produces WebP renditions at the spec widths", async () => {
    const { renditions, width, height } = await processPropertyImage(gpsJpeg);
    expect(width).toBe(2400);
    expect(height).toBe(1600);
    for (const { name, width: target } of RENDITIONS) {
      const meta = await sharp(renditions[name]).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(target);
    }
  });

  it("does not enlarge small images", async () => {
    const small = await sharp({
      create: { width: 500, height: 400, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    const { renditions } = await processPropertyImage(small);
    const full = await sharp(renditions.full).metadata();
    expect(full.width).toBe(500);
  });

  it("composites a watermark onto the full rendition only when provided", async () => {
    const watermark = await sharp({
      create: { width: 600, height: 200, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.6 } },
    })
      .png()
      .toBuffer();
    const withWm = await processPropertyImage(gpsJpeg, { watermark });
    expect(withWm.watermarked).toBe(true);
    const without = await processPropertyImage(gpsJpeg);
    expect(without.watermarked).toBe(false);
    // watermarked full must still be EXIF-free
    const meta = await sharp(withWm.renditions.full).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe("webp");
  });
});
