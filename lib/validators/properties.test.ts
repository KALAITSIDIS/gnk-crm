import { describe, expect, it } from "vitest";
import { propertyFiltersSchema, resolvePropertyScope } from "./properties";

describe("propertyFiltersSchema scope", () => {
  it("defaults to the active scope", () => {
    const parsed = propertyFiltersSchema.parse({});
    expect(parsed.scope).toBe("active");
  });

  it("accepts the known scopes and drops unknown ones to active", () => {
    expect(propertyFiltersSchema.parse({ scope: "archived" }).scope).toBe("archived");
    expect(propertyFiltersSchema.parse({ scope: "all" }).scope).toBe("all");
    expect(propertyFiltersSchema.parse({ scope: "nonsense" }).scope).toBe("active");
  });
});

describe("resolvePropertyScope", () => {
  it("hides retired rows by default", () => {
    expect(resolvePropertyScope({ scope: "active" })).toBe("exclude-retired");
  });

  it("shows only retired rows in the archived scope", () => {
    expect(resolvePropertyScope({ scope: "archived" })).toBe("only-retired");
  });

  it("applies no scope condition for all", () => {
    expect(resolvePropertyScope({ scope: "all" })).toBe("none");
  });

  it("stands down when the status filter explicitly asks for withdrawn", () => {
    // otherwise the default active scope would return an empty list and the
    // status filter would look broken
    expect(resolvePropertyScope({ scope: "active", status: "withdrawn" })).toBe("none");
  });

  it("stands down when the visibility filter explicitly asks for archived", () => {
    expect(resolvePropertyScope({ scope: "active", visibility: "archived" })).toBe("none");
  });

  it("keeps excluding for non-retired status/visibility filters", () => {
    expect(resolvePropertyScope({ scope: "active", status: "available" })).toBe(
      "exclude-retired",
    );
    expect(resolvePropertyScope({ scope: "active", visibility: "public" })).toBe(
      "exclude-retired",
    );
  });
});
