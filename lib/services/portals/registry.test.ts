import { describe, expect, it } from "vitest";
import { PORTALS, PORTAL_IDS, portalById } from "./registry";

describe("portal registry", () => {
  it("has one definition per id and no id twice", () => {
    expect(PORTALS.map((p) => p.id).sort()).toEqual([...PORTAL_IDS].sort());
    expect(new Set(PORTALS.map((p) => p.id)).size).toBe(PORTALS.length);
  });

  it("ids are lowercase snake case, which the 0095 check constraint enforces", () => {
    for (const p of PORTALS) expect(p.id).toMatch(/^[a-z_]{2,40}$/);
  });

  it("a pending portal has no required settings the desk could fill in for nothing", () => {
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

  it("settingsSchema accepts an empty form and strips unknown keys", () => {
    const je = portalById("jamesedition")!;
    const parsed = je.settingsSchema.safeParse({ contact_number: " +357 26 000000 ", stray: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.contact_number).toBe("+357 26 000000");
      expect("stray" in parsed.data).toBe(false);
    }
  });
});
