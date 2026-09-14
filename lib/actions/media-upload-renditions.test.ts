import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * What the upload PUTS IN THE BUCKET, and what the row then points at.
 *
 * lib/services/media.test.ts proves the pipeline makes four renditions; it
 * cannot prove the action uploads the fourth, names it `_jpeg.jpg`, serves it
 * as image/jpeg, or records it in `path_jpeg` — and `portal_supplement()`
 * (0095) returns only photos whose `path_jpeg` is set, so a row written
 * without it is silently absent from every portal feed.
 *
 * The other half is the one a portal never sees: a FLOOR PLAN gets no JPEG.
 * Its renditions live in the private `documents` bucket (media-bucket.ts,
 * A07), where nothing reads a JPEG — writing one there would be an object
 * nobody deletes and nobody uses.
 */

const state = vi.hoisted(() => ({ caller: null as unknown }));
const stored = vi.hoisted(() => ({
  uploads: [] as { bucket: string; path: string; contentType: string }[],
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _body: unknown, opts: { contentType: string }) => {
          stored.uploads.push({ bucket, path, contentType: opts.contentType });
          return { data: { path }, error: null };
        },
        // this org has no watermark uploaded; the listings below are drafts
        // either way, so nothing asks for one
        download: async () => ({ data: null, error: { message: "not found" } }),
      }),
    },
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "u-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/services/quality-score", () => ({ recomputeQualityScore: vi.fn(async () => null) }));
vi.mock("@/lib/services/site-revalidate", () => ({ notifySiteIfPublic: vi.fn(async () => {}) }));
vi.mock("@/lib/services/storage", () => ({ removeObjectsBestEffort: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { uploadPropertyMedia } = await import("@/lib/actions/media");

/** A real image, because the action runs the real pipeline over it. */
const source = await sharp({
  create: { width: 60, height: 40, channels: 3, background: { r: 200, g: 40, b: 40 } },
})
  .jpeg()
  .toBuffer();

function harness(kind: "photo" | "floor_plan") {
  stored.uploads.length = 0;
  const caller = fakeClient({
    properties: [{ data: { id: "prop-1", org_id: "org-1", visibility: "draft" }, error: null }],
    property_media: [
      { data: [], error: null }, // the gallery as it stands
      { data: { id: "m-1" }, error: null }, // the insert's `.select("id").single()`
    ],
  });
  state.caller = caller.client;
  const form = new FormData();
  form.set("property_id", "prop-1");
  form.set("kind", kind);
  form.append("files", new File([source], "villa.jpg", { type: "image/jpeg" }));
  return {
    caller,
    run: () => uploadPropertyMedia({ error: null, savedAt: null }, form),
    /** the renditions, in upload order — the original is not one */
    renditions: () => stored.uploads.filter((u) => !u.path.includes("/original/")),
    inserted: () =>
      caller.argsOf("property_media", "insert")[0][0] as Record<string, unknown>,
  };
}

describe("uploadPropertyMedia stores the renditions the row promises", () => {
  it("a photograph: four objects, the JPEG among them, and path_jpeg points at it", async () => {
    const h = harness("photo");
    expect((await h.run()).error).toBeNull();

    expect(
      h.renditions().map((u) => [u.path.slice(u.path.lastIndexOf("_")), u.contentType, u.bucket]),
    ).toEqual([
      ["_thumb.webp", "image/webp", "media"],
      ["_card.webp", "image/webp", "media"],
      ["_full.webp", "image/webp", "media"],
      ["_jpeg.jpg", "image/jpeg", "media"],
    ]);

    const row = h.inserted();
    expect(String(row.path_full)).toMatch(/_full\.webp$/);
    // not just "ends in _jpeg.jpg": the row must name an object that was
    // actually uploaded, which is what a portal will try to fetch
    expect(h.renditions().map((u) => u.path)).toContain(row.path_jpeg);
  });

  it("a floor plan: three objects, no JPEG anywhere, path_jpeg null", async () => {
    const h = harness("floor_plan");
    expect((await h.run()).error).toBeNull();

    expect(h.renditions().map((u) => u.path.slice(u.path.lastIndexOf("_")))).toEqual([
      "_thumb.webp",
      "_card.webp",
      "_full.webp",
    ]);
    expect(
      h.renditions().every((u) => u.bucket === "documents"),
      "a plan's renditions are private",
    ).toBe(true);

    expect(h.inserted().path_jpeg).toBeNull();
  });
});
