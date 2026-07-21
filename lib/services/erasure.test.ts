import { describe, expect, it } from "vitest";
import {
  AML_RETENTION_YEARS,
  buildErasureEventPayload,
  hasAmlRelationship,
  planContactErasure,
} from "./erasure";

const NOW = "2026-07-21T10:00:00.000Z";
const ACTOR = "11111111-1111-1111-1111-111111111111";

describe("hasAmlRelationship", () => {
  it("is false for a pure enquirer — no due diligence was ever triggered", () => {
    expect(hasAmlRelationship({ dealCount: 0, viewingSlipCount: 0, mandateCount: 0 })).toBe(
      false,
    );
  });

  it("is true on any of a deal, a signed viewing slip, or a mandate", () => {
    expect(hasAmlRelationship({ dealCount: 1, viewingSlipCount: 0, mandateCount: 0 })).toBe(true);
    expect(hasAmlRelationship({ dealCount: 0, viewingSlipCount: 1, mandateCount: 0 })).toBe(true);
    expect(hasAmlRelationship({ dealCount: 0, viewingSlipCount: 0, mandateCount: 1 })).toBe(true);
  });
});

describe("planContactErasure", () => {
  it("never touches identity fields — name, phone and email are not in the patch", () => {
    const { patch } = planContactErasure({ amlBasis: false, actorId: ACTOR, now: NOW });
    for (const key of [
      "first_name",
      "last_name",
      "company_name",
      "phone_e164",
      "phone_raw",
      "email",
    ]) {
      expect(patch).not.toHaveProperty(key);
    }
  });

  it("clears the profiling layer and kills marketing consent", () => {
    const { patch } = planContactErasure({ amlBasis: true, actorId: ACTOR, now: NOW });
    expect(patch.notes).toBeNull();
    expect(patch.psychology).toBeNull();
    expect(patch.preferences).toEqual({});
    expect(patch.telegram_username).toBeNull();
    expect(patch.additional_phones).toEqual([]);
    expect(patch.nationality).toBeNull();
    expect(patch.banking_readiness).toEqual({});
    expect(patch.consent_marketing).toBe(false);
    expect(patch.consent_at).toBeNull();
  });

  it("forces temperature to inactive so the contact cannot resurface in marketing", () => {
    const { patch } = planContactErasure({ amlBasis: true, actorId: ACTOR, now: NOW });
    expect(patch.temperature).toBe("inactive");
  });

  it("archives the contact", () => {
    const { patch } = planContactErasure({ amlBasis: false, actorId: ACTOR, now: NOW });
    expect(patch.is_archived).toBe(true);
  });

  describe("with no AML relationship", () => {
    const plan = planContactErasure({ amlBasis: false, actorId: ACTOR, now: NOW });

    it("destroys the documents and the KYC checklist", () => {
      expect(plan.deleteDocuments).toBe(true);
      expect(plan.patch.kyc).toEqual({});
    });

    it("stamps no retention date — there is nothing to retain", () => {
      expect(plan.retentionUntil).toBeNull();
      expect(plan.patch.retention_until).toBeNull();
    });
  });

  describe("with an AML relationship", () => {
    const plan = planContactErasure({ amlBasis: true, actorId: ACTOR, now: NOW });

    it("keeps the documents — destroying them would breach the retention duty", () => {
      expect(plan.deleteDocuments).toBe(false);
    });

    it("keeps the KYC checklist, which IS the due-diligence record", () => {
      expect(plan.patch.kyc).toBeUndefined();
    });

    it(`stamps retention ${AML_RETENTION_YEARS} years out`, () => {
      expect(plan.retentionUntil).toBe("2031-07-21");
      expect(plan.patch.retention_until).toBe("2031-07-21");
    });
  });

  it("records who erased and when", () => {
    const { patch } = planContactErasure({ amlBasis: false, actorId: ACTOR, now: NOW });
    expect(patch.erased_by).toBe(ACTOR);
    expect(patch.erased_at).toBe(NOW);
  });
});

describe("buildErasureEventPayload", () => {
  it("carries counts and categories, never the erased values", () => {
    const payload = buildErasureEventPayload({
      amlBasis: true,
      retentionUntil: "2031-07-21",
      leadsRedacted: 2,
      documentsDeleted: 0,
      documentsRetained: 3,
    });
    expect(payload.aml_basis).toBe(true);
    expect(payload.leads_redacted).toBe(2);
    expect(payload.documents_retained).toBe(3);
    // the payload lands in the hash-chained event log — it must never become a
    // copy of the data we just erased
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toMatch(/\+\d{6,}/);
  });

  it("reports the KYC checklist as cleared only when there is no AML basis", () => {
    const withAml = buildErasureEventPayload({
      amlBasis: true,
      retentionUntil: "2031-07-21",
      leadsRedacted: 0,
      documentsDeleted: 0,
      documentsRetained: 1,
    });
    const withoutAml = buildErasureEventPayload({
      amlBasis: false,
      retentionUntil: null,
      leadsRedacted: 0,
      documentsDeleted: 1,
      documentsRetained: 0,
    });
    expect(withAml.fields_cleared).not.toContain("kyc_checklist");
    expect(withoutAml.fields_cleared).toContain("kyc_checklist");
  });
});
