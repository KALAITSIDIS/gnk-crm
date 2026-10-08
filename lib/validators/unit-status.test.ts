import { describe, expect, it } from "vitest";
import {
  describeUnitStatusOutcome,
  UNIT_STATUS_BUSY,
  UNIT_STATUS_FOLLOW_UP_OPEN,
  UNIT_STATUS_FOLLOW_UP_UNRECORDED,
  UNIT_STATUS_REPLAYED,
  UNIT_STATUS_UNCONFIRMED,
} from "./unit-status";

/**
 * What the units grid says about one answer of updateUnitStatus, and what it
 * offers to do next (T-unit-status-atomic, 0143). The grid's toast is the only
 * place a person learns whether a status change happened — an unknown outcome
 * must never read as saved or as refused, and a committed change must never
 * read as failed because its follow-up did not finish.
 */
describe("describeUnitStatusOutcome", () => {
  it("unknown: an error, offering Check — the same change again", () => {
    expect(describeUnitStatusOutcome({ error: UNIT_STATUS_UNCONFIRMED, savedAt: null, unconfirmed: true }, "sold")).toEqual({
      tone: "error",
      text: UNIT_STATUS_UNCONFIRMED,
      offer: "check",
    });
  });

  it("a definite refusal (busy included): an error, nothing offered — a new pick is a new change", () => {
    for (const r of [
      { error: "Only an admin can move a sold or rented unit back to market.", savedAt: null },
      { error: UNIT_STATUS_BUSY, savedAt: null, busy: true },
    ]) {
      expect(describeUnitStatusOutcome(r, "available")).toEqual({ tone: "error", text: r.error, offer: null });
    }
  });

  it("saved with the follow-up left open: a warning offering Retry, never an error", () => {
    expect(describeUnitStatusOutcome({ error: null, savedAt: 1, notice: UNIT_STATUS_FOLLOW_UP_OPEN }, "sold")).toEqual({
      tone: "warning",
      text: UNIT_STATUS_FOLLOW_UP_OPEN,
      offer: "retry",
    });
  });

  it("a notice outranks a replay — the retry meant to finish the follow-up may not have", () => {
    expect(
      describeUnitStatusOutcome({ error: null, savedAt: 1, replayed: true, notice: UNIT_STATUS_FOLLOW_UP_OPEN }, "sold").offer,
    ).toBe("retry");
  });

  it("saved, the task closed without its line: a warning, nothing to retry (no run can write that line later)", () => {
    expect(describeUnitStatusOutcome({ error: null, savedAt: 1, notice: UNIT_STATUS_FOLLOW_UP_UNRECORDED }, "sold")).toEqual({
      tone: "warning",
      text: UNIT_STATUS_FOLLOW_UP_UNRECORDED,
      offer: null,
    });
  });

  it("a replay and an unchanged unit are said as such; a change is Saved", () => {
    expect(describeUnitStatusOutcome({ error: null, savedAt: 1, replayed: true }, "sold")).toEqual({
      tone: "info",
      text: UNIT_STATUS_REPLAYED,
      offer: null,
    });
    expect(describeUnitStatusOutcome({ error: null, savedAt: 1, unchanged: true }, "under_offer")).toEqual({
      tone: "info",
      text: "Already under offer — nothing to change.",
      offer: null,
    });
    expect(describeUnitStatusOutcome({ error: null, savedAt: 1 }, "sold")).toEqual({ tone: "success", text: "Saved", offer: null });
  });
});
