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

  // The save must parse with the FORM schema: the feed's own schema is
  // deliberately lenient (a stored typo must not take a feed down), so a form
  // parsed with it would let a new phone with no country code through — and
  // Kyero's contact nodes require one.
  it("refuses a phone without a country code, naming the field", () => {
    const r = portalSettingsForm({ portal: "jamesedition", contact_number: "26 000000" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/^Contact phone:/);
      expect(r.error).toMatch(/country code/);
    }

    const w = portalSettingsForm({ portal: "aplaceinthesun", whatsapp_number: "99 123456" });
    expect(w.success).toBe(false);
    if (!w.success) expect(w.error).toMatch(/^WhatsApp number:/);
  });

  it("accepts a phone written with its country code, keeping the desk's spelling, and accepts blank", () => {
    const r = portalSettingsForm({ portal: "jamesedition", contact_number: " +357 26 000000 ", whatsapp_number: "" });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.settings).toEqual({ contact_number: "+357 26 000000", whatsapp_number: "", email: "" });
  });
});
