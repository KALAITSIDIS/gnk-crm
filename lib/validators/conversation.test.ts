import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONVERSATION_OUTCOMES, DEFAULT_CONVERSATION_OUTCOME, conversationOutcomeField } from "./conversation";

/**
 * "What happened" on the Log-conversation dialogs (A06-b, 0155). The words are
 * the database's CHECK on interaction_notes.outcome and log_conversation's own
 * test, so the form may post exactly these, or nothing ("not said").
 */
const form = z.object({ outcome: conversationOutcomeField });
const parse = (entries: Record<string, string>) => form.safeParse(entries);

describe("conversationOutcomeField", () => {
  it("is the migration's three words, Spoke first and preselected", () => {
    expect(CONVERSATION_OUTCOMES).toEqual(["spoke", "message_sent", "client_replied"]);
    expect(DEFAULT_CONVERSATION_OUTCOME).toBe("spoke");
  });

  it.each(CONVERSATION_OUTCOMES)("accepts %s", (outcome) => {
    expect(parse({ outcome })).toEqual({ success: true, data: { outcome } });
  });

  it("a form that does not post it logs no outcome — never a default", () => {
    expect(parse({})).toEqual({ success: true, data: {} });
    expect(parse({ outcome: "" })).toEqual({ success: true, data: { outcome: undefined } });
  });

  it.each(["replied", "MESSAGE_SENT", "message sent", " spoke", "spoke ", "seen", "read"])(
    "refuses %j in words",
    (outcome) => {
      const r = parse({ outcome });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toBe("Choose what happened");
    },
  );
});
