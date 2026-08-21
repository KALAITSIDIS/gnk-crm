import { describe, expect, it } from "vitest";
import {
  defaultsProvenance,
  isPartyContact,
  partyDefaultsSchema,
  resolvePartyDefaults,
  TERM_NONE,
} from "./party-defaults";

const office = { commission_pct: 3, mandate_type: "open" as const, mandate_months: 6 };

describe("resolvePartyDefaults", () => {
  it("the party's own terms beat the office's", () => {
    const r = resolvePartyDefaults({ commission_pct: 2.5 }, office);
    expect(r.commission_pct).toBe(2.5);
  });

  it("a field the party has no opinion on falls through to the office", () => {
    const r = resolvePartyDefaults({ commission_pct: 2.5 }, office);
    expect(r.mandate_type).toBe("open");
    expect(r.mandate_months).toBe(6);
  });

  it("A STORED ZERO IS A REAL ANSWER and is not replaced", () => {
    // some referral arrangements genuinely are 0% — treating that as "no
    // opinion" would quietly bill the office's 3% on a form somebody signs
    const r = resolvePartyDefaults({ commission_pct: 0 }, office);
    expect(r.commission_pct).toBe(0);
  });

  it("leaves a field neither layer has undefined rather than inventing one", () => {
    const r = resolvePartyDefaults({}, office);
    expect(r.vat_status).toBeUndefined();
  });

  it("works with no party at all — a brand-new developer still gets the office", () => {
    expect(resolvePartyDefaults(null, office).commission_pct).toBe(3);
    expect(resolvePartyDefaults(undefined, office).mandate_type).toBe("open");
  });

  it("works with no office either", () => {
    expect(resolvePartyDefaults({ commission_pct: 4 }, null)).toEqual({ commission_pct: 4 });
    expect(resolvePartyDefaults(null, null)).toEqual({});
  });

  it("does not mutate either input", () => {
    const party = { commission_pct: 2 };
    const o = { ...office };
    resolvePartyDefaults(party, o);
    expect(party).toEqual({ commission_pct: 2 });
    expect(o).toEqual(office);
  });
});

describe("defaultsProvenance", () => {
  it("names the layer each value came from", () => {
    const p = defaultsProvenance({ commission_pct: 2.5 }, office);
    expect(p.commission_pct).toBe("party");
    expect(p.mandate_type).toBe("office");
  });

  it("credits the party for a zero it actually set", () => {
    expect(defaultsProvenance({ commission_pct: 0 }, office).commission_pct).toBe("party");
  });

  it("says nothing about a field nobody set", () => {
    expect(defaultsProvenance({}, {}).commission_pct).toBeUndefined();
  });
});

describe("partyDefaultsSchema", () => {
  it("treats empty form fields as no opinion, not as zero", () => {
    const parsed = partyDefaultsSchema.parse({ commission_pct: "", mandate_type: "" });
    expect(parsed.commission_pct).toBeUndefined();
    expect(parsed.mandate_type).toBeUndefined();
  });

  it("accepts a real zero typed on purpose", () => {
    expect(partyDefaultsSchema.parse({ commission_pct: "0" }).commission_pct).toBe(0);
  });

  it("rejects a commission outside 0–100", () => {
    expect(partyDefaultsSchema.safeParse({ commission_pct: "150" }).success).toBe(false);
    expect(partyDefaultsSchema.safeParse({ commission_pct: "-1" }).success).toBe(false);
  });

  it("rejects a mandate length that is not a sane number of months", () => {
    expect(partyDefaultsSchema.safeParse({ mandate_months: "0" }).success).toBe(false);
    expect(partyDefaultsSchema.safeParse({ mandate_months: "121" }).success).toBe(false);
    expect(partyDefaultsSchema.safeParse({ mandate_months: "6" }).success).toBe(true);
  });
});

describe("isPartyContact", () => {
  it("is true for the roles that have standard terms", () => {
    for (const t of ["owner", "developer", "seller", "landlord"]) {
      expect(isPartyContact([t])).toBe(true);
    }
  });

  it("is false for a buyer — no commission rate, no usual VAT treatment", () => {
    expect(isPartyContact(["buyer"])).toBe(false);
    expect(isPartyContact([])).toBe(false);
    expect(isPartyContact(null)).toBe(false);
  });

  it("is true when a contact is a buyer AND an owner", () => {
    expect(isPartyContact(["buyer", "owner"])).toBe(true);
  });
});

describe("TERM_NONE", () => {
  it("the Select's no-standard sentinel clears the field", () => {
    // Radix forbids an empty SelectItem value, so the form posts a sentinel —
    // handled in the schema, not the action, so the two cannot disagree
    const parsed = partyDefaultsSchema.parse({
      mandate_type: TERM_NONE,
      vat_status: TERM_NONE,
    });
    expect(parsed.mandate_type).toBeUndefined();
    expect(parsed.vat_status).toBeUndefined();
  });

  it("a cleared field therefore falls back to the office", () => {
    const parsed = partyDefaultsSchema.parse({ mandate_type: TERM_NONE });
    expect(resolvePartyDefaults(parsed, { mandate_type: "open" }).mandate_type).toBe("open");
  });
});
