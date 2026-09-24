import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * A photo's events name it by id and by the digest of its bytes — never by the
 * name of the file it was uploaded from (audit SEC-03, DECISIONS
 * T-media-file-name-shape).
 *
 * A file name is whatever the uploader's machine called it ("Andreou villa
 * front.jpg"), and an assigned agent uploads too. Until this change
 * `uploadPropertyMedia` copied it into the hash-chained `media_uploaded` event,
 * and `deleteMediaBulk` READ it back out of those events with the admin client
 * to copy it again into `media_deleted` — the chain feeding itself typed text.
 * `property_media` never stored the name, so nothing on a row is lost; the
 * row's `content_sha256` (0088) now travels in both events instead, which keeps
 * "which image was this" answerable after the row is gone, without a word of
 * anyone's.
 *
 * The real actions call the real `logEvent`; the assertions read the row that
 * reached `events.insert`. The admin stand-in has STORAGE ONLY — no `.from` —
 * so a delete that still asks the system for old events fails loudly here.
 */

const state = vi.hoisted(() => ({ caller: null as unknown, removed: [] as string[][] }));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        upload: async (path: string) => ({ data: { path }, error: null }),
        // no org watermark; the fixture listings are drafts either way
        download: async () => ({ data: null, error: { message: "not found" } }),
        remove: async (paths: string[]) => {
          state.removed.push(paths);
          return { data: paths.map((name) => ({ name })), error: null };
        },
        exists: async () => ({ data: false, error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "agent-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/quality-score", () => ({ recomputeQualityScore: vi.fn(async () => null) }));
vi.mock("@/lib/services/site-revalidate", () => ({ notifySiteIfPublic: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { uploadPropertyMedia, deleteMediaBulk } = await import("@/lib/actions/media");

const PROPERTY_ID = "4d1e2f3a-4b5c-4d6e-8f7a-0b1c2d3e4f01";
// synthetic: a name and a phone number in a camera-roll style file name
const FILE_NAME = "Andreou Kyriakos villa front 99111222.jpg";
const WORDS = ["Andreou", "Kyriakos", "villa front", "99111222", ".jpg"];

/** A real image, because the action runs the real pipeline over it. */
const source = await sharp({
  create: { width: 60, height: 40, channels: 3, background: { r: 30, g: 90, b: 160 } },
})
  .jpeg()
  .toBuffer();
const SOURCE_SHA256 = createHash("sha256").update(source).digest("hex");

const inserted = (fake: ReturnType<typeof fakeClient>) =>
  fake.argsOf("events", "insert").map((args) => args[0] as Record<string, unknown>);
const leaked = (fake: ReturnType<typeof fakeClient>) => {
  const text = JSON.stringify(inserted(fake));
  return WORDS.filter((w) => text.includes(w));
};

beforeEach(() => {
  state.caller = null;
  state.removed = [];
});

function upload(kind: "photo" | "floor_plan", names: string[] = [FILE_NAME], inserts: FakePage[] = []) {
  const fake = fakeClient({
    properties: [{ data: { id: PROPERTY_ID, org_id: "org-1", visibility: "draft" }, error: null }],
    property_media: [
      { data: [], error: null }, // the gallery as it stands
      ...(inserts.length ? inserts : names.map((_, i) => ({ data: { id: `m-${i + 1}` }, error: null }))),
    ],
  });
  state.caller = fake.client;
  const form = new FormData();
  form.set("property_id", PROPERTY_ID);
  form.set("kind", kind);
  for (const name of names) form.append("files", new File([source], name, { type: "image/jpeg" }));
  return { fake, run: () => uploadPropertyMedia({ error: null, savedAt: null }, form) };
}

describe("uploadPropertyMedia logs the photo by id and digest, not by file name", () => {
  it("a photograph: ONE media_uploaded with id, kind, watermark flag and content digest", async () => {
    const { fake, run } = upload("photo");
    expect((await run()).error).toBeNull();
    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: "org-1",
      actor_id: "agent-1",
      entity_type: "property",
      entity_id: PROPERTY_ID,
      event_type: "media_uploaded",
    });
    expect(rows[0].payload).toEqual({
      media_id: "m-1",
      kind: "photo",
      watermarked: false,
      content_sha256: SOURCE_SHA256,
    });
    expect(leaked(fake), "a photo's file name reached the hash chain").toEqual([]);
  });

  it("the event's digest is the ROW's digest — one fact, one computation", async () => {
    const { fake, run } = upload("photo");
    expect((await run()).error).toBeNull();
    const [row] = fake.argsOf("property_media", "insert")[0] as [Record<string, unknown>];
    expect(inserted(fake)[0].payload).toMatchObject({ content_sha256: row.content_sha256 });
  });

  it("a floor plan: the same shape, with its kind", async () => {
    const { fake, run } = upload("floor_plan");
    expect((await run()).error).toBeNull();
    expect(inserted(fake)[0].payload).toEqual({
      media_id: "m-1",
      kind: "floor_plan",
      watermarked: false,
      content_sha256: SOURCE_SHA256,
    });
    expect(leaked(fake)).toEqual([]);
  });

  it("several files: one event each, none carrying its name", async () => {
    const { fake, run } = upload("photo", [FILE_NAME, "Kyriakos garden 99111222.jpg"]);
    expect((await run()).error).toBeNull();
    expect(inserted(fake).map((r) => (r.payload as { media_id: string }).media_id)).toEqual(["m-1", "m-2"]);
    expect(leaked(fake)).toEqual([]);
  });

  it("a rejected row logs nothing (and still does not echo the name into the chain)", async () => {
    const { fake, run } = upload("photo", [FILE_NAME], [{ data: null, error: { message: "new row violates row-level security" } }]);
    expect((await run()).error).toMatch(/not allowed/);
    expect(inserted(fake)).toEqual([]);
  });
});

const deletedRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "photo",
  is_cover: false,
  storage_path_original: `properties/${PROPERTY_ID}/original/${id}.jpg`,
  path_thumb: `properties/${PROPERTY_ID}/${id}_thumb.webp`,
  path_card: null,
  path_full: null,
  path_jpeg: null,
  content_sha256: SOURCE_SHA256,
  ...extra,
});

function remove(ids: string[], rows: unknown[]) {
  const fake = fakeClient({ property_media: [{ data: rows, error: null }] });
  state.caller = fake.client;
  return { fake, run: () => deleteMediaBulk(PROPERTY_ID, ids) };
}

describe("deleteMediaBulk logs the photo by id and digest, and never reads old events", () => {
  it("one photo: ONE media_deleted with its id and digest — no name, no system read", async () => {
    // the admin stand-in has no `.from`: asking the system for events would throw
    const { fake, run } = remove(["m1"], [deletedRow("m1")]);
    expect(await run()).toEqual({ error: null, deleted: 1 });
    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: "property", entity_id: PROPERTY_ID, event_type: "media_deleted" });
    expect(rows[0].payload).toEqual({ media_id: "m1", content_sha256: SOURCE_SHA256 });
    // storage behaviour unchanged: renditions and the original are removed
    expect(state.removed.flat()).toEqual(
      expect.arrayContaining([`properties/${PROPERTY_ID}/m1_thumb.webp`, `properties/${PROPERTY_ID}/original/m1.jpg`]),
    );
  });

  it("the delete asks the row for its digest (the select names the column)", async () => {
    const { fake, run } = remove(["m1"], [deletedRow("m1")]);
    await run();
    expect(String(fake.argsOf("property_media", "select")[0][0])).toContain("content_sha256");
  });

  it("several photos: one event each, flagged bulk", async () => {
    const { fake, run } = remove(["m1", "m2"], [deletedRow("m1"), deletedRow("m2", { content_sha256: null })]);
    expect((await run()).deleted).toBe(2);
    expect(inserted(fake).map((r) => r.payload)).toEqual([
      { media_id: "m1", content_sha256: SOURCE_SHA256, bulk: true },
      // an imported photo written before its digest was backfilled: no key, not a null
      { media_id: "m2", bulk: true },
    ]);
  });

  it("a refused delete (0 rows) removes nothing and logs nothing", async () => {
    const { fake, run } = remove(["m1"], []);
    expect((await run()).error).toMatch(/Nothing was deleted/);
    expect(state.removed).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });
});
