import { describe, expect, it } from "vitest";
import { mayCreateViewing } from "./viewings";

/**
 * Who may book a viewing, kept in step with `viewings_insert` (migration 0030):
 *
 *   with check (org_id = current_org_id()
 *               and current_role_gnk() = ANY (ARRAY['admin', 'agent']))
 *
 * A listing manager can READ every viewing, so the calendar, the property page
 * and the deal page all rendered a "New viewing" button for them — and the
 * submit came back as a raw Postgres RLS message on three different screens.
 *
 * The policy is deliberate (doc 04 lists viewings INSERT as A/AG), so the app
 * offers less rather than the database allowing more. This test is what notices
 * if the two stop agreeing.
 */
describe("mayCreateViewing mirrors the viewings_insert policy", () => {
  it("admits an admin and an agent", () => {
    expect(mayCreateViewing("admin")).toBe(true);
    expect(mayCreateViewing("agent")).toBe(true);
  });

  it("refuses a listing manager — the role that saw the button and could not use it", () => {
    expect(mayCreateViewing("listing_manager")).toBe(false);
  });

  it("refuses every portal role", () => {
    for (const role of ["owner_portal", "developer_portal", "partner_portal"]) {
      expect(mayCreateViewing(role), `${role} must not be offered a booking`).toBe(false);
    }
  });

  it("refuses an unknown role rather than defaulting open", () => {
    // A role added to the enum and not to the policy must not silently gain
    // the button; denying by default is the only safe direction here.
    expect(mayCreateViewing("")).toBe(false);
    expect(mayCreateViewing("superuser")).toBe(false);
  });
});
