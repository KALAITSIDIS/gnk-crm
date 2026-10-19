import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
import { ADMIN_ENTITY_TYPES, ENTITY_TYPES, SALES_ENTITY_TYPES } from "./events";

/**
 * The admin dashboard's two feeds (A01) split ENTITY_TYPES between them. A new
 * entity type must be placed in one — this fails until it is — and none may be
 * in both, or its events would print twice on the same screen.
 *
 * (Its own file rather than events.test.ts: the event-line cases there change
 * with nearly every event type, this with almost none.)
 */
describe("ADMIN_ENTITY_TYPES / SALES_ENTITY_TYPES partition ENTITY_TYPES", () => {
  it("are disjoint", () => {
    const admin = new Set<string>(ADMIN_ENTITY_TYPES);
    expect(SALES_ENTITY_TYPES.filter((t) => admin.has(t))).toEqual([]);
  });

  it("together are every entity type, each once", () => {
    const union = [...ADMIN_ENTITY_TYPES, ...SALES_ENTITY_TYPES];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...ENTITY_TYPES].sort());
  });

  it("keeps settings, users, the organisation and export audit lines on the admin side", () => {
    expect([...ADMIN_ENTITY_TYPES].sort()).toEqual(["config", "export", "organization", "user"]);
  });
});
