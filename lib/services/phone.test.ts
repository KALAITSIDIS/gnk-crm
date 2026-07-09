import { describe, expect, it } from "vitest";
import { formatPhone, normalizePhone } from "./phone";

describe("normalizePhone (E.164, CY default — doc 02 §A12)", () => {
  it("normalizes local Cyprus mobile input '99 123456'", () => {
    expect(normalizePhone("99 123456")?.e164).toBe("+35799123456");
  });

  it("normalizes dotted/dashed local input", () => {
    expect(normalizePhone("99-12-34-56")?.e164).toBe("+35799123456");
    expect(normalizePhone("99.123.456")?.e164).toBe("+35799123456");
  });

  it("keeps full international numbers on their own country", () => {
    const uk = normalizePhone("+44 20 7946 0958");
    expect(uk?.e164).toBe("+442079460958");
    expect(uk?.country).toBe("GB");

    const ru = normalizePhone("+7 916 123-45-67");
    expect(ru?.e164).toBe("+79161234567");
    expect(ru?.country).toBe("RU");
  });

  it("handles 00-prefixed international dialing", () => {
    expect(normalizePhone("0044 7911 123456")?.e164).toBe("+447911123456");
  });

  it("returns null for invalid input", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("not a phone")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
  });

  it("detects CY as country for local input", () => {
    expect(normalizePhone("99123456")?.country).toBe("CY");
  });
});

describe("formatPhone", () => {
  it("formats E.164 for display", () => {
    expect(formatPhone("+35799123456")).toBe("+357 99 123456");
  });

  it("passes through unparseable values", () => {
    expect(formatPhone("garbage")).toBe("garbage");
  });
});
