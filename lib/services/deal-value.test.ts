import { describe, expect, it } from "vitest";
import { dealValue } from "./deal-value";

describe("dealValue — what a deal is worth on the board", () => {
  it("a won deal counts at its confirmed final value", () => {
    expect(dealValue({ status: "won", expected_value: 100_000, final_value: 250_000 })).toBe(250_000);
  });

  it("a won deal with no final value recorded counts at its estimate", () => {
    expect(dealValue({ status: "won", expected_value: 80_000, final_value: null })).toBe(80_000);
  });

  it("an open or lost deal counts at its estimate, whatever final_value holds", () => {
    expect(dealValue({ status: "open", expected_value: 90_000, final_value: 1 })).toBe(90_000);
    expect(dealValue({ status: "lost", expected_value: 70_000, final_value: 1 })).toBe(70_000);
  });

  it("no estimate and no final value is no figure, not zero", () => {
    expect(dealValue({ status: "won", expected_value: null, final_value: null })).toBeNull();
    expect(dealValue({ status: "open", expected_value: null })).toBeNull();
  });
});
