import * as Sentry from "@sentry/nextjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * A committed media save stays saved when the site cannot be told.
 *
 * Each media action ends by asking the database whether the listing is public
 * and, if so, knocking on the marketing site. Both steps come AFTER the row is
 * written, and neither may turn that write into a failure the desk sees: the
 * photograph IS on the listing, whatever the database, the site or Sentry did
 * next. lib/services/site-revalidate.test.ts proves the helper's own outcomes;
 * this proves them from the action's side with the REAL helper in the chain —
 * a mocked notifier (media-upload-renditions.test.ts) cannot fail, so it
 * cannot prove that the save survives one that does.
 *
 * setMediaAlt is the action under test because it is the lightest: no
 * storage, no admin client, no score — a read, a row-count-proved update, an
 * event, then the notifier.
 */
const state = vi.hoisted(() => ({ caller: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("setMediaAlt never needs the admin client");
  },
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "u-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/services/quality-score", () => ({ recomputeQualityScore: vi.fn(async () => null) }));
vi.mock("@/lib/services/storage", () => ({ removeObjectsBestEffort: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
// Deliberately NOT mocked: @/lib/services/site-revalidate. That is the point.

const { setMediaAlt } = await import("@/lib/actions/media");

const OLD = { ...process.env };
const DB_ERROR = { code: "XX000", message: "Fixture database error" };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(Sentry.captureMessage).mockReset();
  // Armed: a knock the action sends will be seen, not skipped for want of a key.
  process.env = {
    ...OLD,
    SITE_REVALIDATE_URL: "https://site.example/api/revalidate",
    SITE_REVALIDATE_KEY: "k-secret",
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** The alt save succeeds; the listing lookup that follows answers `listing`. */
function harness(listing: FakePage) {
  const caller = fakeClient({
    property_media: [
      { data: { alt: {} }, error: null }, // the current alt, read first
      { data: [{ id: "m-1" }], error: null }, // the update's row-count proof
    ],
    properties: [listing],
  });
  state.caller = caller.client;
  return { caller, run: () => setMediaAlt("prop-1", "m-1", "A villa at dusk") };
}

/** The knock is fire-and-forget; give it a tick to land. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("a media save outlives a failed site notification", () => {
  it("the lookup returns a database error: saved, reported once, and the site is not knocked", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const h = harness({ data: null, error: DB_ERROR });
    await expect(h.run()).resolves.toEqual({ error: null });
    await settle();
    expect(h.caller.argsOf("property_media", "update"), "the write happened").toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(Sentry.captureMessage).mock.calls[0]![0])).toContain("site-revalidate");
  });

  it("Sentry itself throws on that report: still saved", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    vi.mocked(Sentry.captureMessage).mockImplementation(() => {
      throw new Error("sentry down");
    });
    const h = harness({ data: null, error: DB_ERROR });
    await expect(h.run()).resolves.toEqual({ error: null });
  });

  it("the listing is public and the site is unreachable: still saved, and one knock was tried", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const h = harness({ data: { reference: "PAF0001", visibility: "public" }, error: null });
    await expect(h.run()).resolves.toEqual({ error: null });
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage, "a lookup that worked is not a lookup failure").not.toHaveBeenCalled();
  });
});
