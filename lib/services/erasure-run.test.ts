import { describe, expect, it } from "vitest";
import { planContactErasure } from "./erasure";
import { runContactErasure, unredactedColumns, type ErasureBasis, type ErasureSteps } from "./erasure-run";

const NOW = "2026-09-06T10:00:00.000Z";
const ACTOR = "11111111-1111-1111-1111-111111111111";

const NO_BASIS: ErasureBasis = {
  dealCount: 0,
  viewingSlipCount: 0,
  mandateCount: 0,
  relationshipEndCandidates: [],
};
const AML_BASIS: ErasureBasis = {
  dealCount: 1,
  viewingSlipCount: 0,
  mandateCount: 0,
  relationshipEndCandidates: ["2026-01-01T00:00:00.000Z"],
};

/**
 * Steps that record the order they ran in and can be made to fail at any one
 * point — the six failure points the audit named, plus the two re-run cases.
 */
function harness(opts: {
  basis?: ErasureBasis;
  failAt?: keyof ErasureSteps;
  patchMatches?: boolean;
  erasedEventExists?: boolean;
  docs?: { id: string; storage_path: string | null }[];
}) {
  const calls: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  const deletedIds: string[][] = [];
  const step = <T>(name: keyof ErasureSteps, value: T) => async () => {
    calls.push(name);
    if (opts.failAt === name) throw new Error(`${name} failed`);
    return value;
  };
  const docs = opts.docs ?? [{ id: "d1", storage_path: "kyc/d1.pdf" }];
  const steps: ErasureSteps = {
    readBasis: step("readBasis", opts.basis ?? NO_BASIS),
    hasErasedEvent: step("hasErasedEvent", opts.erasedEventExists ?? false),
    redactLeads: step("redactLeads", 2),
    redactNotes: step("redactNotes", 1),
    deleteRequirements: step("deleteRequirements", 1),
    listDocuments: step("listDocuments", docs),
    removeObjects: async (paths) => {
      calls.push(`removeObjects:${paths.join(",")}`);
      if (opts.failAt === "removeObjects") throw new Error("removeObjects failed");
    },
    deleteDocumentRows: async (ids) => {
      calls.push("deleteDocumentRows");
      if (opts.failAt === "deleteDocumentRows") throw new Error("deleteDocumentRows failed");
      deletedIds.push(ids);
      return ids.length;
    },
    patchContact: async () => {
      calls.push("patchContact");
      if (opts.failAt === "patchContact") throw new Error("patchContact failed");
      return opts.patchMatches ?? true;
    },
    writeEvent: async (payload) => {
      calls.push("writeEvent");
      if (opts.failAt === "writeEvent") throw new Error("writeEvent failed");
      payloads.push(payload);
    },
  };
  return { steps, calls, payloads, deletedIds };
}

/** A row as the first run's patch left it (no AML basis unless a retention date is given). */
function erasedRow(retentionUntil: string | null = null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { patch } = planContactErasure({ amlBasis: retentionUntil !== null, actorId: ACTOR, now: "2026-09-05T09:00:00.000Z", relationshipEndCandidates: [] });
  return { id: "c1", first_name: "Retained", phone_e164: "+35799000000", ...patch, retention_until: retentionUntil, ...extra };
}

const run = (
  h: ReturnType<typeof harness>,
  alreadyErasedAt: string | null = null,
  stored: Record<string, unknown> | null = alreadyErasedAt ? erasedRow() : null,
) => runContactErasure({ alreadyErasedAt, stored, actorId: ACTOR, now: NOW, steps: h.steps });

describe("the document rows deleted are exactly the listed ones", () => {
  it("passes the listed ids — a row added after the listing keeps its row, for its file", async () => {
    const h = harness({ docs: [{ id: "d1", storage_path: "kyc/d1.pdf" }, { id: "d2", storage_path: null }] });
    await run(h);
    expect(h.deletedIds).toEqual([["d1", "d2"]]);
  });
});

describe("the order: dependants first, the contact last, the record after", () => {
  it("runs every step in the order a re-run can finish, and the patch is the last write", async () => {
    const h = harness({});
    const r = await run(h);
    expect(r).toEqual({ error: null, erasedAt: NOW });
    expect(h.calls).toEqual([
      "readBasis",
      "redactLeads",
      "redactNotes",
      "deleteRequirements",
      "listDocuments",
      "removeObjects:kyc/d1.pdf",
      "deleteDocumentRows",
      "patchContact",
      "writeEvent",
    ]);
    expect(h.payloads[0]).toMatchObject({
      leads_redacted: 2,
      saved_searches_deleted: 1,
      documents_deleted: 1,
      documents_retained: 0,
    });
  });

  it("keeps the documents when an AML relationship exists, and says so in the record", async () => {
    const h = harness({ basis: AML_BASIS });
    await run(h);
    expect(h.calls).not.toContain("removeObjects:kyc/d1.pdf");
    expect(h.calls).not.toContain("deleteDocumentRows");
    expect(h.payloads[0]).toMatchObject({ documents_deleted: 0, documents_retained: 1 });
  });
});

describe("a failed basis read is an error, never 'no relationship'", () => {
  it("erases nothing — the old code would have destroyed the AML documents", async () => {
    const h = harness({ failAt: "readBasis" });
    const r = await run(h);
    expect(r.erasedAt).toBeNull();
    expect(r.error).toContain("Could not establish the retention basis");
    expect(r.error).toContain("nothing was erased");
    expect(h.calls).toEqual(["readBasis"]);
  });
});

describe("each write failure stops before the contact is marked erased", () => {
  for (const at of ["redactLeads", "redactNotes", "deleteRequirements", "listDocuments", "removeObjects", "deleteDocumentRows"] as const) {
    it(`${at} failing leaves erased_at unset and names the step`, async () => {
      const h = harness({ failAt: at });
      const r = await run(h);
      expect(r.erasedAt).toBeNull();
      expect(r.error).toContain("run it again");
      expect(r.error).toMatch(/redacting|deleting|listing|removing/);
      expect(h.calls).not.toContain("patchContact");
      expect(h.calls).not.toContain("writeEvent");
    });
  }

  it("a storage failure leaves the document rows for the next run to find", async () => {
    const h = harness({ failAt: "removeObjects" });
    await run(h);
    expect(h.calls).not.toContain("deleteDocumentRows");
  });

  it("a patch that matches no row (erased meanwhile — 0134 runs it as the system) says so, and writes no record", async () => {
    const h = harness({ patchMatches: false });
    const r = await run(h);
    expect(r).toEqual({ error: "This contact was erased meanwhile — reload the page to see its record.", erasedAt: null });
    expect(h.calls).not.toContain("writeEvent");
  });

  it("a patch error stops with erased_at unset", async () => {
    const h = harness({ failAt: "patchContact" });
    const r = await run(h);
    expect(r.erasedAt).toBeNull();
    expect(r.error).toContain("redacting the contact");
  });
});

describe("the record", () => {
  it("failing after the patch reports erased-but-unrecorded, so the re-run knows what is left", async () => {
    const h = harness({ failAt: "writeEvent" });
    const r = await run(h);
    expect(r.erasedAt).toBe(NOW);
    expect(r.error).toContain("record of it failed to write");
    expect(r.error).toContain("only the record will be written");
  });
});

describe("re-running", () => {
  it("a contact with erased_at but no event is finished: steps re-run, the patch is skipped, the event is written", async () => {
    const h = harness({ erasedEventExists: false, docs: [] });
    const r = await run(h, "2026-09-05T09:00:00.000Z");
    expect(r).toEqual({ error: null, erasedAt: "2026-09-05T09:00:00.000Z" });
    expect(h.calls[0]).toBe("hasErasedEvent");
    expect(h.calls).not.toContain("patchContact");
    expect(h.calls).toContain("writeEvent");
  });

  it("a contact whose erasure is recorded is refused, and nothing runs", async () => {
    const h = harness({ erasedEventExists: true });
    const r = await run(h, "2026-09-05T09:00:00.000Z");
    expect(r.error).toContain("already been erased");
    expect(h.calls).toEqual(["hasErasedEvent"]);
  });

  it("a marker without the redaction (a session could set erased_at before 0134) is not recorded as an erasure: refused before any write", async () => {
    const h = harness({ erasedEventExists: false });
    const r = await run(h, "2026-09-05T09:00:00.000Z", erasedRow(null, { notes: "still here", consent_marketing: true, is_archived: false }));
    expect(r).toEqual({
      error:
        "This contact is marked erased, but it still holds what the erasure clears (consent_marketing, is_archived, notes), so the erasure will not be recorded as done. Nothing was changed — an administrator must resolve it first (DECISIONS T-erasure-lifecycle-guard).",
      erasedAt: null,
    });
    expect(h.calls).toEqual(["hasErasedEvent", "readBasis"]);
    expect(h.payloads).toEqual([]);
  });

  it("a re-run without the stored row fails closed", async () => {
    const h = harness({ erasedEventExists: false, docs: [] });
    const r = await run(h, "2026-09-05T09:00:00.000Z", null);
    expect(r.erasedAt).toBeNull();
    expect(r.error).toMatch(/^This contact is marked erased, but it still holds what the erasure clears \(/);
    expect(h.calls).not.toContain("writeEvent");
  });

  it("a re-run takes the first run's AML decision from the row: a stored retention date keeps the files, and the record reports that date", async () => {
    const h = harness({ basis: AML_BASIS, erasedEventExists: false });
    const r = await run(h, "2026-09-05T09:00:00.000Z", erasedRow("2031-09-05"));
    expect(r).toEqual({ error: null, erasedAt: "2026-09-05T09:00:00.000Z" });
    expect(h.calls.some((c) => c.startsWith("removeObjects"))).toBe(false);
    expect(h.calls).not.toContain("deleteDocumentRows");
    expect(h.payloads[0]).toMatchObject({ aml_basis: true, retention_until: "2031-09-05", documents_retained: 1, documents_deleted: 0 });
  });

  it("…and no stored date destroys what is listed, records no basis, and checks the KYC checklist was cleared", async () => {
    const h = harness({ basis: NO_BASIS, erasedEventExists: false, docs: [{ id: "d9", storage_path: "kyc/d9.pdf" }] });
    expect(await run(h, "2026-09-05T09:00:00.000Z", erasedRow(null, { kyc: { passport: { done: true } } }))).toMatchObject({
      erasedAt: null,
      error: expect.stringMatching(/still holds what the erasure clears \(kyc\)/),
    });
    const h2 = harness({ basis: NO_BASIS, erasedEventExists: false, docs: [{ id: "d9", storage_path: "kyc/d9.pdf" }] });
    expect(await run(h2, "2026-09-05T09:00:00.000Z", erasedRow(null))).toEqual({ error: null, erasedAt: "2026-09-05T09:00:00.000Z" });
    expect(h2.deletedIds).toEqual([["d9"]]);
    expect(h2.payloads[0]).toMatchObject({ aml_basis: false, retention_until: null, documents_deleted: 1, documents_retained: 0 });
    expect(h2.payloads[0]!.fields_cleared).toContain("kyc_checklist");
  });

  it.each([
    ["files were kept, but no basis reads today", NO_BASIS, "2031-09-05", /erased with its records retained, but its retention basis reads differently now/],
    ["nothing was kept, but a basis reads today (a record linked since)", AML_BASIS, null, /erased with nothing retained, but its retention basis reads differently now/],
  ] as const)("a re-run whose basis disagrees with the stored decision is refused before any write: %s", async (_label, basis, stored, sentence) => {
    const h = harness({ basis, erasedEventExists: false });
    const r = await run(h, "2026-09-05T09:00:00.000Z", erasedRow(stored));
    expect(r.erasedAt).toBeNull();
    expect(r.error).toMatch(sentence);
    expect(r.error).toMatch(/Nothing was changed — an administrator must resolve it first/);
    expect(h.calls).toEqual(["hasErasedEvent", "readBasis"]);
  });

  it("a re-run records the stored retention date, not one recomputed today", async () => {
    const h = harness({ basis: AML_BASIS, erasedEventExists: false });
    await run(h, "2026-09-05T09:00:00.000Z", erasedRow("2030-05-05"));
    expect(h.payloads[0]).toMatchObject({ aml_basis: true, retention_until: "2030-05-05" });
  });

  it("a first run ignores the stored row (it has not been redacted yet)", async () => {
    const h = harness({});
    const r = await run(h, null, { notes: "about to be erased", consent_marketing: true });
    expect(r).toEqual({ error: null, erasedAt: NOW });
    expect(h.calls).toContain("patchContact");
  });
});

describe("unredactedColumns", () => {
  const { patch } = planContactErasure({ amlBasis: false, actorId: ACTOR, now: NOW, relationshipEndCandidates: [] });
  it("is empty for the row the patch leaves, whatever the record columns hold", () => {
    expect(unredactedColumns(patch, { ...patch, erased_at: "x", erased_by: "y", retention_until: null, gdpr_notes: "other words", banking_readiness: {} })).toEqual([]);
  });
  it("compares objects by content, not key order (Postgres returns jsonb keys in its own order)", () => {
    // every object the patch writes today is {}: this pins the rule for the first one that is not
    const withObject = { ...patch, banking_readiness: { funds_origin_country: "GB", account_feasibility: "yes" } } as unknown as typeof patch;
    expect(unredactedColumns(withObject, { ...withObject, banking_readiness: { account_feasibility: "yes", funds_origin_country: "GB" } })).toEqual([]);
    expect(unredactedColumns(withObject, { ...withObject, banking_readiness: { account_feasibility: "no", funds_origin_country: "GB" } })).toEqual([
      "banking_readiness",
    ]);
  });
  it("names every redacted column the row still holds, and every column when there is no row", () => {
    expect(unredactedColumns(patch, { ...patch, psychology: "investor", languages: ["el", "en"], kyc: { passport: { done: true } } })).toEqual([
      "kyc",
      "languages",
      "psychology",
    ]);
    expect(unredactedColumns(patch, null)).toEqual(Object.keys(patch).filter((k) => !["erased_at", "erased_by", "retention_until", "gdpr_notes"].includes(k)).sort());
  });
  it("leaves kyc alone when files were retained (the patch keeps the checklist)", () => {
    const retained = planContactErasure({ amlBasis: true, actorId: ACTOR, now: NOW, relationshipEndCandidates: [] }).patch;
    expect(unredactedColumns(retained, { ...retained, kyc: { passport: { done: true } } })).toEqual([]);
  });
});
