import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { isOwnMediaPath, ownMediaPrefix } from "@/lib/services/media-path";

/**
 * T-media-path-bound (audit 2026-10-17 MEDIA-1): `deleteMediaBulk` removes
 * storage objects AS THE SERVICE ROLE, by the names the deleted rows hold. It
 * removes only names under the listing's own prefix (isOwnMediaPath — the
 * rule 0148's CHECK enforces on write, kept here for rows written before it),
 * never a name a SURVIVING row of the listing still holds, and nothing at all
 * when it cannot read the survivors. The real stack's half is
 * supabase/tests/media-path-bound.test.ts.
 */

const state = vi.hoisted(() => ({
  caller: null as unknown,
  removed: [] as [string, string[]][],
  sentry: [] as { message: string; tags?: Record<string, string> }[],
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          state.removed.push([bucket, paths]);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
  }),
}));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, ctx?: { tags?: Record<string, string> }) => void state.sentry.push({ message, tags: ctx?.tags }),
  captureException: () => {},
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "user-1", orgId: "org-1", role: "listing_manager" }),
}));
vi.mock("@/lib/services/quality-score", () => ({
  recomputeQualityScore: vi.fn(async () => null),
  recomputeQuietly: vi.fn(async () => {}),
}));
vi.mock("@/lib/services/site-revalidate", () => ({ notifySiteIfPublic: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { deleteMediaBulk } = await import("@/lib/actions/media");

const L = "4d1e2f3a-4b5c-4d6e-8f7a-0b1c2d3e4f01";
const OTHER = "4d1e2f3a-4b5c-4d6e-8f7a-0b1c2d3e4f02";
const M1 = "4d1e2f3a-4b5c-4d6e-8f7a-0b1c2d3e4f11";
const M2 = "4d1e2f3a-4b5c-4d6e-8f7a-0b1c2d3e4f12";
const MANDATE = "org-1/mandates/m-1-signed.pdf";

const own = (id: string, kind = "photo") => ({
  id,
  kind,
  is_cover: false,
  content_sha256: null,
  storage_path_original: `properties/${L}/original/${id}.jpg`,
  path_thumb: `properties/${L}/${id}_thumb.webp`,
  path_card: `properties/${L}/${id}_card.webp`,
  path_full: `properties/${L}/${id}_full.webp`,
  path_jpeg: kind === "photo" ? `properties/${L}/${id}_jpeg.jpg` : null,
});
const namesOf = (r: ReturnType<typeof own>) =>
  [r.storage_path_original, r.path_thumb, r.path_card, r.path_full, r.path_jpeg].filter(Boolean) as string[];

/** The delete's answer, then the survivors read. */
function run(deleted: unknown[], survivors: FakePage, ids = deleted.map((d) => (d as { id: string }).id)) {
  const fake = fakeClient({ property_media: [{ data: deleted, error: null }, survivors] });
  state.caller = fake.client;
  return { fake, go: () => deleteMediaBulk(L, ids) };
}
const removedNames = () => state.removed.flatMap(([, names]) => names);

beforeEach(() => {
  state.caller = null;
  state.removed = [];
  state.sentry = [];
});

describe("isOwnMediaPath — the CHECK's rule (0148), for the readers", () => {
  it("accepts every name a writer gives this listing", () => {
    for (const p of namesOf(own(M1))) expect(isOwnMediaPath(L, p), p).toBe(true);
    expect(isOwnMediaPath(L, `properties/${L}/original/${M1}.png`)).toBe(true);
  });

  it.each([
    ["another record's object", MANDATE],
    ["another listing's prefix", `properties/${OTHER}/${M1}_card.webp`],
    ["a longer segment", `properties/${L}0/${M1}_card.webp`],
    ["a '..' path", `properties/${L}/../../${MANDATE}`],
    ["an encoded '..'", `properties/${L}/%2e%2e/%2e%2e/${MANDATE}`],
    ["an encoded '..' (upper case, mixed)", `properties/${L}/.%2E/%2E./${MANDATE}`],
    ["a backslashed '..'", `properties/${L}/..\\..\\${MANDATE}`],
    ["a space", `properties/${L}/a b.webp`],
    ["a newline", `properties/${L}/a\nb.webp`],
    ["the bare prefix", `properties/${L}/`],
    ["the prefix without its slash", `properties/${L}`],
    ["empty", ""],
    ["not a string", null],
  ])("refuses %s", (_label, p) => {
    expect(isOwnMediaPath(L, p)).toBe(false);
  });

  it("compares the listing id as stored (lower case), however the caller spells it", () => {
    expect(ownMediaPrefix(L.toUpperCase())).toBe(`properties/${L}/`);
    expect(isOwnMediaPath(L.toUpperCase(), `properties/${L}/${M1}_card.webp`)).toBe(true);
    expect(isOwnMediaPath(L, `properties/${L.toUpperCase()}/${M1}_card.webp`)).toBe(false);
  });
});

describe("deleteMediaBulk removes only the listing's own objects that no surviving row names", () => {
  it("control: a photo's own objects are removed — renditions from media, the original from documents", async () => {
    const r = own(M1);
    const { go } = run([r], { data: [], error: null });
    expect(await go()).toEqual({ error: null, deleted: 1 });
    expect(state.removed).toEqual([
      ["media", [r.path_thumb, r.path_card, r.path_full, r.path_jpeg]],
      ["documents", [r.storage_path_original]],
    ]);
  });

  it("a deleted row naming foreign objects (written before 0148): none of them is removed; its own still are", async () => {
    const r = {
      ...own(M1),
      storage_path_original: MANDATE,
      path_card: `properties/${OTHER}/x_card.webp`,
      path_full: `properties/${L}/%2e%2e/%2e%2e/${MANDATE}`,
      path_jpeg: `properties/${L}/../../${MANDATE}`,
    };
    const { go } = run([r], { data: [], error: null });
    expect(await go()).toEqual({ error: null, deleted: 1 });
    expect(removedNames()).toEqual([r.path_thumb]);
    for (const name of removedNames()) expect(isOwnMediaPath(L, name)).toBe(true);
  });

  it("a name a surviving row of the listing still holds is not removed", async () => {
    const kept = own(M1);
    const gone = { ...own(M2), path_card: kept.path_card, path_full: kept.path_full };
    const { go } = run([gone], { data: [kept], error: null });
    expect(await go()).toEqual({ error: null, deleted: 1 });
    expect(removedNames()).not.toContain(kept.path_card);
    expect(removedNames()).not.toContain(kept.path_full);
    expect(removedNames().sort()).toEqual([gone.storage_path_original, gone.path_thumb, gone.path_jpeg].sort());
  });

  it("the survivors are read AFTER the delete, from the listing's rows, naming all five path columns", async () => {
    const { fake, go } = run([own(M1)], { data: [], error: null });
    await go();
    // two property_media requests (no cover was deleted): the delete, then the survivors
    expect(fake.served.property_media).toBe(2);
    expect(fake.calls.filter((c) => c.table === "property_media" && c.method === "delete")).toHaveLength(1);
    const [deleteSelect, survivorsSelect] = fake.argsOf("property_media", "select").map((a) => String(a[0]));
    expect(deleteSelect).toContain("is_cover");
    expect(survivorsSelect).not.toContain("is_cover");
    for (const col of ["storage_path_original", "path_thumb", "path_card", "path_full", "path_jpeg"]) {
      expect(survivorsSelect).toContain(col);
    }
    // both bound to the listing
    expect(fake.argsOf("property_media", "eq").filter(([c, v]) => c === "property_id" && v === L)).toHaveLength(2);
  });

  it.each([
    ["an error", { data: null, error: { message: "boom", code: "XX000" } }],
    ["a hollow answer (no rows array, no error)", { data: null, error: null }],
  ] as [string, FakePage][])("the survivors read answers %s: nothing is removed, the delete still succeeds, the failure is reported", async (_l, page) => {
    const { fake, go } = run([own(M1), own(M2)], page);
    expect(await go()).toEqual({ error: null, deleted: 2 });
    expect(state.removed).toEqual([]);
    expect(state.sentry).toEqual([
      { message: "[media delete] survivor read failed — no files removed", tags: { operation: "media_upload.delete_survivors" } },
    ]);
    // the events are still written, one per photo
    expect(fake.argsOf("events", "insert")).toHaveLength(2);
  });

  it("a mixed delete keeps each bucket's removal to its own kind, still bounded to the prefix", async () => {
    const photo = own(M1);
    const plan = { ...own(M2, "floor_plan"), path_card: MANDATE };
    const { go } = run([photo, plan], { data: [], error: null });
    await go();
    const media = state.removed.filter(([b]) => b === "media").flatMap(([, n]) => n);
    const documents = state.removed.filter(([b]) => b === "documents").flatMap(([, n]) => n);
    expect(media.sort()).toEqual([photo.path_thumb, photo.path_card, photo.path_full, photo.path_jpeg].sort());
    expect(documents.sort()).toEqual([plan.path_thumb, plan.path_full, photo.storage_path_original, plan.storage_path_original].sort());
    expect(documents).not.toContain(MANDATE);
  });
});
