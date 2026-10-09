import { describe, expect, it } from "vitest";
import { dealValue, dealValueIsFinal } from "./deal-value";

describe("dealValueIsFinal — is the displayed figure the confirmed price?", () => {
  it("a won deal with a final value recorded: yes — including a confirmed 0", () => {
    expect(dealValueIsFinal({ status: "won", final_value: 250_000 })).toBe(true);
    expect(dealValueIsFinal({ status: "won", final_value: 0 })).toBe(true);
  });

  it("a won deal with no final value (legacy, or an override close without a figure): no — it shows its estimate", () => {
    expect(dealValueIsFinal({ status: "won", final_value: null })).toBe(false);
  });

  it("an open or lost deal: no, whatever stray final_value it holds", () => {
    expect(dealValueIsFinal({ status: "open", final_value: 1 })).toBe(false);
    expect(dealValueIsFinal({ status: "lost", final_value: 1 })).toBe(false);
  });

  it("agrees with dealValue: when it says final, dealValue is the final value", () => {
    for (const d of [
      { status: "won", expected_value: 999_999, final_value: 250_000 },
      { status: "won", expected_value: 999_999, final_value: null },
      { status: "won", expected_value: 90_000, final_value: 0 },
      { status: "open", expected_value: 70_000, final_value: 1 },
    ]) {
      expect(dealValue(d)).toBe(dealValueIsFinal(d) ? d.final_value : d.expected_value);
    }
  });
});

describe("dealValue — what a deal is displayed at on the board", () => {
  it("a won deal counts at its confirmed final value", () => {
    expect(dealValue({ status: "won", expected_value: 100_000, final_value: 250_000 })).toBe(250_000);
    expect(dealValue({ status: "won", expected_value: 200_000, final_value: 250_000 })).toBe(250_000);
  });

  it("a won deal with no final value recorded (a legacy or override close) counts at its estimate", () => {
    expect(dealValue({ status: "won", expected_value: 80_000, final_value: null })).toBe(80_000);
  });

  it("a confirmed final value of 0 stays 0 — the fallback tests for null, never truthiness", () => {
    expect(dealValue({ status: "won", expected_value: 90_000, final_value: 0 })).toBe(0);
  });

  it("a won deal with a final value but no estimate counts at the final value", () => {
    expect(dealValue({ status: "won", expected_value: null, final_value: 120_000 })).toBe(120_000);
  });

  it("an open or lost deal counts at its estimate, whatever final_value holds", () => {
    expect(dealValue({ status: "open", expected_value: 90_000, final_value: 1 })).toBe(90_000);
    expect(dealValue({ status: "lost", expected_value: 70_000, final_value: 1 })).toBe(70_000);
    expect(dealValue({ status: "lost", expected_value: 70_000, final_value: null })).toBe(70_000);
  });

  it("no estimate and no final value is no figure, not zero", () => {
    expect(dealValue({ status: "won", expected_value: null, final_value: null })).toBeNull();
    expect(dealValue({ status: "open", expected_value: null, final_value: null })).toBeNull();
  });

  it("keeps cents exactly as stored", () => {
    expect(dealValue({ status: "won", expected_value: 1000.1, final_value: 1000.25 })).toBe(1000.25);
  });

  it("reads the row, never changes it — the stored estimate is untouched", () => {
    const row = Object.freeze({ status: "won", expected_value: 200_000, final_value: 250_000 });
    expect(dealValue(row)).toBe(250_000);
    expect(row).toEqual({ status: "won", expected_value: 200_000, final_value: 250_000 });
  });

  it("requires final_value in its type, so a caller whose select forgot it cannot compile — and at run time a missing key is 'none recorded'", () => {
    // @ts-expect-error final_value is required — `npm run typecheck` fails if this ever compiles
    expect(dealValue({ status: "won", expected_value: 80_000 })).toBe(80_000);
  });
});
