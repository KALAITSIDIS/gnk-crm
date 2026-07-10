import { describe, expect, it } from "vitest";
import { clockState, elapsedLabel } from "./response-clock";

const base = new Date("2026-07-10T10:00:00Z");
const after = (ms: number) => new Date(base.getTime() + ms);
const MIN = 60 * 1000;

describe("clockState boundaries (doc T2.4: 4:59 green / 59:59 amber)", () => {
  it("green until 4:59, amber at exactly 5:00", () => {
    expect(clockState(base, null, after(4 * MIN + 59 * 1000))).toBe("green");
    expect(clockState(base, null, after(5 * MIN))).toBe("amber");
  });

  it("amber until 59:59, red at exactly 60:00", () => {
    expect(clockState(base, null, after(59 * MIN + 59 * 1000))).toBe("amber");
    expect(clockState(base, null, after(60 * MIN))).toBe("red");
  });

  it("answered leads are grey regardless of elapsed time", () => {
    expect(clockState(base, after(2 * MIN), after(90 * MIN))).toBe("answered");
    expect(clockState(base, after(70 * MIN), after(90 * MIN))).toBe("answered");
  });

  it("fresh lead is green at 0:00", () => {
    expect(clockState(base, null, base)).toBe("green");
  });
});

describe("elapsedLabel", () => {
  it("formats minutes and hours", () => {
    expect(elapsedLabel(base, after(3 * MIN))).toBe("3m");
    expect(elapsedLabel(base, after(59 * MIN))).toBe("59m");
    expect(elapsedLabel(base, after(135 * MIN))).toBe("2h 15m");
  });
});
