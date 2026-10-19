import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * F02: storage room has ONE value — the 'storage_room' key in `features` — and
 * `has_storage` is its mirror. Here at the level the product uses it, the
 * Details save (a schema that only its own tests call validates nothing — the
 * operator's standing rule): what the form posts, what the action asks the
 * database to write, and what its `updated` event records. The database half
 * (0152's trigger, every other writer, the feed) is
 * supabase/tests/storage-room-one-value.test.ts.
 */
const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);
const logEvents = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent, logEvents }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/services/site-revalidate", () => ({ notifySiteAfter: vi.fn() }));
vi.mock("@/lib/services/quality-score", () => ({
  recomputeQuietly: vi.fn(async () => undefined),
  refreshContainerScores: vi.fn(async () => undefined),
  computeQualityScore: vi.fn(() => ({ score: 100, items: [], missing: [], warnings: [] })),
  PUBLISH_THRESHOLD: 70,
}));

const { updatePropertySection } = await import("@/lib/actions/properties");
const { detailsSectionSchema } = await import("@/lib/validators/properties");
const { FEATURE_KEYS, STORAGE_FEATURE, featureLabel, hasStorageRoom } = await import(
  "@/lib/constants/features"
);

const UPDATED_AT = "2026-10-18T09:00:00.000000+00:00";

/** The stored row the Details page rendered. */
function stored(over: Record<string, unknown>) {
  return {
    id: "prop-1",
    org_id: "org-1",
    reference: "PAF0004",
    kind: "standalone",
    property_type: "apartment",
    status: "available",
    visibility: "private",
    transaction_type: "sale",
    vat_status: "unknown",
    updated_at: UPDATED_AT,
    location: null,
    location_approx: false,
    has_storage: false,
    features: [],
    inherited_fields: null,
    parent_id: null,
    ...over,
  };
}

/** What the Details form posts; `features` repeats, one entry per ticked box. */
function detailsForm(over: Record<string, string>, features: string[]) {
  const fd = new FormData();
  const posted: Record<string, string> = {
    property_id: "prop-1",
    section: "details",
    expected_updated_at: UPDATED_AT,
    status: "available",
    visibility: "private",
    transaction_type: "sale",
    vat_status: "unknown",
    ...over,
  };
  for (const [k, v] of Object.entries(posted)) fd.set(k, v);
  for (const f of features) fd.append("features", f);
  return fd;
}

function setup(row: Record<string, unknown>) {
  const pages: FakePage[] = [
    { data: row, error: null }, // the read
    { data: [{ id: "prop-1" }], error: null }, // the UPDATE, one row
  ];
  const fake = fakeClient({ properties: pages });
  state.client = fake.client;
  return fake;
}

function updatedEvent() {
  const e = logEvent.mock.calls.map((c) => c[1]).find((x) => x.eventType === "updated");
  expect(e, "the save logged an `updated` event").toBeDefined();
  return (e!.payload as { changed: Record<string, unknown> }).changed;
}

beforeEach(() => {
  logEvent.mockClear();
  logEvents.mockClear();
});

describe("the one value: the Features key", () => {
  it("STORAGE_FEATURE is a real feature key, the box labelled 'Storage room'", () => {
    expect(STORAGE_FEATURE).toBe("storage_room");
    expect(FEATURE_KEYS).toContain(STORAGE_FEATURE);
    expect(featureLabel(STORAGE_FEATURE)).toBe("Storage room");
  });

  it("hasStorageRoom reads the key and nothing else", () => {
    expect(hasStorageRoom([])).toBe(false);
    expect(hasStorageRoom(["storage_room"])).toBe(true);
    expect(hasStorageRoom(["sea_view", "storage_room"])).toBe(true);
    expect(hasStorageRoom(["storage", "Storage room", "storage_rooms"])).toBe(false);
  });

  it("the details schema no longer carries has_storage: a stale form's box is dropped, not parsed", () => {
    const parsed = detailsSectionSchema.safeParse({
      status: "available",
      visibility: "private",
      transaction_type: "sale",
      vat_status: "unknown",
      has_storage: "on",
      features: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("has_storage");
  });
});

describe("updatePropertySection (details) writes has_storage from the feature, and records both", () => {
  it("ticking the Features box: features gains the key, has_storage false → true, both in the event", async () => {
    const fake = setup(stored({}));
    const res = await updatePropertySection({ error: null, savedAt: null }, detailsForm({}, ["storage_room"]));
    expect(res.error).toBeNull();
    const [payload] = fake.argsOf("properties", "update")[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({ features: ["storage_room"], has_storage: true });
    const changed = updatedEvent();
    expect(changed.features).toEqual({ from: [], to: ["storage_room"] });
    expect(changed.has_storage).toEqual({ from: false, to: true });
  });

  it("unticking it: both go false together", async () => {
    const fake = setup(stored({ has_storage: true, features: ["sea_view", "storage_room"] }));
    const res = await updatePropertySection({ error: null, savedAt: null }, detailsForm({}, ["sea_view"]));
    expect(res.error).toBeNull();
    const [payload] = fake.argsOf("properties", "update")[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({ features: ["sea_view"], has_storage: false });
    const changed = updatedEvent();
    expect(changed.has_storage).toEqual({ from: true, to: false });
  });

  it("a stale form posting has_storage=on with no feature writes has_storage false — the old box decides nothing", async () => {
    const fake = setup(stored({ has_storage: false, features: ["garden"] }));
    const res = await updatePropertySection(
      { error: null, savedAt: null },
      detailsForm({ has_storage: "on", bedrooms: "2" }, ["garden"]),
    );
    expect(res.error).toBeNull();
    const [payload] = fake.argsOf("properties", "update")[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({ has_storage: false, features: ["garden"], bedrooms: 2 });
    const changed = updatedEvent();
    expect(changed).not.toHaveProperty("has_storage");
    expect(changed).not.toHaveProperty("features");
  });

  it("a row whose two values disagree (written before 0152) is brought into step by its next Details save, and the event says which way", async () => {
    // PAF0004's shape: the column true, the feature absent
    const fake = setup(stored({ has_storage: true, features: ["sea_view"] }));
    const res = await updatePropertySection({ error: null, savedAt: null }, detailsForm({}, ["sea_view"]));
    expect(res.error).toBeNull();
    const [payload] = fake.argsOf("properties", "update")[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({ has_storage: false, features: ["sea_view"] });
    expect(updatedEvent().has_storage).toEqual({ from: true, to: false });
  });

  it("nothing moved: no write and no event (the mirror never manufactures a change)", async () => {
    const fake = setup(stored({ has_storage: true, features: ["storage_room"] }));
    const res = await updatePropertySection({ error: null, savedAt: null }, detailsForm({}, ["storage_room"]));
    expect(res.error).toBeNull();
    expect(res.savedAt).not.toBeNull();
    expect(fake.argsOf("properties", "update")).toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });
});
