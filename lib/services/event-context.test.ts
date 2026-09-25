import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * attachCurrentTitles — which task or document an id-only event is about, and
 * what a viewing's buyer says now, read from the row AS THE VIEWER
 * (T-event-typed-text-shape, T-viewing-feedback-shape).
 *
 * What is pinned here is the transport contract: the client it is handed is the
 * one asked (never the admin client), one query per table however many events,
 * none when nothing needs one, the org filter, and what a missing row, a failed
 * read or a malformed id leaves behind — the neutral line, never the payload's
 * copy. That RLS really withholds an admin_only document or another org's task
 * from that client is measured against the database in
 * supabase/tests/event-context.test.ts.
 */

// if anything in this module reached for the system's client, the test fails
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("attachCurrentTitles must never use the admin client");
  },
}));

const { attachCurrentTitles } = await import("./event-context");

const ORG = "org-1";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const D1 = "33333333-3333-4333-8333-333333333333";
const D2 = "44444444-4444-4444-8444-444444444444";

const ev = (entity_type: string, entity_id: string | null, event_type: string, payload: unknown = {}) => ({
  id: `${entity_type}-${event_type}-${entity_id}`,
  occurred_at: "2026-09-24T10:00:00Z",
  entity_type,
  entity_id,
  event_type,
  payload: payload as never,
});

function viewer(pages: Record<string, FakePage[]> = {}) {
  const fake = fakeClient(pages);
  return { fake, client: fake.client as never };
}

afterEach(() => vi.restoreAllMocks());

describe("attachCurrentTitles", () => {
  it("attaches each task's current title from ONE tasks read on the viewer's client", async () => {
    const { fake, client } = viewer({
      tasks: [
        {
          data: [
            { id: T1, title: "Call the notary" },
            { id: T2, title: "Chase the valuation" },
          ],
          error: null,
        },
      ],
    });
    const out = await attachCurrentTitles(client, ORG, [
      ev("task", T1, "completed"),
      ev("task", T2, "reopened"),
      ev("task", T1, "reopened"),
    ]);
    expect(out.map((e) => e.current_title)).toEqual(["Call the notary", "Chase the valuation", "Call the notary"]);
    expect(fake.served.tasks).toBe(1);
    expect(fake.argsOf("tasks", "select")).toEqual([["id, title"]]);
    expect(fake.argsOf("tasks", "eq")).toEqual([["org_id", ORG]]);
    // de-duplicated: T1 twice on the page is asked for once
    expect(fake.argsOf("tasks", "in")).toEqual([["id", [T1, T2]]]);
  });

  it("attaches an uploaded document's current title through payload.document_id, in ONE documents read", async () => {
    const { fake, client } = viewer({
      documents: [{ data: [{ id: D1, title: "Sale agreement.pdf" }], error: null }],
    });
    const out = await attachCurrentTitles(client, ORG, [
      ev("contact", "c1", "document_uploaded", { document_id: D1, doc_type: "contract", visibility: "internal" }),
      ev("mandate", "m1", "document_uploaded", { document_id: D2, doc_type: "mandate_agreement", visibility: "internal" }),
    ]);
    expect(out[0].current_title).toBe("Sale agreement.pdf");
    // D2 did not come back (deleted, or RLS withheld it): neutral, no title
    expect(out[1].current_title).toBeUndefined();
    expect(fake.served.documents).toBe(1);
    expect(fake.argsOf("documents", "eq")).toEqual([["org_id", ORG]]);
    expect(fake.argsOf("documents", "in")).toEqual([["id", [D1, D2]]]);
  });

  it("never falls back to a legacy payload's title — a row the viewer cannot read stays neutral", async () => {
    const { client } = viewer({ tasks: [{ data: [], error: null }], documents: [{ data: [], error: null }] });
    const out = await attachCurrentTitles(client, ORG, [
      ev("task", T1, "completed", { title: "Call Kyriakoula Palaiopoulou" }),
      ev("contact", "c1", "document_uploaded", {
        document_id: D1,
        title: "passport_AB123456.pdf",
        doc_type: "id_document",
        visibility: "admin_only",
      }),
    ]);
    expect(out.every((e) => e.current_title === undefined)).toBe(true);
    expect(JSON.stringify(out.map((e) => e.current_title ?? null))).not.toMatch(/Kyriakoula|passport/);
  });

  it("never looks up a deleted document — there is no row, and nothing to fall back to", async () => {
    const { fake, client } = viewer();
    const out = await attachCurrentTitles(client, ORG, [
      ev("property", "p1", "document_deleted", { document_id: D1, title: "Title deed PAF0001.pdf", doc_type: "title_deed", visibility: "internal" }),
    ]);
    expect(out[0].current_title).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it("asks nothing at all when no event on the page needs a title", async () => {
    const { fake, client } = viewer();
    const events = [
      ev("deal", "d1", "lost", { stage: "Lost" }),
      ev("contact", "c1", "updated", { section: "profile" }),
      // `completed` is a task verb — on another entity it is not a task's
      ev("viewing", T1, "completed"),
    ];
    expect(await attachCurrentTitles(client, ORG, events)).toBe(events);
    expect(fake.calls).toEqual([]);
  });

  it("never sends an id that is not a uuid — one malformed payload must not fail the page's lookup", async () => {
    const { fake, client } = viewer({ documents: [{ data: [{ id: D1, title: "Plan.pdf" }], error: null }] });
    const out = await attachCurrentTitles(client, ORG, [
      ev("contact", "c1", "document_uploaded", { document_id: "d1" }),
      ev("contact", "c1", "document_uploaded", { document_id: 42 }),
      ev("contact", "c1", "document_uploaded", { document_id: `${D1}'); drop table x; --` }),
      ev("contact", "c1", "document_uploaded", { document_id: D1 }),
      ev("task", "not-a-uuid", "completed"),
    ]);
    expect(fake.argsOf("documents", "in")).toEqual([["id", [D1]]]);
    expect(fake.served.tasks ?? 0).toBe(0);
    expect(out.map((e) => e.current_title ?? null)).toEqual([null, null, null, "Plan.pdf", null]);
  });

  it("a failed read leaves the lines neutral and logs, rather than failing the page", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = viewer({ tasks: [{ data: null, error: { message: "boom" } }] });
    const out = await attachCurrentTitles(client, ORG, [ev("task", T1, "completed")]);
    expect(out[0].current_title).toBeUndefined();
    expect(err).toHaveBeenCalledWith(
      "timeline title read failed:",
      expect.objectContaining({ table: "tasks", count: 1, error: "boom" }),
    );
  });

  it("refuses to read without an org rather than asking without a boundary", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, client } = viewer();
    const events = [ev("task", T1, "completed")];
    expect(await attachCurrentTitles(client, "", events)).toBe(events);
    expect(fake.calls).toEqual([]);
    expect(err).toHaveBeenCalled();
  });

  it("ignores a blank title on the row, as the renderer ignores blank text", async () => {
    const { client } = viewer({ tasks: [{ data: [{ id: T1, title: "   " }], error: null }] });
    const [e] = await attachCurrentTitles(client, ORG, [ev("task", T1, "completed")]);
    expect(e.current_title).toBeUndefined();
  });

  it("keeps every other field, including the caller's note", async () => {
    const { client } = viewer({ tasks: [{ data: [{ id: T1, title: "Call the notary" }], error: null }] });
    const input = { ...ev("task", T1, "completed"), note: "A. Admin" };
    const [e] = await attachCurrentTitles(client, ORG, [input]);
    expect(e).toEqual({ ...input, current_title: "Call the notary" });
  });
});

/**
 * T-viewing-feedback-shape: a `viewing_feedback` event carries
 * `{ viewing_id, reference, rating }` — never the buyer's words. The property
 * timeline still shows them (the C7 acceptance), read from the viewing ROW as
 * the viewer and labelled as CURRENT. Feedback is overwritten by every save and
 * each save logs an event, so only the NEWEST event per viewing on the page
 * carries it: an older save never shows today's wording as if it were its own.
 */
describe("attachCurrentTitles — a viewing's current feedback", () => {
  const P1 = "aaaaaaaa-1111-4111-8111-111111111111";
  const P2 = "bbbbbbbb-2222-4222-8222-222222222222";
  const V1 = "55555555-5555-4555-8555-555555555555";
  const V2 = "66666666-6666-4666-8666-666666666666";

  const fb = (viewing_id: unknown, occurred_at: string, property = P1, extra: Record<string, unknown> = {}) => ({
    ...ev("property", property, "viewing_feedback", { viewing_id, reference: "PAF0001", rating: 4, ...extra }),
    id: `fb-${String(viewing_id)}-${occurred_at}`,
    occurred_at,
  });
  const row = (id: string, feedback: unknown, property_id = P1) => ({ id, property_id, feedback });

  it("reads ONE viewings page on the viewer's client, org-bounded, and attaches the comment", async () => {
    const { fake, client } = viewer({
      viewings: [
        {
          data: [
            row(V1, { rating: 4, liked: "The light", disliked: null, comment: "Will offer after the survey" }),
            row(V2, { rating: 3, liked: "The garden", disliked: "Road noise", comment: null }),
          ],
          error: null,
        },
      ],
    });
    const out = await attachCurrentTitles(client, ORG, [fb(V1, "2026-09-24T10:00:00Z"), fb(V2, "2026-09-23T10:00:00Z")]);
    // the comment, else what was liked — the two the line used to print
    expect(out.map((e) => e.current_feedback)).toEqual(["Will offer after the survey", "The garden"]);
    expect(out.every((e) => e.current_title === undefined)).toBe(true);
    expect(fake.served.viewings).toBe(1);
    expect(fake.argsOf("viewings", "select")).toEqual([["id, property_id, feedback"]]);
    expect(fake.argsOf("viewings", "eq")).toEqual([["org_id", ORG]]);
    expect(fake.argsOf("viewings", "in")).toEqual([["id", [V1, V2]]]);
  });

  it("only the NEWEST event per viewing carries it — whatever order the page arrives in", async () => {
    const { fake, client } = viewer({
      viewings: [{ data: [row(V1, { rating: 5, liked: null, disliked: null, comment: "Second visit booked" })], error: null }],
    });
    const out = await attachCurrentTitles(client, ORG, [
      fb(V1, "2026-09-20T10:00:00Z"), // the first save
      fb(V1, "2026-09-24T10:00:00Z"), // the latest save
      fb(V1, "2026-09-22T10:00:00Z"),
    ]);
    expect(out.map((e) => e.current_feedback ?? null)).toEqual([null, "Second visit booked", null]);
    expect(fake.argsOf("viewings", "in")).toEqual([["id", [V1]]]);
  });

  it("never falls back to a legacy payload's words — a missing row, empty feedback or blank text stays neutral", async () => {
    const LEGACY = "Zenobia Quillfeather, call 99 000 111";
    const { client } = viewer({
      viewings: [
        {
          data: [
            row(V1, null),
            row(V2, { rating: 3, liked: "   ", disliked: "Too dark", comment: "" }),
          ],
          error: null,
        },
      ],
    });
    const V3 = "77777777-7777-4777-8777-777777777777"; // not returned: gone, or not readable
    const out = await attachCurrentTitles(client, ORG, [
      fb(V1, "2026-09-24T10:00:00Z", P1, { comment: LEGACY, liked: LEGACY }),
      fb(V2, "2026-09-23T10:00:00Z", P1, { comment: LEGACY }),
      fb(V3, "2026-09-22T10:00:00Z", P1, { comment: LEGACY }),
    ]);
    expect(out.every((e) => e.current_feedback === undefined)).toBe(true);
    expect(JSON.stringify(out.map((e) => e.current_feedback ?? null))).not.toMatch(/Zenobia|Too dark/);
  });

  it("one viewing named in two letter cases is still ONE viewing — the older save never carries today's words", async () => {
    // Postgres answers in lowercase whatever it was asked; z.guid() admits an
    // uppercase id into a payload through a hand-made form post
    const VX = "5c0ffee0-abcd-4def-8abc-defabcdefabc"; // letters, so the case can differ
    expect(VX.toUpperCase()).not.toBe(VX);
    const { fake, client } = viewer({
      viewings: [{ data: [row(VX, { rating: 5, liked: null, disliked: null, comment: "Today's words" })], error: null }],
    });
    const out = await attachCurrentTitles(client, ORG, [
      fb(VX.toUpperCase(), "2026-09-24T10:00:00Z"), // the newest save
      fb(VX, "2026-09-20T10:00:00Z"), // an older one
    ]);
    expect(out.map((e) => e.current_feedback ?? null)).toEqual(["Today's words", null]);
    expect(fake.argsOf("viewings", "in")).toEqual([["id", [VX]]]);
  });

  it("attaches nothing when the viewing belongs to ANOTHER property than the event's", async () => {
    // a crafted event on P1 naming P2's viewing must not pull P2's words onto P1's timeline
    const { client } = viewer({
      viewings: [{ data: [row(V1, { rating: 4, liked: null, disliked: null, comment: "About P2" }, P2)], error: null }],
    });
    const [e] = await attachCurrentTitles(client, ORG, [fb(V1, "2026-09-24T10:00:00Z", P1)]);
    expect(e.current_feedback).toBeUndefined();
  });

  it("looks only at property events, and never sends an id that is not a uuid", async () => {
    const { fake, client } = viewer({
      viewings: [{ data: [row(V1, { rating: 4, liked: null, disliked: null, comment: "Fine" })], error: null }],
    });
    const out = await attachCurrentTitles(client, ORG, [
      { ...fb(V1, "2026-09-24T10:00:00Z"), entity_type: "contact" },
      fb("v1", "2026-09-24T10:00:00Z"),
      fb(42, "2026-09-24T10:00:00Z"),
      fb(`${V1}'); drop table x; --`, "2026-09-24T10:00:00Z"),
      fb(V1, "2026-09-23T10:00:00Z"),
    ]);
    expect(fake.argsOf("viewings", "in")).toEqual([["id", [V1]]]);
    expect(out.map((e) => e.current_feedback ?? null)).toEqual([null, null, null, null, "Fine"]);
  });

  it("a failed read leaves the lines neutral and logs no words, rather than failing the page", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = viewer({ viewings: [{ data: null, error: { message: "boom" } }] });
    const [e] = await attachCurrentTitles(client, ORG, [fb(V1, "2026-09-24T10:00:00Z")]);
    expect(e.current_feedback).toBeUndefined();
    expect(err).toHaveBeenCalledWith("timeline feedback read failed:", { count: 1, error: "boom" });
  });

  it("ignores a feedback value that is not an object", async () => {
    const { client } = viewer({
      viewings: [{ data: [row(V1, "Zenobia said yes"), row(V2, ["x"])], error: null }],
    });
    const out = await attachCurrentTitles(client, ORG, [fb(V1, "2026-09-24T10:00:00Z"), fb(V2, "2026-09-24T10:00:00Z")]);
    expect(out.every((e) => e.current_feedback === undefined)).toBe(true);
  });

  it("reads tasks and viewings side by side, one query each", async () => {
    const { fake, client } = viewer({
      tasks: [{ data: [{ id: T1, title: "Call the notary" }], error: null }],
      viewings: [{ data: [row(V1, { rating: 4, liked: null, disliked: null, comment: "Fine" })], error: null }],
    });
    const out = await attachCurrentTitles(client, ORG, [ev("task", T1, "completed"), fb(V1, "2026-09-24T10:00:00Z")]);
    expect(out.map((e) => [e.current_title ?? null, e.current_feedback ?? null])).toEqual([
      ["Call the notary", null],
      [null, "Fine"],
    ]);
    expect(fake.served.tasks).toBe(1);
    expect(fake.served.viewings).toBe(1);
  });
});
