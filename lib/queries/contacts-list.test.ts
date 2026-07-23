import { describe, expect, it } from "vitest";
import { parseContactListFilters } from "./contacts-list";

describe("parseContactListFilters", () => {
  it("reads every filter the list understands", () => {
    const f = parseContactListFilters({
      q: "  smith ",
      type: "buyer",
      temperature: "hot",
      source: "referral",
      agent: "agent-1",
      nationality: " GB ",
      language: "el",
      archived: "1",
    });
    expect(f).toEqual({
      q: "smith",
      type: "buyer",
      temperature: "hot",
      source: "referral",
      agent: "agent-1",
      nationality: "GB",
      language: "el",
      archived: true,
    });
  });

  it("defaults to the active (non-archived) scope and drops blanks", () => {
    const f = parseContactListFilters({ q: "   ", nationality: "" });
    expect(f.archived).toBe(false);
    expect(f.q).toBeUndefined();
    expect(f.nationality).toBeUndefined();
    expect(f.type).toBeUndefined();
  });

  it("treats archived as true only for the exact flag '1'", () => {
    expect(parseContactListFilters({ archived: "1" }).archived).toBe(true);
    expect(parseContactListFilters({ archived: "true" }).archived).toBe(false);
    expect(parseContactListFilters({ archived: "0" }).archived).toBe(false);
    expect(parseContactListFilters({}).archived).toBe(false);
  });

  it("takes the first value when a param repeats", () => {
    expect(parseContactListFilters({ type: ["buyer", "seller"] }).type).toBe("buyer");
  });
});
