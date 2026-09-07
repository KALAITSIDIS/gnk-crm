import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { STALE_MESSAGE, NOT_RECORDED_NOTICE } from "@/lib/services/optimistic-save";

/**
 * The half of the optimistic save (A06) that no other test can reach.
 *
 * `lib/services/optimistic-save.test.ts` pins the pure predicate, and
 * `tests/e2e/optimistic-save.spec.ts` drives the read-time refusal through the
 * real form and the real trigger — but it can only ever reach THAT window: its
 * stale save is refused before any work, and its reloaded save is stopped by
 * the publish gate, which sits before the UPDATE. So the second window (the
 * `.eq("updated_at", expected)` on the write), the re-read that distinguishes
 * "the row moved" from "RLS refused you", and the "saved but not recorded"
 * notice were three claims nothing could fail for. This file is what fails for
 * them.
 *
 * The `marketing` section on purpose: no publish gate, no health score, no
 * match alerts — the shortest path from the read to the write, which is the
 * part under test.
 */
const state = vi.hoisted(() => ({ pages: {} as Record<string, FakePage[]>, client: null as unknown }));
const logEvent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/services/quality-score", () => ({
  recomputeQuietly: vi.fn(async () => undefined),
  refreshContainerScores: vi.fn(async () => undefined),
  computeQualityScore: vi.fn(() => ({ score: 100, items: [], missing: [], warnings: [] })),
  PUBLISH_THRESHOLD: 70,
}));

const { updatePropertySection } = await import("@/lib/actions/properties");

const T1 = "2026-09-06T17:04:11.482913+00:00";
const T2 = "2026-09-06T17:09:52.001004+00:00";

/** The row as the page rendered it: a marketing save changes the title. */
const currentRow = (updated_at: string) => ({
  id: "prop-1",
  org_id: "org-1",
  kind: "standalone",
  property_type: "apartment",
  status: "available",
  visibility: "private",
  updated_at,
  title: { en: "Before" },
  short_description: {},
  adviser_view: {},
  public_description: {},
});

const form = (expected: string | null, title = "After") => {
  const fd = new FormData();
  fd.set("property_id", "prop-1");
  fd.set("section", "marketing");
  fd.set("title_en", title);
  if (expected) fd.set("expected_updated_at", expected);
  return fd;
};

/** Script the properties table's answers in the order the action asks for them. */
function setup(pages: FakePage[]) {
  const fake = fakeClient({ properties: pages });
  state.pages = { properties: pages };
  state.client = fake.client;
  return fake;
}

beforeEach(() => {
  logEvent.mockClear();
  logEvent.mockImplementation(async () => undefined);
});

describe("the write is predicated on the row the page rendered (A06, second window)", () => {
  it("sends .eq('updated_at', expected) with the UPDATE — the milliseconds the read cannot cover", async () => {
    const fake = setup([
      { data: currentRow(T1), error: null }, // the read
      { data: [{ id: "prop-1" }], error: null }, // the predicated UPDATE, one row
    ]);
    const res = await updatePropertySection({ error: null, savedAt: null }, form(T1));
    expect(res.error).toBeNull();
    expect(res.savedAt).not.toBeNull();
    const eqs = fake.argsOf("properties", "eq");
    expect(eqs, "the UPDATE carries both the id and the expectation").toEqual(
      expect.arrayContaining([
        ["id", "prop-1"],
        ["updated_at", T1],
      ]),
    );
    expect(fake.argsOf("properties", "update")).toHaveLength(1);
  });

  it("sends NO predicate when the form carried no expectation — a page rendered before this shipped still saves", async () => {
    const fake = setup([
      { data: currentRow(T1), error: null },
      { data: [{ id: "prop-1" }], error: null },
    ]);
    const res = await updatePropertySection({ error: null, savedAt: null }, form(null));
    expect(res.error).toBeNull();
    // the read and the UPDATE each key on the id; what must be absent is the
    // expectation — with nothing to compare, the write is unpredicated
    const eqs = fake.argsOf("properties", "eq");
    expect(eqs.every(([col]) => col === "id")).toBe(true);
    expect(eqs.map(([col]) => col)).not.toContain("updated_at");
  });

  it("refuses at the READ when the row already moved, before touching anything", async () => {
    const fake = setup([{ data: currentRow(T2), error: null }]);
    const res = await updatePropertySection({ error: null, savedAt: null }, form(T1));
    expect(res).toEqual({ error: STALE_MESSAGE, savedAt: null });
    expect(fake.argsOf("properties", "update"), "nothing was written").toHaveLength(0);
  });
});

describe("zero rows from the predicated UPDATE says WHICH — the two need different actions", () => {
  it("the row moved between the read and the write: reload, not 'not assigned to you'", async () => {
    setup([
      { data: currentRow(T1), error: null }, // read
      { data: [], error: null }, // predicated UPDATE matched nothing
      { data: { updated_at: T2 }, error: null }, // the re-read: it moved
    ]);
    const res = await updatePropertySection({ error: null, savedAt: null }, form(T1));
    expect(res).toEqual({ error: STALE_MESSAGE, savedAt: null });
  });

  it("the row did not move, so it was RLS: the message names assignment, not staleness", async () => {
    setup([
      { data: currentRow(T1), error: null },
      { data: [], error: null },
      { data: { updated_at: T1 }, error: null }, // unchanged — the update was filtered
    ]);
    const res = await updatePropertySection({ error: null, savedAt: null }, form(T1));
    expect(res.savedAt).toBeNull();
    expect(res.error).toContain("isn't assigned to you");
    expect(res.error).not.toBe(STALE_MESSAGE);
  });

  it("with no expectation, zero rows can only be RLS — and it does not re-read to ask", async () => {
    const fake = setup([
      { data: currentRow(T1), error: null },
      { data: [], error: null },
    ]);
    const res = await updatePropertySection({ error: null, savedAt: null }, form(null));
    expect(res.error).toContain("isn't assigned to you");
    // read + update only: the third await would be the re-read
    expect(fake.served.properties).toBe(2);
  });
});

describe("saved but not recorded (T-event-integrity's fifteenth instance)", () => {
  it("reports the save as SAVED with a notice when the event insert fails after a committed write", async () => {
    logEvent.mockImplementation(async () => {
      throw new Error("events insert failed");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    setup([
      { data: currentRow(T1), error: null },
      { data: [{ id: "prop-1" }], error: null },
    ]);
    const res = await updatePropertySection({ error: null, savedAt: null }, form(T1));
    // NOT an error: the row changed, and telling the person it failed invites a
    // retry of a write that already happened.
    expect(res.error).toBeNull();
    expect(res.savedAt).not.toBeNull();
    expect(res.notice).toBe(NOT_RECORDED_NOTICE);
  });

  it("carries no notice when the event was written", async () => {
    setup([
      { data: currentRow(T1), error: null },
      { data: [{ id: "prop-1" }], error: null },
    ]);
    const res = await updatePropertySection({ error: null, savedAt: null }, form(T1));
    expect(res.notice).toBeNull();
    expect(logEvent).toHaveBeenCalledTimes(1);
  });
});
