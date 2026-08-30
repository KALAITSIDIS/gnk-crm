import { describe, expect, it } from "vitest";
import {
  isStatusRegression,
  partiesSectionSchema,
  propertyFiltersSchema,
  resolvePartyUpdates,
  resolvePropertyKindScope,
  resolvePropertyScope,
  resolveRestoreUpdates,
} from "./properties";

describe("isStatusRegression (DB-01)", () => {
  it("leaving sold or rented for a market status is a regression", () => {
    expect(isStatusRegression("sold", "available")).toBe(true);
    expect(isStatusRegression("rented", "under_offer")).toBe(true);
    expect(isStatusRegression("sold", "withdrawn")).toBe(true);
  });

  it("moving between the two closed statuses is not — both assert a close", () => {
    expect(isStatusRegression("sold", "rented")).toBe(false);
    expect(isStatusRegression("rented", "sold")).toBe(false);
  });

  it("ordinary market moves are never regressions — incl. the restore path", () => {
    expect(isStatusRegression("available", "sold")).toBe(false);
    expect(isStatusRegression("withdrawn", "available")).toBe(false);
    expect(isStatusRegression("reserved", "available")).toBe(false);
  });
});

describe("resolveRestoreUpdates", () => {
  it("returns visibility to private, never public", () => {
    expect(resolveRestoreUpdates({ status: "draft", visibility: "archived" })).toEqual({
      visibility: "private",
    });
  });

  it("flips withdrawn back to available — the other retire marker", () => {
    expect(resolveRestoreUpdates({ status: "withdrawn", visibility: "private" })).toEqual({
      status: "available",
    });
  });

  it("clears both markers when both are set", () => {
    expect(resolveRestoreUpdates({ status: "withdrawn", visibility: "archived" })).toEqual({
      status: "available",
      visibility: "private",
    });
  });

  it("keeps a sold property sold — archiving must not destroy the outcome", () => {
    expect(resolveRestoreUpdates({ status: "sold", visibility: "archived" })).toEqual({
      visibility: "private",
    });
    expect(resolveRestoreUpdates({ status: "rented", visibility: "archived" })).toEqual({
      visibility: "private",
    });
  });

  it("writes nothing for a property that is not retired", () => {
    expect(resolveRestoreUpdates({ status: "available", visibility: "public" })).toEqual({});
  });
});

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

describe("partiesSectionSchema", () => {
  const OWNER = "11111111-1111-1111-1111-111111111111";
  const DEV = "22222222-2222-2222-2222-222222222222";

  it("accepts the seeded fixture ids z.uuid() would reject (T3.2 trap)", () => {
    const parsed = partiesSectionSchema.parse({
      owner_contact_id: OWNER,
      developer_contact_id: DEV,
      assigned_agent_id: "",
    });
    expect(parsed.owner_contact_id).toBe(OWNER);
    expect(parsed.developer_contact_id).toBe(DEV);
    expect(parsed.assigned_agent_id).toBeUndefined();
  });

  it("drops garbage to undefined rather than failing the whole save", () => {
    const parsed = partiesSectionSchema.parse({ owner_contact_id: "not-an-id" });
    expect(parsed.owner_contact_id).toBeUndefined();
  });
});

describe("resolvePartyUpdates", () => {
  const OWNER = "11111111-1111-1111-1111-111111111111";
  const DEV = "22222222-2222-2222-2222-222222222222";
  const AGENT = "33333333-3333-3333-3333-333333333333";

  it("writes all three links for a project", () => {
    expect(
      resolvePartyUpdates(
        { owner_contact_id: OWNER, developer_contact_id: DEV, assigned_agent_id: AGENT },
        { kind: "project" },
      ),
    ).toEqual({
      owner_contact_id: OWNER,
      developer_contact_id: DEV,
      assigned_agent_id: AGENT,
    });
  });

  it("clears a link the picker emptied — undefined means cleared, not absent", () => {
    expect(
      resolvePartyUpdates(
        { owner_contact_id: undefined, developer_contact_id: undefined, assigned_agent_id: AGENT },
        { kind: "unit" },
      ),
    ).toEqual({
      owner_contact_id: null,
      developer_contact_id: null,
      assigned_agent_id: AGENT,
    });
  });

  it("never touches developer_contact_id on a standalone listing", () => {
    // the field isn't rendered there, so an absent value must not read as "clear"
    const updates = resolvePartyUpdates(
      { owner_contact_id: OWNER, developer_contact_id: undefined, assigned_agent_id: undefined },
      { kind: "standalone" },
    );
    expect(updates).toEqual({ owner_contact_id: OWNER, assigned_agent_id: null });
    expect("developer_contact_id" in updates).toBe(false);
  });

  it("carries the developer on a phase, which is a project by another name", () => {
    const updates = resolvePartyUpdates(
      { owner_contact_id: undefined, developer_contact_id: DEV, assigned_agent_id: undefined },
      { kind: "phase" },
    );
    expect(updates.developer_contact_id).toBe(DEV);
  });
});

describe("resolvePropertyKindScope", () => {
  it("hides units by default — a 60-unit project must not bury the list", () => {
    expect(resolvePropertyKindScope({})).toBe("exclude-units");
    expect(resolvePropertyKindScope({ kind: undefined })).toBe("exclude-units");
  });

  it("an explicit kind=unit wins — a filter that returns nothing is broken", () => {
    expect(resolvePropertyKindScope({ kind: "unit" })).toBe("none");
  });

  it("any explicit kind stops the default filtering, then narrows on its own", () => {
    expect(resolvePropertyKindScope({ kind: "standalone" })).toBe("none");
    expect(resolvePropertyKindScope({ kind: "project" })).toBe("none");
    expect(resolvePropertyKindScope({ kind: "phase" })).toBe("none");
  });
});
