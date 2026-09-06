import { describe, expect, it } from "vitest";
import { runContactErasure, type ErasureBasis, type ErasureSteps } from "./erasure-run";

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
    deleteRequirements: step("deleteRequirements", 1),
    listDocuments: step("listDocuments", docs),
    removeObjects: async (paths) => {
      calls.push(`removeObjects:${paths.join(",")}`);
      if (opts.failAt === "removeObjects") throw new Error("removeObjects failed");
    },
    deleteDocumentRows: step("deleteDocumentRows", docs.length),
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
  return { steps, calls, payloads };
}

const run = (h: ReturnType<typeof harness>, alreadyErasedAt: string | null = null) =>
  runContactErasure({ alreadyErasedAt, actorId: ACTOR, now: NOW, steps: h.steps });

describe("the order: dependants first, the contact last, the record after", () => {
  it("runs every step in the order a re-run can finish, and the patch is the last write", async () => {
    const h = harness({});
    const r = await run(h);
    expect(r).toEqual({ error: null, erasedAt: NOW });
    expect(h.calls).toEqual([
      "readBasis",
      "redactLeads",
      "deleteRequirements",
      "listDocuments",
      "removeObjects:kyc/d1.pdf",
      "deleteDocumentRows",
      "patchContact",
      "writeEvent",
    ]);
    expect(h.payloads[0]).toMatchObject({
      leads_redacted: 2,
      requirements_deleted: 1,
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
  for (const at of ["redactLeads", "deleteRequirements", "listDocuments", "removeObjects", "deleteDocumentRows"] as const) {
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

  it("a patch that matches no row is a permission refusal, and writes no record", async () => {
    const h = harness({ patchMatches: false });
    const r = await run(h);
    expect(r).toEqual({ error: "You don't have permission to erase this contact.", erasedAt: null });
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
});
