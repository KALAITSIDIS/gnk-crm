import { describe, expect, it } from "vitest";
import { PORTAL_ID_PATTERN, PORTALS, PORTAL_IDS, portalById } from "./registry";

describe("portal registry", () => {
  it("has one definition per id and no id twice", () => {
    expect(PORTALS.map((p) => p.id).sort()).toEqual([...PORTAL_IDS].sort());
    expect(new Set(PORTALS.map((p) => p.id)).size).toBe(PORTALS.length);
  });

  it("ids are lowercase snake case, which the 0095 check constraint enforces", () => {
    for (const p of PORTALS) expect(p.id).toMatch(PORTAL_ID_PATTERN);
  });

  it("a pending portal has no required settings the desk could fill in for nothing", () => {
    // a field the desk fills for a portal it cannot enable buys nothing;
    // thribee's required key arrives with its renderer in milestone 2
    for (const p of PORTALS.filter((p) => p.spec === "pending")) {
      expect(p.requiredSettings, p.id).toEqual([]);
    }
  });

  it("every requiredSettings key is a declared settings field", () => {
    for (const p of PORTALS) {
      const keys = p.settingsFields.map((f) => f.key);
      for (const k of p.requiredSettings) expect(keys, `${p.id}.${k}`).toContain(k);
    }
  });

  it("portalById answers null for an unknown id", () => {
    expect(portalById("nope")).toBeNull();
    expect(portalById("jamesedition")?.dialect).toBe("kyero");
  });

  it("settings fields and schema shape agree both ways", () => {
    for (const p of PORTALS) {
      expect(p.settingsFields.map((f) => f.key).sort()).toEqual(Object.keys(p.settingsSchema.shape).sort());
    }
  });

  it("accepts an empty form, trims, and strips unknown keys", () => {
    const je = portalById("jamesedition")!;
    const parsed = je.settingsSchema.safeParse({ contact_number: " +357 26 000000 ", stray: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.contact_number).toBe("+357 26 000000");
      expect("stray" in parsed.data).toBe(false);
    }

    const empty = je.settingsSchema.safeParse({});
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect(empty.data).toEqual({ contact_number: "", whatsapp_number: "", email: "" });
    }
  });

  it("email must be blank or valid", () => {
    const je = portalById("jamesedition")!;
    expect(je.settingsSchema.safeParse({ email: "not an email" }).success).toBe(false);

    // zod 4's z.email() requires a TLD of at least two characters, so "a@b.c" is
    // itself invalid — "a@b.co" exercises the same trim-and-accept path.
    const valid = je.settingsSchema.safeParse({ email: " a@b.co " });
    expect(valid.success).toBe(true);
    if (valid.success) expect(valid.data.email).toBe("a@b.co");

    const blank = je.settingsSchema.safeParse({});
    expect(blank.success).toBe(true);
    if (blank.success) expect(blank.data.email).toBe("");
  });

  it("every docsUrl is https", () => {
    for (const p of PORTALS) expect(p.docsUrl).toMatch(/^https:\/\//);
  });
});
