import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * attachCurrentTitles — which task or document an id-only event is about, read
 * from the row AS THE VIEWER (T-event-typed-text-shape).
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
