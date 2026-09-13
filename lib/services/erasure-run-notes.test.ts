import { describe, expect, it } from "vitest";
import { runContactErasure, type ErasureBasis, type ErasureSteps } from "./erasure-run";

/**
 * Erasure blanks the notes about a person (audit SEC-03): the words that
 * used to sit in the chain now sit in interaction_notes, and the runner
 * redacts them as it redacts the person's lead messages — after the leads,
 * before the documents, and counted in the compliance event.
 */
const NOW = "2026-09-13T18:00:00.000Z";
const ACTOR = "11111111-1111-1111-1111-111111111111";
const NO_BASIS: ErasureBasis = { dealCount: 0, viewingSlipCount: 0, mandateCount: 0, relationshipEndCandidates: [] };

function harness(failAt?: keyof ErasureSteps) {
  const calls: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  const step = <T>(name: keyof ErasureSteps, value: T) => async () => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
    return value;
  };
  const steps: ErasureSteps = {
    readBasis: step("readBasis", NO_BASIS),
    hasErasedEvent: step("hasErasedEvent", false),
    redactLeads: step("redactLeads", 2),
    redactNotes: step("redactNotes", 3),
    deleteRequirements: step("deleteRequirements", 0),
    listDocuments: step("listDocuments", []),
    removeObjects: async () => {
      calls.push("removeObjects");
    },
    deleteDocumentRows: step("deleteDocumentRows", 0),
    patchContact: async () => {
      calls.push("patchContact");
      return true;
    },
    writeEvent: async (payload) => {
      calls.push("writeEvent");
      payloads.push(payload);
    },
  };
  return { steps, calls, payloads };
}

describe("runContactErasure and notes", () => {
  it("redacts notes right after the lead messages and records how many", async () => {
    const h = harness();
    const result = await runContactErasure({ alreadyErasedAt: null, actorId: ACTOR, now: NOW, steps: h.steps });
    expect(result.error).toBeNull();
    expect(h.calls.indexOf("redactNotes")).toBe(h.calls.indexOf("redactLeads") + 1);
    expect(h.payloads[0]).toMatchObject({ leads_redacted: 2, notes_redacted: 3 });
  });

  it("names the step when note redaction fails, and writes no erased event", async () => {
    const h = harness("redactNotes");
    const result = await runContactErasure({ alreadyErasedAt: null, actorId: ACTOR, now: NOW, steps: h.steps });
    expect(result.error).toMatch(/redacting notes/);
    expect(h.calls).not.toContain("writeEvent");
  });
});
