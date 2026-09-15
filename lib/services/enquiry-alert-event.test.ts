import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import { recordEnquiryAlert } from "@/lib/services/enquiry-alert-event";

/**
 * The desk alert's outcome becomes an event on the lead (integrations audit
 * 2026-09-15, INT-01). Until 0096 the route discarded the word the sender
 * returned, so a failed or skipped alert left a lead in the inbox with nothing
 * anywhere saying nobody had been told.
 */
describe("the alert's outcome on the lead's timeline", () => {
  it("writes enquiry_alert with the outcome and the provider, and no identifier", async () => {
    const fake = fakeClient({ events: [{ data: [], error: null }] });
    await recordEnquiryAlert(fake.client as never, {
      orgId: "org-1",
      leadId: "lead-1",
      outcome: "sent",
    });
    const inserts = fake.argsOf("events", "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![0]).toEqual({
      org_id: "org-1",
      actor_id: null,
      entity_type: "lead",
      entity_id: "lead-1",
      event_type: "enquiry_alert",
      payload: { outcome: "sent", provider: "resend" },
    });
  });

  it("never throws: a failed record is a console line, and the enquiry stands", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeClient({ events: [{ data: null, error: { message: "boom" } }] });
    await expect(
      recordEnquiryAlert(fake.client as never, {
        orgId: "org-1",
        leadId: "lead-1",
        outcome: "failed",
      }),
    ).resolves.toBeUndefined();
    expect(String(error.mock.calls[0]?.[0])).toContain("could not record");
  });
});
