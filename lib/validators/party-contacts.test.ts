import { describe, expect, it } from "vitest";
import { createPartySchema } from "./party-contacts";

/**
 * The inline party create was the ONE contact entry path without email
 * format validation (2026-09-01 review) — createLead and createContact both
 * refuse malformed addresses. These pin the repaired parity.
 */
describe("createPartySchema email", () => {
  const base = { source: "owner", name: "Test Owner" };

  it('refuses the junk every other path refuses ("n/a" is not an address)', () => {
    for (const junk of ["n/a", "call the office", "test@", "@example.com"]) {
      const r = createPartySchema.safeParse({ ...base, email: junk });
      expect(r.success, `"${junk}" must be refused`).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]?.message).toBe("Enter a valid email");
      }
    }
  });

  it("lowercases a valid address (the 0077 dedup index is on lower(email))", () => {
    const r = createPartySchema.parse({ ...base, email: "Owner@Example.COM" });
    expect(r.email).toBe("owner@example.com");
  });

  it("an untouched field stays undefined — empty is not an invalid address", () => {
    expect(createPartySchema.parse({ ...base, email: "" }).email).toBeUndefined();
    expect(createPartySchema.parse({ ...base, email: "   " }).email).toBeUndefined();
    expect(createPartySchema.parse({ ...base }).email).toBeUndefined();
  });
});
