import { describe, expect, it } from "vitest";
import { leadContactMode, splitEnquirerName } from "./lead-contact";

describe("leadContactMode", () => {
  it("prefers a linked existing contact over any typed name", () => {
    expect(leadContactMode({ contactId: "c1", newContactName: "New Person" })).toBe("link");
  });

  it("creates when only a new name is given", () => {
    expect(leadContactMode({ newContactName: "Δημήτρης Σαββίδης" })).toBe("create");
  });

  it("is none when neither is provided (or the name is blank)", () => {
    expect(leadContactMode({})).toBe("none");
    expect(leadContactMode({ newContactName: "   " })).toBe("none");
    expect(leadContactMode({ contactId: null, newContactName: null })).toBe("none");
  });
});

describe("splitEnquirerName", () => {
  it("splits on the first whitespace run", () => {
    expect(splitEnquirerName("Maria Georgiou")).toEqual({ firstName: "Maria", lastName: "Georgiou" });
    expect(splitEnquirerName("Anna Maria Papadopoulou")).toEqual({
      firstName: "Anna",
      lastName: "Maria Papadopoulou",
    });
  });

  it("keeps a single token as first name only", () => {
    expect(splitEnquirerName("Igor")).toEqual({ firstName: "Igor", lastName: null });
  });

  it("collapses extra whitespace", () => {
    expect(splitEnquirerName("  Nino   Charalambous  ")).toEqual({
      firstName: "Nino",
      lastName: "Charalambous",
    });
  });
});
