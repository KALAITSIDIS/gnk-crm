import { afterEach, describe, expect, it, vi } from "vitest";
import { UPLOAD_REQUEST_BUDGET_BYTES } from "@/lib/constants/upload";
import {
  MAX_EDGE_PX,
  downscaleForUpload,
  fitWithin,
  needsClientDownscale,
} from "./client-image";

/**
 * REL-05: the decision logic is pinned directly; the browser half
 * (createImageBitmap / canvas) is driven through a fake canvas below, which
 * records the order of the 2D context's calls.
 */
describe("client downscale decisions (REL-05)", () => {
  it("the budget sits under the measured ~4.5 MB platform 413", () => {
    // production probes 2026-08-30: 3 MB → 200, 5 MB → 413. The budget must
    // leave headroom for FormData framing and the rest of the body.
    expect(UPLOAD_REQUEST_BUDGET_BYTES).toBeLessThan(4_500_000);
    expect(UPLOAD_REQUEST_BUDGET_BYTES).toBeGreaterThan(3_000_000);
  });

  it("a phone-sized JPEG gets downscaled; a small one passes through untouched", () => {
    expect(needsClientDownscale(8_000_000, "image/jpeg")).toBe(true);
    expect(needsClientDownscale(1_200_000, "image/jpeg")).toBe(false);
  });

  it("an oversize NON-image is not 'downscaled' into a fake image", () => {
    // the server rejects the type anyway; re-encoding a PDF via canvas would
    // manufacture a valid-looking JPEG out of garbage
    expect(needsClientDownscale(9_000_000, "application/pdf")).toBe(false);
  });

  it("the client target exceeds the largest server rendition, so nothing rendered is lost", () => {
    expect(MAX_EDGE_PX).toBeGreaterThan(1600); // "full" rendition width, media.ts
  });

  it("fitWithin preserves aspect and never enlarges", () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3000, 4000, 2000)).toEqual({ width: 1500, height: 2000 });
    expect(fitWithin(1200, 800, 2000)).toEqual({ width: 1200, height: 800 }); // already fits
  });

  it("a degenerate sliver never rounds to zero pixels", () => {
    const { width, height } = fitWithin(10000, 3, 2000);
    expect(width).toBe(2000);
    expect(height).toBeGreaterThanOrEqual(1);
  });
});

type Call = { op: "fillStyle" | "fillRect" | "drawImage" | "toBlob"; fillStyle?: string; args?: unknown[] };

/**
 * A fake browser: createImageBitmap answers a 4000×3000 bitmap (or fails),
 * document.createElement("canvas") a canvas whose 2D context records every
 * call in order, and toBlob a blob of `blobBytes`.
 */
function fakeBrowser({ blobBytes, decodeFails = false }: { blobBytes: number; decodeFails?: boolean }) {
  const calls: Call[] = [];
  let fillStyle = "#000000"; // the 2D context's initial fillStyle
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
      calls.push({ op: "fillStyle", fillStyle: value });
    },
    fillRect: (...args: unknown[]) => calls.push({ op: "fillRect", fillStyle, args }),
    drawImage: (...args: unknown[]) => calls.push({ op: "drawImage", args: args.slice(1) }),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === "2d" ? ctx : null),
    toBlob: (done: (blob: Blob | null) => void, type: string, quality: number) => {
      calls.push({ op: "toBlob", args: [type, quality] });
      done(new Blob([new Uint8Array(blobBytes)], { type }));
    },
  };
  const bitmap = { width: 4000, height: 3000, close: vi.fn() };
  const createImageBitmap = vi.fn(async () => {
    if (decodeFails) throw new Error("decode failed");
    return bitmap;
  });
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
      return canvas;
    },
  });
  return { calls, createImageBitmap, canvas };
}

const photo = (bytes: number, name: string, type: string) =>
  new File([new Uint8Array(bytes)], name, { type });

describe("downscaleForUpload in the browser (T-upload-size-honest)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a transparent PNG over the budget is laid on WHITE before it is drawn — never JPEG's black", async () => {
    // HTML canvas spec: serializing to a format without alpha composites the
    // pixels onto an opaque BLACK background. The server flattens to white on
    // purpose (lib/services/media.ts encode()); the browser must not pre-empt it.
    const browser = fakeBrowser({ blobBytes: 900_000 });
    await downscaleForUpload(photo(4_000_000, "pool.png", "image/png"));
    const fill = browser.calls.findIndex((c) => c.op === "fillRect");
    const draw = browser.calls.findIndex((c) => c.op === "drawImage");
    expect(fill, "the canvas is filled").toBeGreaterThanOrEqual(0);
    expect(draw).toBeGreaterThanOrEqual(0);
    expect(fill, "fill BEFORE draw").toBeLessThan(draw);
    expect(browser.calls[fill].fillStyle).toMatch(/^(#fff(fff)?|white)$/i);
    // the whole canvas, not a corner of it
    expect(browser.calls[fill].args).toEqual([0, 0, 2000, 1500]);
    expect(browser.calls[draw].args).toEqual([0, 0, 2000, 1500]);
  });

  it("the re-encode comes back as a JPEG under the photo's own name", async () => {
    fakeBrowser({ blobBytes: 900_000 });
    const out = await downscaleForUpload(photo(4_000_000, "pool.png", "image/png"));
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("pool.jpg");
    expect(out.size).toBe(900_000);
  });

  it("a re-encode STILL over the budget is refused, never posted", async () => {
    const browser = fakeBrowser({ blobBytes: UPLOAD_REQUEST_BUDGET_BYTES + 1 });
    const refusal = downscaleForUpload(photo(9_000_000, "panorama.jpg", "image/jpeg"));
    await expect(refusal).rejects.toThrow(/panorama\.jpg/);
    await expect(refusal).rejects.toThrow(/3\.3 MB/);
    await expect(refusal).rejects.toThrow(/nothing was uploaded/i);
    await expect(refusal).rejects.toThrow(/smaller photo/i);
    expect(browser.calls.some((c) => c.op === "toBlob")).toBe(true);
  });

  it("an over-budget file of a type the server refuses is told its TYPE is the problem — not its size", async () => {
    // picked through "All files": a smaller HEIC would only meet the server's
    // "only JPEG/PNG/WebP accepted" (lib/actions/media.ts) — so "use a smaller
    // photo" would send the user the wrong way
    for (const [name, type] of [
      ["scan.heic", "image/heic"],
      ["IMG_0001.dng", ""], // a type the OS could not name
    ] as const) {
      const browser = fakeBrowser({ blobBytes: 1 });
      const message = await downscaleForUpload(photo(5_000_000, name, type)).then(
        () => "RESOLVED — the file would have been sent",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      expect(message.startsWith(name)).toBe(true);
      expect(message).toMatch(/only JPEG, PNG or WebP/);
      expect(message).toMatch(/nothing was uploaded/i);
      expect(message).not.toMatch(/smaller photo|cannot resize/i);
      expect(browser.createImageBitmap).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("an over-budget photo that does not decode is refused by name", async () => {
    fakeBrowser({ blobBytes: 1, decodeFails: true });
    await expect(downscaleForUpload(photo(5_000_000, "broken.jpg", "image/jpeg"))).rejects.toThrow(
      /broken\.jpg: could not be read as an image/,
    );
  });

  it("a photo within the budget is sent exactly as chosen — not decoded, not re-encoded", async () => {
    const browser = fakeBrowser({ blobBytes: 1 });
    const small = photo(1_000_000, "kitchen.png", "image/png");
    expect(await downscaleForUpload(small)).toBe(small);
    expect(browser.createImageBitmap).not.toHaveBeenCalled();
  });
});
