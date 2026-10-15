import * as Sentry from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EventWriteError } from "@/lib/services/events";
import { NOT_RECORDED_NOTICE } from "@/lib/services/optimistic-save";
import { fakeClient, type FakeCall, type FakePage } from "@/lib/testing/fake-client";

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
 * `fetch` here — the door's stand-in. Each case asserts that the action
 * answers as it did before — it still throws where a follow-up throws (the
 * error is theirs to report, BACKLOG "A committed photo delete, archive or
 * sold/rented save…") — that the write happened, and that ONE knock named
 * what moved.
 *
 * The review round added the other paths a committed write takes: a set
 * cover whose old cover could not be cleared (an answered error, not a
 * throw), a delete whose admin client cannot be built, a publish (whose lines
 * `record` catches), a sold save whose listing check throws — and a save that
 * must NOT knock.
 *
 * site-revalidate-callsites.test.ts pins the same order in the source for
 * every action that knocks; this file is where it is seen.
 */
const state = vi.hoisted(() => ({
  caller: null as unknown,
  /** the system client's tables (completeListingStatusChecks closes its tasks through it) */
  admin: null as null | { from: (table: string) => unknown },
  /** build the REAL admin client instead of the stand-in — it throws when unconfigured */
  adminReal: false,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return {
    createAdminClient: () => {
      if (state.adminReal) return real.createAdminClient();
      return {
        from: (table: string) => {
          if (!state.admin) throw new Error(`the admin client was asked for ${table} with none scripted`);
          return state.admin.from(table);
        },
        storage: {
          from: () => ({
            remove: async (paths: string[]) => ({ data: paths.map((name) => ({ name })), error: null }),
            exists: async () => ({ data: false, error: null }),
          }),
        },
      };
    },
  };
});
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
// the photo ids posted to deleteMediaBulk: guid-shaped, as the action refuses
// a malformed one before any read (T-malformed-ids)
const PHOTO_1 = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c11";
const PHOTO_2 = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c12";
const AREA_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c02";
/** the event insert answers a database error: the real logEvent throws */
const EVENT_FAILS: FakePage = { data: null, error: { message: "Fixture: the events insert failed", code: "XX000" } };
const PUBLIC_LISTING: FakePage = { data: { reference: "PAF0001", visibility: "public" }, error: null };

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  state.admin = null;
  state.adminReal = false;
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

/** A photograph row as the delete's `.select()` returns it. */
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

const UPDATED_AT = "2026-10-14T08:00:00.000000+00:00";

/** The stored row a Details save starts from: a flat (property-measurements.test.ts's shape). */
const storedFlat = (over: { status?: string; visibility: string }) => ({
  id: PROPERTY_ID,
  org_id: "org-1",
  reference: "PAF0004",
  kind: "standalone",
  property_type: "apartment",
  status: "available",
  transaction_type: "sale",
  vat_status: "unknown",
  updated_at: UPDATED_AT,
  area_id: null,
  address: null,
  postal_code: null,
  location: null,
  location_approx: false,
  sea_distance_m: null,
  amenities_notes: null,
  asking_price: 250000,
  min_acceptable_price: null,
  owner_net_price: null,
  rent_price_month: null,
  covered_area_sqm: 92,
  plot_area_sqm: null,
  veranda_sqm: null,
  roof_garden_sqm: null,
  basement_sqm: null,
  bedrooms: 2,
  bathrooms: 1,
  wc: null,
  parking_spaces: null,
  has_storage: false,
  floor_number: 2,
  total_floors: 4,
  year_built: null,
  energy_class: null,
  features: [],
  construction_status: null,
  delivery_date: null,
  internal_notes: null,
  inherited_fields: null,
  parent_id: null,
  ...over,
});

/** What the Details form posts: every field re-posted from the row unless overridden. */
function detailsForm(over: Record<string, string>) {
  const fd = new FormData();
  const posted: Record<string, string> = {
    property_id: PROPERTY_ID,
    section: "details",
    expected_updated_at: UPDATED_AT,
    status: "available",
    visibility: "private",
    transaction_type: "sale",
    vat_status: "unknown",
    asking_price: "250000",
    covered_area_sqm: "92",
    plot_area_sqm: "",
    bedrooms: "2",
    bathrooms: "1",
    floor_number: "2",
    total_floors: "4",
    ...over,
  };
  for (const [k, v] of Object.entries(posted)) fd.set(k, v);
  return fd;
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

  it("updatePropertySection: a private listing published (an admin's override), its timeline lines fail — told", async () => {
    // the publish half of the condition: the row WAS private, so only the
    // visibility being written says the site has a page to add
    const fake = use({
      properties: [
        { data: storedFlat({ visibility: "private" }), error: null },
        { data: [{ id: PROPERTY_ID }], error: null },
      ],
      events: [EVENT_FAILS, EVENT_FAILS], // the override's line and the update's, both caught by `record`
    });
    const res = await updatePropertySection(
      { error: null, savedAt: null },
      detailsForm({ visibility: "public", publish_override: "on" }),
    );
    await settle();
    expect(res).toMatchObject({ error: null, notice: NOT_RECORDED_NOTICE });
    expect(fake.argsOf("properties", "update")[0]).toEqual([expect.objectContaining({ visibility: "public" })]);
    expect(
      fake.argsOf("events", "insert").map(([row]) => (row as { event_type: string }).event_type),
      "the gate was cleared by the override, then the save recorded — both lines tried",
    ).toEqual(["publish_override", "updated"]);
    expect(knocks()).toEqual([{ reference: "PAF0004" }]);
  });

  it("updatePropertySection: a public listing sold, the listing check's superseded line fails — told", async () => {
    // BACKLOG's own scenario: the save closes the check a won deal raised
    // (completeListingStatusChecks, through the system client), cannot write
    // that check's line, and throws — after the status has committed
    const fake = use({
      properties: [
        { data: storedFlat({ visibility: "public" }), error: null },
        { data: [{ id: PROPERTY_ID }], error: null },
      ],
      events: [{ data: null, error: null }, EVENT_FAILS], // the update's line lands; the check's does not
    });
    const system = fakeClient({ tasks: [{ data: [{ id: "task-1" }], error: null }] });
    state.admin = system.client;
    await expect(
      updatePropertySection({ error: null, savedAt: null }, detailsForm({ visibility: "public", status: "sold" })),
    ).rejects.toThrow("a closed check's superseded line was not written");
    await settle();
    expect(fake.argsOf("properties", "update")[0]).toEqual([expect.objectContaining({ status: "sold" })]);
    expect(system.argsOf("tasks", "update"), "the check was closed").toHaveLength(1);
    expect(knocks()).toEqual([{ reference: "PAF0004" }]);
  });

  it("setMediaCover: the set and the clear run back to back — the listing is looked up after both, before the event", async () => {
    // a read between them would widen the window in which the listing has two
    // covers, and in which two people setting different covers at once each
    // clear the other's
    const fake = use({
      property_media: [
        { data: [{ id: "m-2" }], error: null },
        { data: null, error: null },
      ],
      properties: [PUBLIC_LISTING],
      events: [EVENT_FAILS],
    });
    await expect(setMediaCover(PROPERTY_ID, "m-2")).rejects.toBeInstanceOf(EventWriteError);
    const at = (pick: (c: FakeCall) => boolean) => fake.calls.findIndex(pick);
    const coverFlag = (c: FakeCall) => (c.method === "update" ? (c.args[0] as { is_cover?: boolean }).is_cover : undefined);
    const set = at((c) => coverFlag(c) === true);
    const clear = at((c) => coverFlag(c) === false);
    const lookup = at((c) => c.table === "properties");
    const event = at((c) => c.table === "events");
    expect(set).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(set);
    expect(
      fake.calls.slice(set, clear).map((c) => c.table),
      "nothing but the photographs is asked between the set and the clear",
    ).toEqual(fake.calls.slice(set, clear).map(() => "property_media"));
    expect(lookup, "the listing is looked up once both have answered").toBeGreaterThan(clear);
    expect(lookup, "and before the event that can throw").toBeLessThan(event);
  });

  it("setMediaCover: the old cover cannot be cleared — the error is answered, and the site is still told", async () => {
    // the NEW cover has committed: the site shows it first whatever the clear did
    const fake = use({
      property_media: [
        { data: [{ id: "m-2" }], error: null },
        { data: null, error: { message: "Fixture: the clear failed", code: "XX000" } },
      ],
      properties: [PUBLIC_LISTING],
    });
    await expect(setMediaCover(PROPERTY_ID, "m-2")).resolves.toEqual({ error: "Fixture: the clear failed" });
    await settle();
    expect(fake.argsOf("property_media", "update")).toHaveLength(2);
    expect(fake.argsOf("events", "insert"), "the action answered the error before its event").toEqual([]);
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
    const fake = use({
      property_media: [{ data: [photo(PHOTO_1), photo(PHOTO_2)], error: null }],
      properties: [PUBLIC_LISTING],
      events: [{ data: null, error: null }, EVENT_FAILS], // the first line lands, the second fails
    });
    await expect(deleteMediaBulk(PROPERTY_ID, [PHOTO_1, PHOTO_2])).rejects.toBeInstanceOf(EventWriteError);
    await settle();
    expect(fake.argsOf("property_media", "delete")).toHaveLength(1);
    expect(fake.argsOf("events", "insert")).toHaveLength(2);
    expect(knocks()).toEqual([{ reference: "PAF0001" }]);
  });

  it("deleteMediaBulk: the rows gone, the admin client cannot be built (no service key) — told", async () => {
    // the REAL createAdminClient: supabase-js refuses to construct a client
    // without its url or key, and it is built after the delete has committed
    state.adminReal = true;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fake = use({
      property_media: [{ data: [photo(PHOTO_1)], error: null }],
      properties: [PUBLIC_LISTING],
    });
    await expect(deleteMediaBulk(PROPERTY_ID, [PHOTO_1])).rejects.toThrow(/is required/);
    await settle();
    expect(fake.argsOf("property_media", "delete")).toHaveLength(1);
    expect(knocks()).toEqual([{ reference: "PAF0001" }]);
  });

  it("syncInheritedField: a public unit among those synced, the events throw — every listing told", async () => {
    // the public unit neither first nor last: the gate asks of EVERY row the
    // write returned, in whatever order the database returned them
    const fake = use({
      properties: [
        { data: { id: "proj-1", kind: "project", reference: "PAF0009", vat_status: "new_vat" }, error: null },
        {
          data: [
            { id: "unit-1", reference: "PAF0009-A1", visibility: "private" },
            { id: "unit-2", reference: "PAF0009-A2", visibility: "public" },
            { id: "unit-3", reference: "PAF0009-A3", visibility: "coming_soon" },
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
  it("updatePropertySection: a private listing's save that keeps it private — recorded, the site not told", async () => {
    const fake = use({
      properties: [
        { data: storedFlat({ visibility: "private" }), error: null },
        { data: [{ id: PROPERTY_ID }], error: null },
      ],
    });
    await expect(
      updatePropertySection({ error: null, savedAt: null }, detailsForm({ bedrooms: "3" })),
    ).resolves.toMatchObject({ error: null, notice: null });
    await settle();
    expect(fake.argsOf("properties", "update")[0]).toEqual([expect.objectContaining({ bedrooms: 3 })]);
    expect(fake.argsOf("events", "insert"), "the save was recorded").toHaveLength(1);
    expect(knocks()).toEqual([]);
  });

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
