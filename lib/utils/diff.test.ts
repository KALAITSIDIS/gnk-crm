import { describe, expect, it } from "vitest";
import { changedValue, stableStringify } from "./diff";

describe("changedValue", () => {
  it("treats null, undefined and empty string as equal", () => {
    expect(changedValue(null, undefined)).toBe(false);
    expect(changedValue("", null)).toBe(false);
    expect(changedValue(undefined, "")).toBe(false);
  });

  it("compares numbers and their string representations as equal", () => {
    expect(changedValue("450000", 450000)).toBe(false);
    expect(changedValue(3, "3")).toBe(false);
    expect(changedValue("450000", 450001)).toBe(true);
  });

  it("ignores jsonb key re-ordering (Postgres returns {el,en} for {en,el})", () => {
    expect(changedValue({ el: "Βίλα", en: "Villa" }, { en: "Villa", el: "Βίλα" })).toBe(false);
    expect(changedValue({ el: "Βίλα", en: "Villa" }, { en: "Villa", el: "Σπίτι" })).toBe(true);
  });

  it("sorts keys at every depth", () => {
    expect(
      changedValue(
        { b: { y: 1, x: 2 }, a: 0 },
        { a: 0, b: { x: 2, y: 1 } },
      ),
    ).toBe(false);
  });

  it("keeps array order significant", () => {
    expect(changedValue(["pool", "garage"], ["pool", "garage"])).toBe(false);
    expect(changedValue(["pool", "garage"], ["garage", "pool"])).toBe(true);
  });

  it("detects boolean changes across representations", () => {
    expect(changedValue(true, "true")).toBe(false);
    expect(changedValue(null, false)).toBe(true);
  });
});

describe("stableStringify", () => {
  it("produces identical output regardless of insertion order", () => {
    expect(stableStringify({ en: "a", el: "b", ru: "c" })).toBe(
      stableStringify({ ru: "c", el: "b", en: "a" }),
    );
  });
});
