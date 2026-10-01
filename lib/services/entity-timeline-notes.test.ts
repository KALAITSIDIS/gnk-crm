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

// note ids are uuids, as log_conversation writes them
const N1 = "11111111-1111-4111-8111-111111111111";
const N2 = "22222222-2222-4222-8222-222222222222";

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
      events: [{ data: [ev(1, { channel: "phone", note_id: N1, note_sha256: "abc" })], error: null }],
      interaction_notes: [{ data: [{ id: N1, body: "Wants a viewing on Saturday", redacted_at: null }], error: null }],
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
      events: [{ data: [ev(1, { channel: "phone", note_id: N1, note_sha256: "abc" })], error: null }],
      interaction_notes: [{ data: [{ id: N1, body: null, redacted_at: "2026-09-13T10:00:00Z" }], error: null }],
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

  it("never sends a note_id that is not a uuid, so one crafted event cannot blank every note on the timeline", async () => {
    // A session may write any payload (events_insert checks only org and
    // actor). Postgres refuses the WHOLE .in() read for one malformed uuid
    // (22P02) — every note body on the timeline vanished while that event
    // was in the latest 50. The malformed id is dropped; the others render.
    const svc = fakeClient({
      events: [
        {
          data: [
            ev(1, { channel: "phone", note_id: N1, note_sha256: "a" }),
            ev(2, { channel: "phone", note_id: "x' or 1=1 --", note_sha256: "b" }),
            ev(3, { channel: "phone", note_id: N2.toUpperCase(), note_sha256: "c" }),
          ],
          error: null,
        },
      ],
      interaction_notes: [
        { data: [{ id: N1, body: "First call", redacted_at: null }, { id: N2, body: "Second call", redacted_at: null }], error: null },
      ],
    });
    admin.client = svc.client;
    const rows = await readEntityTimeline({ orgId: "org-1", entityType: "contact", entityIds: ["c1"], limit: 50, viewerRole: "admin", viewer: viewer() });
    // only well-formed ids reach the read, lowercased as Postgres returns them
    expect(svc.argsOf("interaction_notes", "in")).toEqual([["id", [N1, N2]]]);
    const byId = new Map(rows.map((r) => [r.id, r.note]));
    expect(byId.get(1)).toBe("First call");
    expect(byId.get(2)).toBeUndefined(); // the crafted line shows no note, and harms no other
    expect(byId.get(3)).toBe("Second call"); // an upper-case uuid still finds its note
  });
});
