import { describe, expect, it } from "vitest";
import { portalIdSchema, portalSettingsForm } from "./portals";

describe("portal validators", () => {
  it("accepts a registry id and refuses anything else", () => {
    expect(portalIdSchema.safeParse("jamesedition").success).toBe(true);
    expect(portalIdSchema.safeParse("JamesEdition").success).toBe(false);
    expect(portalIdSchema.safeParse("nope").success).toBe(false);
  });

  it("parses a settings form through the portal's own schema, trimming and stripping", () => {
    const r = portalSettingsForm({ portal: "jamesedition", email: " a@b.co ", stray: "x" });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data).toEqual({
        portal: "jamesedition",
        settings: { contact_number: "", whatsapp_number: "", email: "a@b.co" },
      });
  });

  it("refuses a malformed e-mail with the schema's own message", () => {
    const r = portalSettingsForm({ portal: "jamesedition", email: "nope" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/e-mail/i);
  });

  it("refuses a settings form for an unknown portal", () => {
    expect(portalSettingsForm({ portal: "nope" }).success).toBe(false);
  });
});
