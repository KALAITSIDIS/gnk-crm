import { describe, expect, it } from "vitest";
import {
  EXPECTED_UPDATED_AT,
  expectedUpdatedAt,
  STALE_MESSAGE,
  staleMessage,
} from "./optimistic-save";

const form = (v?: string) => {
  const fd = new FormData();
  if (v !== undefined) fd.set(EXPECTED_UPDATED_AT, v);
  return fd;
};

// exactly as PostgREST serialises a timestamptz: microseconds, offset
const T1 = "2026-09-06T17:04:11.482913+00:00";
const T2 = "2026-09-06T17:09:52.001004+00:00";

describe("the expectation a form carries", () => {
  it("is the row's updated_at as rendered, verbatim", () => {
    expect(expectedUpdatedAt(form(T1))).toBe(T1);
  });

  it("is null when the form carries none — or an empty one", () => {
    expect(expectedUpdatedAt(form())).toBeNull();
    expect(expectedUpdatedAt(form(""))).toBeNull();
    expect(expectedUpdatedAt(form("   "))).toBeNull();
  });
});

describe("whether the row moved since the page rendered", () => {
  it("is not stale when the row is where the page left it", () => {
    expect(staleMessage(T1, T1)).toBeNull();
  });

  it("is stale when the row has been saved since — the second edit must not undo the first", () => {
    expect(staleMessage(T1, T2)).toBe(STALE_MESSAGE);
  });

  it("compares the serialised timestamp exactly — a millisecond rounding would be a false 'moved'", () => {
    // If either side went through `new Date(...)`, the microseconds would be
    // lost on one side only and every save would be refused.
    expect(staleMessage(T1, T1.replace("482913", "482000"))).toBe(STALE_MESSAGE);
  });

  it("never refuses a form that sent no expectation (rendered before this shipped)", () => {
    expect(staleMessage(null, T2)).toBeNull();
  });

  it("is stale when the row's timestamp is unknown but an expectation was sent", () => {
    expect(staleMessage(T1, null)).toBe(STALE_MESSAGE);
    expect(staleMessage(T1, undefined)).toBe(STALE_MESSAGE);
  });
});
