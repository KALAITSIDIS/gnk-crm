import { describe, expect, it } from "vitest";
import {
  CONTACT_DOC_TYPES,
  KYC_CONTACT_DOC_TYPES,
  contactDocVisibility,
} from "./documents";

/**
 * SEC-02 (audit 2026-08-29): KYC contact documents are admin-only. This file
 * is the matched pair of migration 0072's CHECK — the TS mapping and the SQL
 * constraint must agree on WHICH types are CDD records, and drift between
 * them is the failure mode this feature could most easily introduce (the
 * nudge-thresholds lesson, 0052).
 */
describe("contactDocVisibility — the KYC/working-document split", () => {
  it("every KYC type is admin_only", () => {
    for (const t of KYC_CONTACT_DOC_TYPES) {
      expect(contactDocVisibility(t), t).toBe("admin_only");
    }
  });

  it("the KYC set is exactly the three CDD types the 0072 CHECK names", () => {
    // If a type is added here, migration 0072's IN-list must gain it in the
    // same change — this pin is what makes that a loud diff instead of drift.
    expect([...KYC_CONTACT_DOC_TYPES].sort()).toEqual([
      "id_document",
      "proof_of_address",
      "source_of_funds",
    ]);
  });

  it("contracts and 'other' stay org-internal — need-to-know, not blanket", () => {
    expect(contactDocVisibility("contract")).toBe("internal");
    expect(contactDocVisibility("other")).toBe("internal");
  });

  it("every offered contact type has a deliberate answer (no type falls through unclassified)", () => {
    for (const t of CONTACT_DOC_TYPES) {
      const v = contactDocVisibility(t);
      expect(["admin_only", "internal"]).toContain(v);
      // and KYC membership fully determines it — the mapping has no third state
      expect(v === "admin_only").toBe((KYC_CONTACT_DOC_TYPES as readonly string[]).includes(t));
    }
  });
});
