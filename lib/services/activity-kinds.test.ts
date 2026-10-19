import { describe, expect, it } from "vitest";
import {
  ACTIVITY_KINDS,
  COMMUNICATION_TYPES,
  LOGGED_CONTACT_TYPES,
  activityKind,
  isLoggedContact,
} from "./activity-kinds";

/**
 * The Activity feed's filters (A06). The rule that matters most is the one
 * about a chat-link click: it is COMMUNICATION — the desk reaching for the
 * person, shown under that filter — and it is NOT a logged contact, because
 * opening WhatsApp says nothing about a message being sent.
 */
const e = (entity_type: string, event_type: string, actor_id: string | null = "p1", payload: unknown = {}) => ({
  entity_type,
  event_type,
  actor_id,
  payload: payload as never,
});

describe("activityKind", () => {
  it.each(["conversation_logged", "called", "contacted", "chat_link_opened"])(
    "%s is communication, wherever it was filed",
    (type) => {
      for (const entity of ["contact", "lead", "deal"]) expect(activityKind(e(entity, type))).toBe("communication");
    },
  );

  it("anything on a viewing is a viewing, a system row included", () => {
    expect(activityKind(e("viewing", "created"))).toBe("viewings");
    expect(activityKind(e("viewing", "status_changed"))).toBe("viewings");
    expect(activityKind(e("viewing", "followup_task_created", null, { kind: "viewing_feedback" }))).toBe("viewings");
  });

  it("viewing lines filed on a property are viewings too", () => {
    expect(activityKind(e("property", "viewing_feedback"))).toBe("viewings");
    expect(activityKind(e("property", "followup_task_created", null, { kind: "viewing_no_show" }))).toBe("viewings");
  });

  it("anything on a deal or an offer, and the money lines elsewhere, are deals", () => {
    expect(activityKind(e("deal", "updated"))).toBe("deals");
    expect(activityKind(e("deal", "followup_task_created", null, { kind: "deal_no_contact" }))).toBe("deals");
    expect(activityKind(e("offer", "status_changed"))).toBe("deals");
    expect(activityKind(e("lead", "converted"))).toBe("deals");
    expect(activityKind(e("property", "reservation_created"))).toBe("deals");
    expect(activityKind(e("property", "installment_paid"))).toBe("deals");
  });

  it("what no person did is system", () => {
    expect(activityKind(e("lead", "created", null))).toBe("system");
    expect(activityKind(e("contact", "superseded", null))).toBe("system");
    expect(activityKind(e("lead", "followup_task_created", null, { kind: "lead_unanswered" }))).toBe("system");
  });

  it("the rest is changes", () => {
    expect(activityKind(e("contact", "updated"))).toBe("changes");
    expect(activityKind(e("lead", "assigned"))).toBe("changes");
    expect(activityKind(e("contact", "document_uploaded"))).toBe("changes");
    expect(activityKind(e("contact", "some_future_type"))).toBe("changes");
  });

  it("a row whose author the reader did not report is not called the system", () => {
    expect(activityKind({ entity_type: "contact", event_type: "updated" })).toBe("changes");
  });

  it("survives a crafted payload", () => {
    for (const payload of [null, [], "x", { kind: 5 }, { kind: "constructor" }]) {
      expect(ACTIVITY_KINDS).toContain(activityKind(e("contact", "followup_task_created", null, payload)));
    }
  });
});

describe("isLoggedContact — what 'Last logged contact' counts", () => {
  it("counts a logged conversation, a call and a contacted stamp", () => {
    for (const t of LOGGED_CONTACT_TYPES) expect(isLoggedContact(t)).toBe(true);
  });

  it("does NOT count a chat-link click", () => {
    expect(isLoggedContact("chat_link_opened")).toBe(false);
    expect(COMMUNICATION_TYPES, "…though it is shown under Communication").toContain("chat_link_opened");
  });

  it("counts nothing else", () => {
    for (const t of ["created", "updated", "viewing_feedback", "converted", "assigned"]) expect(isLoggedContact(t)).toBe(false);
  });
});
