import { describe, expect, it } from "vitest";
import {
  MAX_EDGE_PX,
  UPLOAD_REQUEST_BUDGET_BYTES,
  fitWithin,
  needsClientDownscale,
} from "./client-image";

/**
 * REL-05: the browser half (createImageBitmap/canvas) cannot run under node;
 * these pin the DECISION logic — the parts a wrong constant or a flipped
 * comparison would silently break — against the measured platform reality.
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
