import { afterEach, describe, expect, it, vi } from "vitest";
import {
  newOperationId,
  sendPinned,
  settleOperation,
  stampOperationId,
  submissionKey,
  type OperationRef,
  type PinnedAnswer,
} from "./operation-id";

/**
 * One id per logical submission (T-price-uplift-atomic, 0141): the same
 * submission keeps its id — that is what lets the database answer a retry
 * instead of applying it again — and any change makes a new one.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newOperationId", () => {
  it("is a version-4 UUID", () => {
    expect(newOperationId()).toMatch(UUID);
    expect(newOperationId()).not.toBe(newOperationId());
  });

  it("is one in an insecure context too, where crypto.randomUUID does not exist", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    const ids = Array.from({ length: 50 }, () => newOperationId());
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(50);
  });
});

describe("submissionKey", () => {
  it("is everything but the id, in a stable order", () => {
    const a = form({ project_id: "p", amount: "3", operation_id: "x" });
    const b = form({ amount: "3", project_id: "p", operation_id: "y" });
    expect(submissionKey(a)).toBe(submissionKey(b));
    expect(submissionKey(a)).not.toBe(submissionKey(form({ project_id: "p", amount: "4" })));
  });
});

describe("stampOperationId", () => {
  it("the same submission keeps its id; a change — any field, the reviewed prices included — gets a new one", () => {
    const ref: OperationRef = { current: null };
    const first = form({ project_id: "p", amount: "3", expected: '[{"id":"u","price":1}]' });
    const id = stampOperationId(ref, first);
    expect(first.get("operation_id")).toBe(id);
    // a retry of exactly that submission (the id it carried is not part of the key)
    expect(stampOperationId(ref, form({ project_id: "p", amount: "3", expected: '[{"id":"u","price":1}]', operation_id: id }))).toBe(id);
    // the page redrew with the committed prices: a new submission
    const redrawn = stampOperationId(ref, form({ project_id: "p", amount: "3", expected: '[{"id":"u","price":2}]' }));
    expect(redrawn).not.toBe(id);
    // another amount: a new submission
    expect(stampOperationId(ref, form({ project_id: "p", amount: "4", expected: '[{"id":"u","price":2}]' }))).not.toBe(redrawn);
  });

  it("after an UNCONFIRMED answer the id stays pinned whatever the form then sends, until an answer is definite", () => {
    const ref: OperationRef = { current: null };
    const id = stampOperationId(ref, form({ project_id: "p", amount: "3", expected: '[{"id":"u","price":1}]' }));
    settleOperation(ref, true);
    // the page redrew with the committed price: still the same submission's id, so the
    // database answers what it committed (or refuses a changed request) — never a second apply
    expect(stampOperationId(ref, form({ project_id: "p", amount: "3", expected: '[{"id":"u","price":2}]' }))).toBe(id);
    expect(stampOperationId(ref, form({ project_id: "p", amount: "9", expected: '[{"id":"u","price":2}]' }))).toBe(id);
    // a definite answer releases it: the next changed submission is a new one
    settleOperation(ref, false);
    expect(stampOperationId(ref, form({ project_id: "p", amount: "3", expected: '[{"id":"u","price":3}]' }))).not.toBe(id);
  });
});

describe("sendPinned — a submission the person may repeat once it committed (a unit-type stamp, 0142)", () => {
  const STAMP = { project_id: "p", unit_type_id: "t", block: "A" };
  const UNKNOWN: PinnedAnswer = { error: "could not confirm", savedAt: null, unconfirmed: true };
  const applied: PinnedAnswer = { error: null, savedAt: 1 };
  const busy: PinnedAnswer = { error: "busy — nothing was changed", savedAt: null, busy: true };
  /** Records the operation id each press sent, answering with the scripted outcomes in turn. */
  function server(...answers: Array<PinnedAnswer | "throw">) {
    const sent: string[] = [];
    const send = async (fd: FormData) => {
      sent.push(String(fd.get("operation_id")));
      const a = answers.shift();
      if (a === undefined) throw new Error("no answer scripted");
      if (a === "throw") throw new TypeError("fetch failed");
      return a;
    };
    return { sent, send };
  }

  it("two confirmed stamps of the same selection are two submissions — the second applies, it is not replayed", async () => {
    const ref: OperationRef = { current: null };
    const s = server(applied, applied);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN);
    expect(s.sent[0]).not.toBe(s.sent[1]);
  });

  it("an unknown answer (or a throw) pins the id: the press to check sends the SAME id, even if the selection changed", async () => {
    const ref: OperationRef = { current: null };
    const s = server(UNKNOWN, "throw", applied);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN);
    expect(await sendPinned(ref, form(STAMP), s.send, UNKNOWN)).toEqual(UNKNOWN);
    await sendPinned(ref, form({ ...STAMP, block: "B" }), s.send, UNKNOWN);
    expect(new Set(s.sent).size, "one id across all three presses").toBe(1);
  });

  it("a replayed (committed) answer spends the id too", async () => {
    const ref: OperationRef = { current: null };
    const s = server(UNKNOWN, { error: null, savedAt: 2 }, applied);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN); // the check: replayed
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN); // a deliberate new stamp
    expect(s.sent[0]).toBe(s.sent[1]);
    expect(s.sent[2]).not.toBe(s.sent[1]);
  });

  it("a lock wait on a press CHECKING an unknown outcome stays unknown and pinned — its original may still commit", async () => {
    const ref: OperationRef = { current: null };
    const s = server(UNKNOWN, busy, applied);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN);
    expect(await sendPinned(ref, form(STAMP), s.send, UNKNOWN), "never 'nothing was changed' here").toEqual(UNKNOWN);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN);
    expect(new Set(s.sent).size).toBe(1);
  });

  it("a lock wait on a FIRST press is definite: shown as it is, and the same fields keep the same id", async () => {
    const ref: OperationRef = { current: null };
    const s = server(busy, applied);
    expect(await sendPinned(ref, form(STAMP), s.send, UNKNOWN)).toEqual(busy);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN);
    expect(s.sent[0]).toBe(s.sent[1]);
  });

  it("a definite refusal releases the pin: a changed selection after it is a new submission", async () => {
    const ref: OperationRef = { current: null };
    const refused: PinnedAnswer = { error: "Only admins and listing managers manage units.", savedAt: null };
    const s = server(UNKNOWN, refused, applied);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN);
    await sendPinned(ref, form(STAMP), s.send, UNKNOWN);
    await sendPinned(ref, form({ ...STAMP, block: "B" }), s.send, UNKNOWN);
    expect(s.sent[1]).toBe(s.sent[0]);
    expect(s.sent[2]).not.toBe(s.sent[1]);
  });
});
