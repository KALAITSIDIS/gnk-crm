import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * The create path's "saved but not recorded" (audit 2026-09-13, OPS-01).
 *
 * `createProperty` inserts the row, then writes its `created` event, then
 * redirects. Until 2026-09-13 a failed event insert THREW out of the action:
 * the row existed with a burned reference, the wizard showed a failure, and
 * the natural retry made a second listing. The write is real and stays; the
 * action now lands on the new record with `?recorded=failed`, the page says the
 * timeline has a hole, and nobody is invited to resubmit a submit that
 * happened. Same shape as updatePropertySection's fifteenth instance
 * (DECISIONS T-event-integrity); this is the sixteenth, and the one where a
 * retry costs the most.
 */
const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() => vi.fn(async () => undefined));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent, logEvents: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/services/reference", () => ({ generateReference: async () => "PAF0099" }));
vi.mock("@/lib/services/site-revalidate", () => ({ notifySiteAfter: vi.fn() }));
vi.mock("@/lib/services/quality-score", () => ({
  recomputeQuietly: vi.fn(async () => undefined),
  refreshContainerScores: vi.fn(async () => undefined),
  computeQualityScore: vi.fn(() => ({ score: 0, items: [], missing: [], warnings: [] })),
  buildQualityInput: vi.fn(() => ({})),
  PUBLISH_THRESHOLD: 70,
}));

const { createProperty } = await import("@/lib/actions/properties");

const DISTRICT = "6f1d2c3b-4a5e-4f60-9a7b-8c9d0e1f2a3b";

function form() {
  const fd = new FormData();
  fd.set("kind", "standalone");
  fd.set("property_type", "apartment");
  fd.set("transaction_type", "sale");
  fd.set("district_id", DISTRICT);
  fd.set("title_en", "Audit flat");
  return fd;
}

/** districts is read once for the code; properties is inserted once. */
function setup(extra: Partial<Record<string, FakePage[]>> = {}) {
  const fake = fakeClient({
    districts: [{ data: { code: "PAF" }, error: null }],
    properties: [{ data: { id: "prop-1" }, error: null }],
    ...extra,
  });
  state.client = fake.client;
  return fake;
}

beforeEach(() => {
  logEvent.mockReset();
  logEvent.mockImplementation(async () => undefined);
  redirect.mockClear();
});

describe("createProperty and its created event", () => {
  it("lands on the new record with ?recorded=failed when the event insert fails after the row committed", async () => {
    logEvent.mockImplementation(async () => {
      throw new Error("events insert failed");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setup();
    // NOT a thrown failure: the row exists and telling the person it failed
    // invites a resubmit that makes a second listing with a second reference.
    await expect(createProperty({ error: null }, form())).rejects.toThrow(
      "REDIRECT /properties/prop-1?recorded=failed",
    );
    expect(err).toHaveBeenCalledWith(expect.stringContaining("saved but not recorded"), expect.anything());
    err.mockRestore();
  });

  it("lands on the new record with a clean URL when the event was written", async () => {
    setup();
    await expect(createProperty({ error: null }, form())).rejects.toThrow(/REDIRECT \/properties\/prop-1$/);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("still refuses before anything is written when the insert itself fails", async () => {
    setup({ properties: [{ data: null, error: { message: "duplicate registration" } }] });
    const res = await createProperty({ error: null }, form());
    expect(res.error).toBe("duplicate registration");
    expect(logEvent).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
