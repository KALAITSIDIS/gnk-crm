import { describe, expect, it } from "vitest";
import { propertyFiltersSchema } from "./properties";

/**
 * The list's view on a phone (audit CRM-06).
 *
 * The properties page defaulted to the twelve-column table whatever the
 * screen, so a phone showed reference and title and pushed everything else
 * off the right edge; the cards view existed behind a toggle nobody on a
 * phone would find. No `view` in the URL now means "auto": cards below the
 * tablet breakpoint, the table from it up. An explicit choice is honoured
 * everywhere, as before.
 */
const parse = (view?: string) => propertyFiltersSchema.parse({ view }).view;

describe("the view filter", () => {
  it("is auto when the URL says nothing", () => {
    expect(parse(undefined)).toBe("auto");
    expect(parse("")).toBe("auto");
  });

  it("honours an explicit cards or table", () => {
    expect(parse("cards")).toBe("cards");
    expect(parse("table")).toBe("table");
  });

  it("treats anything else as auto rather than as a table", () => {
    expect(parse("grid")).toBe("auto");
  });
});
