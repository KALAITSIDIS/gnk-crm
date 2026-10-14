import * as Sentry from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EventWriteError } from "@/lib/services/events";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * A committed write tells the site even when a follow-up throws
 * (T-site-knock-order).
 *
 * `notifySiteAfter` hands the knock to Next's `after()`, which runs even when
 * the action throws later — but only a knock that was already scheduled. Each
 * action below used to schedule it AFTER a step that can throw (the event
 * insert, the deal-health refresh), or not at all (the inherited-field sync,
 * the area rename), so a failed timeline line left the committed change on the
 * public site in its old form for up to an hour: an archived listing still
 * listed, a deleted photograph rendered broken.
 *
 * Driven through the REAL actions, the REAL notifier and the REAL logEvent:
 * the event insert answers a database error, so logEvent throws
 * EventWriteError exactly as it would in production. Outside a request scope
 * `after()` throws and the notifier sends the knock inline, so it reaches
 * `fetch` here — the door's stand-in. Each case asserts the action still
 * throws (nothing else about the actions changed: the error is theirs to
 * report, BACKLOG "A committed photo delete, archive or sold/rented save…"),
 * that the write happened, and that ONE knock named what moved.
 *
 * site-revalidate-callsites.test.ts pins the same order in the source for
 * every action that knocks; this file is where it is seen.
 */
const state = vi.hoisted(() => ({ caller: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        remove: async (paths: string[]) => ({ data: paths.map((name) => ({ name })), error: null }),
        exists: async () => ({ data: false, error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "admin-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
// derived state, not under test: the score never throws here
vi.mock("@/lib/services/quality-score", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recomputeQualityScore: vi.fn(async () => null),
  recomputeQuietly: vi.fn(async () => undefined),
  refreshContainerScores: vi.fn(async () => undefined),
}));
// the legal save's follow-up that throws (its event is caught by `record`)
vi.mock("@/lib/services/health-score", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recomputeDealsFor: vi.fn(async () => {
    throw new Error("Fixture: the deal-health refresh failed");
  }),
}));

const { archiveProperty, restoreProperty, updatePropertySection } = await import("@/lib/actions/properties");
const { setMediaCover, setMediaAlt, moveMedia, deleteMediaBulk } = await import("@/lib/actions/media");
const { syncInheritedField } = await import("@/lib/actions/unit-inheritance");
const { renameArea } = await import("@/lib/actions/settings");

const OLD = { ...process.env };
const DOOR = "https://site.example/api/revalidate";
const PROPERTY_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01";
const AREA_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c02";
/** the event insert answers a database error: the real logEvent throws */
const EVENT_FAILS: FakePage = { data: null, error: { message: "Fixture: the events insert failed", code: "XX000" } };
const PUBLIC_LISTING: FakePage = { data: { reference: "PAF0001", visibility: "public" }, error: null };

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  process.env = { ...OLD, SITE_REVALIDATE_URL: DOOR, SITE_REVALIDATE_KEY: "k-secret" };
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  vi.mocked(Sentry.captureMessage).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = OLD;
  vi.restoreAllMocks();
});

function use(pages: Record<string, FakePage[]>) {
  const fake = fakeClient(pages);
  state.caller = fake.client;
  return fake;
}

/** The knock is fire-and-forget; give it a tick to land. */
const settle = () => new Promise((r) => setTimeout(r, 10));

/** The bodies of every knock the door received. */
function knocks(): unknown[] {
  return fetchSpy.mock.calls
    .filter(([url]) => String(url) === DOOR)
    .map(([, init]) => JSON.parse(String(init?.body)));
}

describe("a committed write knocks even when the event after it fails", () => {
  it("archiveProperty: archived, the event throws — the site is still told", async () => {
    const fake = use({
      properties: [
        { data: { id: PROPERTY_ID, reference: "PAF0001", visibility: "public", parent_id: null }, error: null },
        { data: [{ id: PROPERTY_ID }], error: null }, // the archive's row-count proof
      ],
      events: [EVENT_FAILS],
    });
    await expect(archiveProperty(PROPERTY_ID)).rejects.toBeInstanceOf(EventWriteError);
    await settle();
    expect(fake.argsOf("properties", "update")).toEqual([[{ visibility: "archived" }]]);
    expect(knocks()).toEqual([{ reference: "PAF0001" }]);
  });

  it("restoreProperty: a public withdrawn listing back on the market, the event throws — told", async () => {
    const fake = use({
      properties: [
        {
          data: { id: PROPERTY_ID, reference: "PAF0001", status: "withdrawn", visibility: "public", parent_id: null },
          error: null,
        },
        { data: [{ id: PROPERTY_ID }], error: null },
      ],
      events: [EVENT_FAILS],
    });
    await expect(restoreProperty(PROPERTY_ID)).rejects.toBeInstanceOf(EventWriteError);
    await settle();
    expect(fake.argsOf("properties", "update")).toEqual([[{ status: "available" }]]);
    expect(knocks()).toEqual([{ reference: "PAF0001" }]);
  });

  it("updatePropertySection: a public listing's legal save, the deal-health refresh throws — told", async () => {
    const fake = use({
      properties: [
        {
          data: {
            id: PROPERTY_ID,
            org_id: "org-1",
            reference: "PAF0001",
            kind: "standalone",
            property_type: "apartment",
            status: "available",
            visibility: "public",
            title_deed_status: "pending",
            permit_status: "full",
            updated_at: "2026-10-14T08:00:00.000000+00:00",
          },
          error: null,
        },
        { data: [{ id: PROPERTY_ID }], error: null },
      ],
    });
    const form = new FormData();
    form.set("property_id", PROPERTY_ID);
    form.set("section", "legal");
    form.set("title_deed_status", "separate");
    form.set("permit_status", "full");
    await expect(updatePropertySection({ error: null, savedAt: null }, form)).rejects.toThrow(
      "the deal-health refresh failed",
    );
    await settle();
    expect(fake.argsOf("properties", "update")).toHaveLength(1);
    expect(knocks()).toEqual([{ reference: "PAF0001" }]);
  });

  it("setMediaCover: the cover set, the event throws — told", async () => {
    const fake = use({
      property_media: [
        { data: [{ id: "m-2" }], error: null }, // the new cover's row-count proof
        { data: null, error: null }, // the old cover cleared
      ],
      properties: [PUBLIC_LISTING],
      events: [EVENT_FAILS],
    });
    await expect(setMediaCover(PROPERTY_ID, "m-2")).rejects.toBeInstanceOf(EventWriteError);
    await settle();
    expect(fake.argsOf("property_media", "update")).toHaveLength(2);
    expect(knocks()).toEqual([{ reference: "PAF0001" }]);
  });

  it("setMediaAlt: the alt saved, the event throws — told", async () => {
    const fake = use({
      property_media: [
        { data: { alt: {} }, error: null },
        { data: [{ id: "m-1" }], error: null },
      ],
      properties: [PUBLIC_LISTING],
      events: [EVENT_FAILS],
    });
    await expect(setMediaAlt(PROPERTY_ID, "m-1", "A villa at dusk")).rejects.toBeInstanceOf(EventWriteError);
    await settle();
    expect(fake.argsOf("property_media", "update")).toEqual([[{ alt: { en: "A villa at dusk" } }]]);
    expect(knocks()).toEqual([{ reference: "PAF0001" }]);
  });

  it("moveMedia: both halves of the swap proven, the event throws — told", async () => {
    const fake = use({
      property_media: [
        {
          data: [
            { id: "m-1", sort_order: 0 },
            { id: "m-2", sort_order: 1 },
          ],
          error: null,
        },
        { data: [{ id: "m-2" }], error: null },
        { data: [{ id: "m-1" }], error: null },
      ],
      properties: [PUBLIC_LISTING],
      events: [EVENT_FAILS],
    });
    await expect(moveMedia(PROPERTY_ID, "m-2", "up")).rejects.toBeInstanceOf(EventWriteError);
    await settle();
    expect(fake.argsOf("property_media", "update")).toEqual([[{ sort_order: 0 }], [{ sort_order: 1 }]]);
    expect(knocks()).toEqual([{ reference: "PAF0001" }]);
  });

  it("deleteMediaBulk: rows and files gone, the second photo's event throws — told", async () => {
    const photo = (id: string) => ({
      id,
      kind: "photo",
      storage_path_original: `properties/${PROPERTY_ID}/original/${id}.jpg`,
      path_thumb: `properties/${PROPERTY_ID}/${id}_thumb.webp`,
      path_card: `properties/${PROPERTY_ID}/${id}_card.webp`,
      path_full: `properties/${PROPERTY_ID}/${id}_full.webp`,
      path_jpeg: null,
      is_cover: false,
      content_sha256: null,
    });
    const fake = use({
      property_media: [{ data: [photo("m-1"), photo("m-2")], error: null }],
      properties: [PUBLIC_LISTING],
      events: [{ data: null, error: null }, EVENT_FAILS], // the first line lands, the second fails
    });
    await expect(deleteMediaBulk(PROPERTY_ID, ["m-1", "m-2"])).rejects.toBeInstanceOf(EventWriteError);
    await settle();
    expect(fake.argsOf("property_media", "delete")).toHaveLength(1);
    expect(fake.argsOf("events", "insert")).toHaveLength(2);
    expect(knocks()).toEqual([{ reference: "PAF0001" }]);
  });

  it("syncInheritedField: a public unit among those synced, the events throw — every listing told", async () => {
    const fake = use({
      properties: [
        { data: { id: "proj-1", kind: "project", reference: "PAF0009", vat_status: "new_vat" }, error: null },
        {
          data: [
            { id: "unit-1", reference: "PAF0009-A1", visibility: "private" },
            { id: "unit-2", reference: "PAF0009-A2", visibility: "public" },
          ],
          error: null,
        },
      ],
      events: [EVENT_FAILS],
    });
    await expect(syncInheritedField("proj-1", "vat_status")).rejects.toBeInstanceOf(EventWriteError);
    await settle();
    expect(fake.argsOf("properties", "update")).toEqual([[{ vat_status: "new_vat" }]]);
    expect(fake.argsOf("properties", "select")[1], "the write's own answer carries visibility").toEqual([
      "id, reference, visibility",
    ]);
    expect(knocks()).toEqual([{ scope: "listings" }]);
  });

  it("renameArea: renamed, the event throws — every listing told", async () => {
    const fake = use({
      areas: [
        { data: { name: { en: "Kato Pafos", el: "Κάτω Πάφος" } }, error: null },
        { data: [{ id: AREA_ID }], error: null },
      ],
      events: [EVENT_FAILS],
    });
    await expect(renameArea(AREA_ID, "Kato Paphos")).rejects.toBeInstanceOf(EventWriteError);
    await settle();
    expect(fake.argsOf("areas", "update")).toEqual([[{ name: { en: "Kato Paphos", el: "Κάτω Πάφος" } }]]);
    expect(knocks()).toEqual([{ scope: "listings" }]);
  });
});

describe("no knock where nothing the site shows moved", () => {
  it("syncInheritedField over private units only: synced and recorded, the site not told", async () => {
    use({
      properties: [
        { data: { id: "proj-1", kind: "project", reference: "PAF0009", vat_status: "new_vat" }, error: null },
        {
          data: [
            { id: "unit-1", reference: "PAF0009-A1", visibility: "private" },
            { id: "unit-2", reference: "PAF0009-A2", visibility: "coming_soon" },
          ],
          error: null,
        },
      ],
    });
    await expect(syncInheritedField("proj-1", "vat_status")).resolves.toMatchObject({ error: null, synced: 2 });
    await settle();
    expect(knocks()).toEqual([]);
  });

  it("renameArea refused by RLS (no row): no knock, no event", async () => {
    const fake = use({
      areas: [
        { data: { name: { en: "Kato Pafos" } }, error: null },
        { data: [], error: null },
      ],
    });
    await expect(renameArea(AREA_ID, "Kato Paphos")).resolves.toEqual({
      error: "You do not have permission to rename areas.",
    });
    await settle();
    expect(knocks()).toEqual([]);
    expect(fake.argsOf("events", "insert")).toEqual([]);
  });
});
