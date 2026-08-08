import { describe, expect, it, vi } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";

/**
 * `redirect()` throws NEXT_REDIRECT rather than returning, which is exactly the
 * behaviour these tests pin: a clock-skewed token must LEAVE the render, and
 * every other error must still reach the T5.7 boundary. Getting that backwards
 * either strands the user on an unclearable error or hides real failures behind
 * a redirect.
 */
const redirect = vi.hoisted(() => vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
}));
vi.mock("next/navigation", () => ({ redirect }));

const { unwrapRows } = await import("./unwrap");
const { SESSION_CLOCK_PATH, isClockSkewRejection } = await import("./clock-skew");

const err = (over: Partial<PostgrestError>): PostgrestError =>
  ({ code: "", message: "", details: "", hint: "", name: "PostgrestError", ...over }) as PostgrestError;

describe("isClockSkewRejection", () => {
  it("matches PostgREST's future-iat code", () => {
    // PGRST303 confirmed directly against a real instance 2026-08-08.
    expect(isClockSkewRejection({ code: "PGRST303" })).toBe(true);
  });

  it("does not match the neighbouring PostgREST codes", () => {
    // PGRST103 is the paging dead-end that pagination.ts deliberately tolerates;
    // 42501 is an ordinary RLS denial. Neither may trigger a sign-out prompt.
    expect(isClockSkewRejection({ code: "PGRST103" })).toBe(false);
    expect(isClockSkewRejection({ code: "42501" })).toBe(false);
    expect(isClockSkewRejection(null)).toBe(false);
    expect(isClockSkewRejection(undefined)).toBe(false);
  });
});

describe("unwrapRows", () => {
  it("returns rows when the query succeeded", () => {
    redirect.mockClear();
    expect(unwrapRows({ data: [{ id: 1 }], error: null }, "districts")).toEqual([{ id: 1 }]);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("treats a null payload as empty rather than an error", () => {
    expect(unwrapRows({ data: null, error: null }, "districts")).toEqual([]);
  });

  it("routes a clock-skewed token to the session page instead of the boundary", () => {
    redirect.mockClear();
    expect(() =>
      unwrapRows({ data: null, error: err({ code: "PGRST303", message: "JWT issued at future" }) }, "districts"),
    ).toThrow(`NEXT_REDIRECT:${SESSION_CLOCK_PATH}`);
    expect(redirect).toHaveBeenCalledWith(SESSION_CLOCK_PATH);
  });

  it("still throws for every other error, with the label kept", () => {
    redirect.mockClear();
    expect(() =>
      unwrapRows({ data: null, error: err({ code: "42501", message: "permission denied" }) }, "districts"),
    ).toThrow("Query failed (districts): permission denied");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not redirect an expired token — that is a normal auth failure", () => {
    // The adjacent JWT error, and the one that must keep its existing path.
    redirect.mockClear();
    expect(() =>
      unwrapRows({ data: null, error: err({ code: "PGRST301", message: "JWT expired" }) }, "districts"),
    ).toThrow("Query failed (districts): JWT expired");
    expect(redirect).not.toHaveBeenCalled();
  });
});
