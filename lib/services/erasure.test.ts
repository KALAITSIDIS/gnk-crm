import { describe, expect, it } from "vitest";
import {
  AML_RETENTION_YEARS,
  buildErasureEventPayload,
  hasAmlRelationship,
  planContactErasure,
  resolveRetentionAnchor,
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
    const { patch } = planContactErasure({ amlBasis: false, actorId: ACTOR, now: NOW, relationshipEndCandidates: [] });
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
    const { patch } = planContactErasure({ amlBasis: true, actorId: ACTOR, now: NOW, relationshipEndCandidates: [] });
    expect(patch.notes).toBeNull();
    expect(patch.psychology).toBeNull();
    expect(patch.telegram_username).toBeNull();
    expect(patch.additional_phones).toEqual([]);
    expect(patch.nationality).toBeNull();
    expect(patch.banking_readiness).toEqual({});
    expect(patch.consent_marketing).toBe(false);
    expect(patch.consent_at).toBeNull();
  });

  it("forces temperature to inactive so the contact cannot resurface in marketing", () => {
    const { patch } = planContactErasure({ amlBasis: true, actorId: ACTOR, now: NOW, relationshipEndCandidates: [] });
    expect(patch.temperature).toBe("inactive");
  });

  it("archives the contact", () => {
    const { patch } = planContactErasure({ amlBasis: false, actorId: ACTOR, now: NOW, relationshipEndCandidates: [] });
    expect(patch.is_archived).toBe(true);
  });

  describe("with no AML relationship", () => {
    const plan = planContactErasure({ amlBasis: false, actorId: ACTOR, now: NOW, relationshipEndCandidates: [] });

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
    const plan = planContactErasure({ amlBasis: true, actorId: ACTOR, now: NOW, relationshipEndCandidates: [] });

    it("keeps the documents — destroying them would breach the retention duty", () => {
      expect(plan.deleteDocuments).toBe(false);
    });

    it("keeps the KYC checklist, which IS the due-diligence record", () => {
      expect(plan.patch.kyc).toBeUndefined();
    });

    it(`with no end-signal, stamps retention ${AML_RETENTION_YEARS} years from the erasure — it ends the relationship`, () => {
      expect(plan.retentionUntil).toBe("2031-07-21");
      expect(plan.patch.retention_until).toBe("2031-07-21");
    });
  });

  // CY-03 (2026-09-02): the clock anchors where the duty starts — the END of
  // the relationship — not where somebody happened to click Erase.
  describe("the retention anchor (CY-03)", () => {
    it("a deal closed years ago anchors the clock there — retention can already be over", () => {
      const plan = planContactErasure({
        amlBasis: true,
        actorId: ACTOR,
        now: NOW, // 2026-07-21
        relationshipEndCandidates: ["2020-03-15T09:00:00.000Z", null],
      });
      // 2020-03-15 + 5y — six years before the erasure; the duty has lapsed
      expect(plan.retentionUntil).toBe("2025-03-15");
    });

    it("the LATEST end-signal wins across signal types", () => {
      const plan = planContactErasure({
        amlBasis: true,
        actorId: ACTOR,
        now: NOW,
        relationshipEndCandidates: [
          "2021-01-01T00:00:00.000Z", // old lost deal
          "2024-06-30", // mandate expiry (date-only arrives like this)
          "2023-02-02T12:00:00.000Z", // slip signature
        ],
      });
      expect(plan.retentionUntil).toBe("2029-06-30");
    });

    it("a FUTURE mandate expiry clamps to now — the relationship was ongoing and the erasure ends it", () => {
      const plan = planContactErasure({
        amlBasis: true,
        actorId: ACTOR,
        now: NOW,
        relationshipEndCandidates: ["2030-01-01"],
      });
      expect(plan.retentionUntil).toBe("2031-07-21"); // NOW + 5y, not 2035
    });

    it("nulls and junk among the signals are ignored, not fatal", () => {
      expect(
        resolveRetentionAnchor([null, "not-a-date", "2022-05-05T00:00:00.000Z"], NOW),
      ).toBe("2022-05-05T00:00:00.000Z");
      expect(resolveRetentionAnchor([null, "garbage"], NOW)).toBe(NOW);
    });
  });

  it("records who erased and when", () => {
    const { patch } = planContactErasure({ amlBasis: false, actorId: ACTOR, now: NOW, relationshipEndCandidates: [] });
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
      requirementsDeleted: 0,
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

  it("reports SAVED SEARCHES as cleared, and counts them", () => {
    // 0055 dropped `contacts.preferences`, whose contents were the buyer's
    // criteria and were erased with the profiling layer. Those criteria are
    // `buyer_requirements` rows now. If this assertion ever fails, Article 17
    // has quietly stopped reaching a person's search history.
    const payload = buildErasureEventPayload({
      amlBasis: false,
      retentionUntil: null,
      leadsRedacted: 0,
      requirementsDeleted: 3,
      documentsDeleted: 0,
      documentsRetained: 0,
    });
    expect(payload.fields_cleared).toContain("saved_searches");
    expect(payload.saved_searches_deleted).toBe(3);
  });

  it("no longer claims to clear `preferences`, which no longer exists", () => {
    const payload = buildErasureEventPayload({
      amlBasis: false,
      retentionUntil: null,
      leadsRedacted: 0,
      requirementsDeleted: 0,
      documentsDeleted: 0,
      documentsRetained: 0,
    });
    expect(payload.fields_cleared).not.toContain("preferences");
  });

  it("reports the KYC checklist as cleared only when there is no AML basis", () => {
    const withAml = buildErasureEventPayload({
      amlBasis: true,
      retentionUntil: "2031-07-21",
      leadsRedacted: 0,
      requirementsDeleted: 0,
      documentsDeleted: 0,
      documentsRetained: 1,
    });
    const withoutAml = buildErasureEventPayload({
      amlBasis: false,
      retentionUntil: null,
      leadsRedacted: 0,
      requirementsDeleted: 0,
      documentsDeleted: 1,
      documentsRetained: 0,
    });
    expect(withAml.fields_cleared).not.toContain("kyc_checklist");
    expect(withoutAml.fields_cleared).toContain("kyc_checklist");
  });
});
