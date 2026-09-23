import { describe, expect, it } from "vitest";
import { mayLinkLeadContact } from "./lead-contact-link";

/**
 * Who is offered a link control on an inbox row (T-enquiry-contact-
 * suggestions): `leads_update` (doc 04) in the app's words. The database is
 * the authority and refuses everyone else with zero rows
 * (supabase/tests/enquiry-contact-suggestions.test.ts races real sessions
 * through it); this decides only what the row OFFERS, so nobody is handed a
 * button whose write the policy will quietly refuse.
 */
describe("mayLinkLeadContact", () => {
  const me = "agent-1";

  it("lets an admin link any lead", () => {
    expect(mayLinkLeadContact({ id: "admin-1", role: "admin" }, null)).toBe(true);
    expect(mayLinkLeadContact({ id: "admin-1", role: "admin" }, "someone-else")).toBe(true);
  });

  it("lets an agent link an unassigned lead or their own", () => {
    expect(mayLinkLeadContact({ id: me, role: "agent" }, null)).toBe(true);
    expect(mayLinkLeadContact({ id: me, role: "agent" }, me)).toBe(true);
  });

  it("does not offer an agent a colleague's lead", () => {
    expect(mayLinkLeadContact({ id: me, role: "agent" }, "agent-2")).toBe(false);
  });

  it("never offers a listing manager a link — they read every lead and may write none", () => {
    expect(mayLinkLeadContact({ id: "lm-1", role: "listing_manager" }, null)).toBe(false);
    expect(mayLinkLeadContact({ id: "lm-1", role: "listing_manager" }, "lm-1")).toBe(false);
  });

  it("offers nothing to an unknown role", () => {
    expect(mayLinkLeadContact({ id: "x", role: "owner_portal" }, null)).toBe(false);
  });
});
