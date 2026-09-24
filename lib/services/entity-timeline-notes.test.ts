import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import { NOTE_ERASED_LABEL } from "@/lib/services/notes";

/**
 * A logged conversation's words come from `interaction_notes`, not the event
 * (audit SEC-03). The event carries `note_id` and a digest; the reader joins
 * the row and attaches its body as the line's note — or says it was erased.
 * Events written before 0094 carry the note inline and still render.
 */
const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.client }));

const { readEntityTimeline } = await import("./entity-timeline");

// the VIEWER's client — a blank fake; see event-context.test.ts for what it is asked
const viewer = () => fakeClient({}).client as never;

const ev = (id: number, payload: Record<string, unknown>) => ({
  id,
  occurred_at: `2026-09-1${id}T10:00:00Z`,
  event_type: "conversation_logged",
  entity_type: "contact",
  entity_id: "c1",
  payload,
});

describe("readEntityTimeline and notes", () => {
  it("attaches the note's body from interaction_notes when the event carries note_id", async () => {
    const svc = fakeClient({
      events: [{ data: [ev(1, { channel: "phone", note_id: "n1", note_sha256: "abc" })], error: null }],
      interaction_notes: [{ data: [{ id: "n1", body: "Wants a viewing on Saturday", redacted_at: null }], error: null }],
    });
    admin.client = svc.client;
    const rows = await readEntityTimeline({ orgId: "org-1", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "admin", viewer: viewer() });
    expect(rows[0]!.note).toBe("Wants a viewing on Saturday");
    // the join is org-bound too: the admin client has no other boundary
    const notesCall = svc.calls.find((c) => c.table === "interaction_notes" && c.method === "eq" && c.args[0] === "org_id");
    expect(notesCall?.args[1]).toBe("org-1");
  });

  it("says a redacted note was erased rather than showing nothing", async () => {
    const svc = fakeClient({
      events: [{ data: [ev(1, { channel: "phone", note_id: "n1", note_sha256: "abc" })], error: null }],
      interaction_notes: [{ data: [{ id: "n1", body: null, redacted_at: "2026-09-13T10:00:00Z" }], error: null }],
    });
    admin.client = svc.client;
    const rows = await readEntityTimeline({ orgId: "org-1", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "admin", viewer: viewer() });
    expect(rows[0]!.note).toBe(NOTE_ERASED_LABEL);
  });

  it("still renders a pre-0094 event that carries its note inline", async () => {
    const svc = fakeClient({
      events: [{ data: [ev(1, { channel: "email", note: "Old inline note" })], error: null }],
    });
    admin.client = svc.client;
    const rows = await readEntityTimeline({ orgId: "org-1", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "admin", viewer: viewer() });
    expect(rows[0]!.note).toBe("Old inline note");
    expect(svc.served.interaction_notes ?? 0, "no note lookup when nothing references one").toBe(0);
  });
});
