import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HARD_REQUIREMENT_FIELDS, SOFT_REQUIREMENT_FIELDS } from "@/lib/services/matching";

// the card's actions, outside a Next app: rendering the fields needs none of them
vi.mock("@/lib/actions/buyer-requirements", () => ({
  saveBuyerRequirement: vi.fn(),
  setBuyerRequirementActive: vi.fn(),
}));

const { RequirementFields } = await import("@/components/features/contacts/requirements-card");

/**
 * The saved-search form tells the desk which fields HIDE a listing ("Must
 * match") and which only RANK it ("Preferences") — A04. matching.test.ts pins
 * the engine's two lists to its rules; this pins the FORM to the lists, as
 * rendered: every hard field's control sits under "Must match", every soft
 * one under "Preferences", none twice. Controls are found by their ids
 * (`<field>-new`, `<field>-label-new` for a group): Radix renders a field's
 * native input only inside a mounted form, so names are not in static markup.
 */

const markup = renderToStaticMarkup(
  createElement(RequirementFields, {
    districts: [{ id: "d1", name: "Paphos" }],
    areas: [{ id: "a1", name: "Kato Paphos" }],
  }),
);

const at = (field: string) => {
  const control = markup.indexOf(`id="${field}-new"`);
  return control !== -1 ? control : markup.indexOf(`id="${field}-label-new"`);
};
const mustMatch = markup.indexOf(">Must match<");
const preferences = markup.indexOf(">Preferences<");

describe("the saved-search form groups its fields as the matcher treats them", () => {
  it("has both headings, Must match first, and says the budget tolerance", () => {
    expect(mustMatch).toBeGreaterThan(-1);
    expect(preferences).toBeGreaterThan(mustMatch);
    expect(markup).toContain("The budget allows 10% over");
    expect(markup).toContain("they never hide one");
  });

  it.each([...HARD_REQUIREMENT_FIELDS])("%s is under Must match", (field) => {
    const pos = at(field);
    expect(pos, `${field} is rendered`).toBeGreaterThan(-1);
    expect(pos).toBeGreaterThan(mustMatch);
    expect(pos).toBeLessThan(preferences);
  });

  it.each([...SOFT_REQUIREMENT_FIELDS])("%s is under Preferences", (field) => {
    const pos = at(field);
    expect(pos, `${field} is rendered`).toBeGreaterThan(-1);
    expect(pos).toBeGreaterThan(preferences);
  });

  it("each control appears once — two forms' ids are suffixed, one form's are unique", () => {
    for (const field of [...HARD_REQUIREMENT_FIELDS, ...SOFT_REQUIREMENT_FIELDS]) {
      const ids = markup.match(new RegExp(`id="${field}(-label)?-new"`, "g")) ?? [];
      expect(ids, field).toHaveLength(1);
    }
  });
});
