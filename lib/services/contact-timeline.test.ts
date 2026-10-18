import { describe, expect, it } from "vitest";
import type { Json } from "@/lib/supabase/database.types";
import { annotateContactTimeline } from "./contact-timeline";

/**
 * The contact page's timeline shows this contact's events and those of every
 * contact merged into it (DECISIONS T2.3), and names each merged-away source
 * from its ROW. Since 2026-09-23 the `merged` event carries the duplicate's id
 * and no name (DECISIONS T-merged-event-ids-only), so the line takes its name
 * the same way — from the row, which erasure can reach — while an older event
 * that carries the name inline keeps rendering as it always did.
 */

const ev = (
  entity_id: string,
  event_type: string,
  payload: { [key: string]: Json } = {},
  note: string | null = null,
) => ({ id: `${entity_id}-${event_type}`, entity_id, event_type, payload, note });

const merged = [
  { id: "dup-1", display_name: "Mariou Duplikatou" },
  { id: "dup-2", display_name: null },
];

describe("annotateContactTimeline", () => {
  it("names a merged event from the duplicate's row when the event carries only its id", () => {
    const [e] = annotateContactTimeline(
      [ev("pri-1", "merged", { merged_contact_id: "dup-1", dropped_fields: [] })],
      "pri-1",
      merged,
    );
    expect(e.note).toBe("Mariou Duplikatou");
  });

  it("leaves an older merged event alone — its line already carries the name", () => {
    const [e] = annotateContactTimeline(
      [ev("pri-1", "merged", { merged_contact_id: "dup-1", merged_contact_name: "M. D." })],
      "pri-1",
      merged,
    );
    expect(e.note, "the line reads 'Merged in M. D.' — the name twice is noise").toBeNull();
  });

  it("says nothing extra when the duplicate's row is not readable or has no name", () => {
    const events = annotateContactTimeline(
      [
        ev("pri-1", "merged", { merged_contact_id: "dup-9" }),
        ev("pri-1", "merged", { merged_contact_id: "dup-2" }),
        ev("pri-1", "merged", {}),
      ],
      "pri-1",
      merged,
    );
    expect(events.map((e) => e.note)).toEqual([null, null, null]);
  });

  it("keeps the conversation note beside the name", () => {
    const [e] = annotateContactTimeline(
      [ev("pri-1", "merged", { merged_contact_id: "dup-1" }, "called first")],
      "pri-1",
      merged,
    );
    expect(e.note).toBe("Mariou Duplikatou · called first");
  });

  it("labels a merged-away contact's own events with its name, as before", () => {
    const events = annotateContactTimeline(
      [ev("dup-1", "updated", {}, "left a voicemail"), ev("dup-9", "created")],
      "pri-1",
      merged,
    );
    expect(events.map((e) => e.note)).toEqual([
      "Mariou Duplikatou · left a voicemail",
      "merged contact",
    ]);
  });

  it("does not touch this contact's other events", () => {
    const [e] = annotateContactTimeline([ev("pri-1", "updated", {}, "a note")], "pri-1", merged);
    expect(e).toEqual(ev("pri-1", "updated", {}, "a note"));
  });
});

describe("a combined feed's lead, deal and viewing events are not merged contacts (A06)", () => {
  /*
   * The contact's Activity now carries the person's leads, deals and viewings.
   * Their entity ids are never the contact's, and "any other id is a merged
   * duplicate" would have put "merged contact" on every call logged from the
   * inbox.
   */
  const typed = (entity_type: string, entity_id: string, event_type: string, note: string | null = null) => ({
    id: `${entity_type}-${event_type}`,
    entity_type,
    entity_id,
    event_type,
    payload: {} as { [key: string]: Json },
    note,
  });

  it.each([
    ["a lead's call", typed("lead", "lead-1", "called")],
    ["a deal's logged conversation", typed("deal", "deal-1", "conversation_logged", "spoke about the deposit")],
    ["a viewing being scheduled", typed("viewing", "viewing-1", "created")],
  ])("%s keeps its own note and no merged label", (_name, e) => {
    const [out] = annotateContactTimeline([e], "pri-1", merged);
    expect(out.note ?? "").not.toMatch(/merged contact|Mariou/);
    expect(out.note).toBe(e.note);
  });

  it("still labels a merged duplicate's own CONTACT event", () => {
    const [out] = annotateContactTimeline([typed("contact", "dup-1", "updated")], "pri-1", merged);
    expect(out.note).toBe("Mariou Duplikatou");
  });

  it("does not name a crafted `merged` event on a lead after a duplicate", () => {
    const e = { ...typed("lead", "lead-1", "merged"), payload: { merged_contact_id: "dup-1" } };
    const [out] = annotateContactTimeline([e], "pri-1", merged);
    expect(out.note).toBeNull();
  });
});
