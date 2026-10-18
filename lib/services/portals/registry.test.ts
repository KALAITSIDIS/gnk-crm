import { describe, expect, it } from "vitest";
import { DIALECT_TYPE_MAPS } from "./dialects";
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

  it("the feed schema and the form schema agree on keys", () => {
    // a key only the form knows would be saved and never read by the feed; a
    // key only the feed knows could never be set from the desk
    for (const p of PORTALS) {
      expect(Object.keys(p.settingsFormSchema.shape).sort(), p.id).toEqual(Object.keys(p.settingsSchema.shape).sort());
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

describe("what the desk is told about each portal", () => {
  it("every pending portal says why it cannot be enabled; a public one has no such reason", () => {
    for (const p of PORTALS) {
      if (p.spec === "pending") {
        expect(typeof p.pendingReason, p.id).toBe("string");
        expect(p.pendingReason!.trim().length, p.id).toBeGreaterThan(10);
      } else {
        expect(p.pendingReason, p.id).toBeNull();
      }
    }
  });

  it("every public portal says where the desk can see what it published — the CRM never hears", () => {
    for (const p of PORTALS.filter((p) => p.spec === "public")) {
      expect(p.publicationCheck.trim().length, p.id).toBeGreaterThan(10);
    }
  });

  it("there is at least one portal of each kind, so the two checks above are not vacuous", () => {
    expect(PORTALS.some((p) => p.spec === "pending")).toBe(true);
    expect(PORTALS.some((p) => p.spec === "public")).toBe(true);
  });
});

describe("staleAfterHours", () => {
  it("JamesEdition pulls three times a day, so three missed pulls is 24 hours", () => {
    expect(portalById("jamesedition")!.staleAfterHours).toBe(24);
  });

  it("is a positive number of hours or null (unknown) — never zero, which would call every feed stale", () => {
    for (const p of PORTALS) {
      if (p.staleAfterHours !== null) expect(p.staleAfterHours, p.id).toBeGreaterThan(0);
    }
  });

  it("a pending portal never pulls, so it can never be stale", () => {
    for (const p of PORTALS.filter((p) => p.spec === "pending")) expect(p.staleAfterHours, p.id).toBeNull();
  });
});

describe("JamesEdition's documented rules", () => {
  const je = portalById("jamesedition")!;

  it("two photos of at least 800×600", () => {
    expect(je.requirements.minPhotos).toBe(2);
    expect(je.requirements.minImage).toEqual({ width: 800, height: 600 });
  });

  it("refuses commercial types, and says so in its own sentence", () => {
    expect([...(je.requirements.excludedPropertyTypes ?? [])].sort()).toEqual([
      "building",
      "hotel",
      "office",
      "shop",
      "warehouse",
    ]);
    expect(je.requirements.excludedTypesNote).toMatch(/residential/);
  });

  it("moderation floors for sale listings", () => {
    expect(je.moderation?.minSalePrice).toEqual({ EUR: 450_000, GBP: 400_000, USD: 490_000 });
  });

  it("an excluded type is one the dialect maps — else type_unmapped wins and the exclusion is dead text", () => {
    for (const p of PORTALS) {
      for (const t of p.requirements.excludedPropertyTypes ?? []) {
        expect(Object.hasOwn(DIALECT_TYPE_MAPS[p.dialect], t), `${p.id}: ${t}`).toBe(true);
      }
      if (p.requirements.excludedPropertyTypes?.length) {
        expect(p.requirements.excludedTypesNote, `${p.id} needs its sentence`).toBeTruthy();
      }
    }
  });
});

describe("settings: lenient for the feed, strict for the form", () => {
  const je = portalById("jamesedition")!;

  it("the feed schema keeps a stored phone without a country code, so a typo cannot take a feed down", () => {
    const parsed = je.settingsSchema.safeParse({ contact_number: "26 000000", whatsapp_number: "99 123456" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.contact_number).toBe("26 000000");
      expect(parsed.data.whatsapp_number).toBe("99 123456");
    }
  });

  it("the form schema refuses it, naming the field", () => {
    const contact = je.settingsFormSchema.safeParse({ contact_number: "26 000000" });
    expect(contact.success).toBe(false);
    if (!contact.success) {
      expect(contact.error.issues[0]?.message).toMatch(/^Contact phone:/);
      expect(contact.error.issues[0]?.message).toMatch(/country code/);
      expect(contact.error.issues[0]?.path).toEqual(["contact_number"]);
    }

    const whatsapp = je.settingsFormSchema.safeParse({ whatsapp_number: "99 123456" });
    expect(whatsapp.success).toBe(false);
    if (!whatsapp.success) expect(whatsapp.error.issues[0]?.message).toMatch(/^WhatsApp number:/);
  });

  it("the form schema accepts a number with its country code, as typed (trimmed)", () => {
    // the dialect rewrites to 00-form when it renders; the desk keeps its own spelling
    const parsed = je.settingsFormSchema.safeParse({
      contact_number: " +357 26 000000 ",
      whatsapp_number: "0035799123456",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.contact_number).toBe("+357 26 000000");
      expect(parsed.data.whatsapp_number).toBe("0035799123456");
    }
  });

  it("both accept blank — the phone fields are optional", () => {
    for (const schema of [je.settingsSchema, je.settingsFormSchema]) {
      const empty = schema.safeParse({});
      expect(empty.success).toBe(true);
      if (empty.success) expect(empty.data).toEqual({ contact_number: "", whatsapp_number: "", email: "" });

      const spaces = schema.safeParse({ contact_number: "   ", whatsapp_number: "" });
      expect(spaces.success).toBe(true);
      if (spaces.success) {
        expect(spaces.data.contact_number).toBe("");
        expect(spaces.data.whatsapp_number).toBe("");
      }
    }
  });

  it("the form schema still refuses a malformed e-mail, as the feed schema does", () => {
    expect(je.settingsFormSchema.safeParse({ email: "not an email" }).success).toBe(false);
  });
});
