import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * Saving a viewing's feedback logs WHICH viewing and the RATING — never what
 * the buyer said (audit SEC-03, DECISIONS T-viewing-feedback-shape).
 *
 * `liked`, `disliked` and `comment` are a buyer's own words about a property,
 * typed by the agent, often naming people ("Her husband Andreas wants a
 * bigger garden"). Until this change `saveViewingFeedback` spread the whole
 * feedback object into the hash-chained `viewing_feedback` event on the
 * PROPERTY, where neither erasure nor a correction can reach it, and where a
 * property-scoped evidence PDF printed every buyer's words. The viewing ROW
 * keeps them (`viewings.feedback`, overwritten by every save); the property
 * timeline reads them from there, labelled as current
 * (lib/services/event-context.ts).
 *
 * `logEvent` is NOT mocked: the real action calls the real logger, and the
 * assertions read the row that reached `events.insert` — the exact bytes the
 * chain would hash. Transport is lib/testing/fake-client.ts.
 */

const state = vi.hoisted(() => ({ client: null as unknown, role: "agent" as string }));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "agent-1", orgId: "org-1", role: state.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { saveViewingFeedback } = await import("@/lib/actions/viewings");

const VIEWING_ID = "5c0ffee0-1111-4111-8111-111111111111";
const PROPERTY_ID = "9a9a9a9a-2222-4222-8222-222222222222";
// synthetic: a name, a phone number, an address and the buyer's opinions — none may reach the chain
const LIKED = "Zenobia Quillfeather loved the sea view from the terrace";
const DISLIKED = "Kitchen too small for Andreas Test-Papadopoulos, call 99 000 111";
const COMMENT = "Will offer after speaking to zq.test@example.invalid, second visit Friday";
const WORDS = ["Zenobia", "Quillfeather", "terrace", "Andreas", "Papadopoulos", "99 000 111", "zq.test", "second visit"];

const viewing = (over: Record<string, unknown> = {}) => ({
  id: VIEWING_ID,
  org_id: "org-1",
  agent_id: "agent-1",
  status: "completed",
  property_id: PROPERTY_ID,
  properties: { reference: "PAF0001" },
  ...over,
});

function form(fields: Record<string, string> = {}) {
  const fd = new FormData();
  const all = { viewing_id: VIEWING_ID, rating: "4", liked: LIKED, disliked: DISLIKED, comment: COMMENT, ...fields };
  for (const [k, v] of Object.entries(all)) fd.set(k, v);
  return fd;
}

/** the viewing read, then the proven update */
function save(pages: { read: FakePage; update?: FakePage }, fields?: Record<string, string>) {
  const fake = fakeClient({ viewings: [pages.read, ...(pages.update ? [pages.update] : [])] });
  state.client = fake.client;
  return { fake, result: saveViewingFeedback({ error: null, savedAt: null }, form(fields)) };
}

const updatedOne = { data: [{ id: VIEWING_ID }], error: null };

/** every row the real logEvent handed to `events.insert` */
const inserted = (fake: ReturnType<typeof fakeClient>) =>
  fake.argsOf("events", "insert").map((args) => args[0] as Record<string, unknown>);

beforeEach(() => {
  state.client = null;
  state.role = "agent";
});

describe("saveViewingFeedback logs the act and the rating, not the buyer's words", () => {
  it("the ROW keeps all four fields; ONE viewing_feedback event names the viewing and carries the rating", async () => {
    const { fake, result } = save({ read: { data: viewing(), error: null }, update: updatedOne });
    expect((await result).error).toBeNull();

    // the source record still receives every word — it is the one home the text has
    expect(fake.argsOf("viewings", "update")).toEqual([
      [{ feedback: { rating: 4, liked: LIKED, disliked: DISLIKED, comment: COMMENT } }],
    ]);
    // the UPDATE itself names THIS viewing — only filters chained after it count
    // (the read before it carries the same eq, so membership alone proves nothing)
    const viewingCalls = fake.calls.filter((c) => c.table === "viewings");
    const afterUpdate = viewingCalls.slice(viewingCalls.findIndex((c) => c.method === "update") + 1);
    expect(afterUpdate.find((c) => c.method === "eq")?.args).toEqual(["id", VIEWING_ID]);

    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: "org-1",
      actor_id: "agent-1",
      entity_type: "property",
      entity_id: PROPERTY_ID,
      event_type: "viewing_feedback",
    });
    expect(rows[0].payload).toEqual({ viewing_id: VIEWING_ID, reference: "PAF0001", rating: 4 });
  });

  it("puts none of the buyer's words anywhere in the inserted event row, nested values included", async () => {
    const { fake, result } = save({ read: { data: viewing(), error: null }, update: updatedOne });
    expect((await result).error).toBeNull();
    const text = JSON.stringify(inserted(fake));
    expect(WORDS.filter((w) => text.includes(w)), "feedback text reached the hash chain").toEqual([]);
    for (const key of ["liked", "disliked", "comment"]) expect(text).not.toContain(`"${key}"`);
  });

  it("a rating-only save is the same shape; a property without a reference carries null", async () => {
    const { fake, result } = save(
      { read: { data: viewing({ properties: null }), error: null }, update: updatedOne },
      { liked: "", disliked: "", comment: "" },
    );
    expect((await result).error).toBeNull();
    expect(fake.argsOf("viewings", "update")).toEqual([
      [{ feedback: { rating: 4, liked: null, disliked: null, comment: null } }],
    ]);
    expect(inserted(fake)[0].payload).toEqual({ viewing_id: VIEWING_ID, reference: null, rating: 4 });
  });

  it("an admin saving on someone else's viewing logs the same shape", async () => {
    state.role = "admin";
    const { fake, result } = save({ read: { data: viewing({ agent_id: "agent-2" }), error: null }, update: updatedOne });
    expect((await result).error).toBeNull();
    expect(inserted(fake)[0].payload).toEqual({ viewing_id: VIEWING_ID, reference: "PAF0001", rating: 4 });
  });

  it("a refused update (0 rows: the policy filtered it) writes no event", async () => {
    const { fake, result } = save({ read: { data: viewing(), error: null }, update: { data: [], error: null } });
    expect((await result).error).toMatch(/refused/i);
    expect(inserted(fake)).toEqual([]);
  });

  it("a failed update writes no event", async () => {
    const { fake, result } = save({
      read: { data: viewing(), error: null },
      update: { data: null, error: { message: "permission denied" } },
    });
    expect((await result).error).toBe("permission denied");
    expect(inserted(fake)).toEqual([]);
  });

  it("a viewing that is not completed, not the caller's, or not readable is refused before any write", async () => {
    for (const [read, msg] of [
      [{ data: viewing({ status: "scheduled" }), error: null }, /completed/],
      [{ data: viewing({ agent_id: "agent-2" }), error: null }, /your own viewings/],
      [{ data: null, error: null }, /not found/i],
    ] as const) {
      const { fake, result } = save({ read });
      expect((await result).error).toMatch(msg);
      expect(fake.argsOf("viewings", "update")).toEqual([]);
      expect(inserted(fake)).toEqual([]);
    }
  });

  it("invalid input (no rating) is refused before anything is read", async () => {
    const { fake, result } = save({ read: { data: viewing(), error: null } }, { rating: "" });
    expect((await result).error).toBeTruthy();
    expect(fake.calls).toEqual([]);
  });
});
