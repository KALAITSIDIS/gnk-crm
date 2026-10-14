import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GUID_SHAPES } from "@/lib/testing/guid-shapes";
import { guidOrNull, isGuid } from "@/lib/validators/ids";

/**
 * The one shape check for an id that arrives as text (T-malformed-ids).
 * z.guid(), never the strict z.uuid(): Postgres ignores the RFC version and
 * variant bits, and the hosted organisation id, every seed id and every
 * fixture id would fail the strict check (DECISIONS 2026-07-11 · T3.2,
 * T-external-audit-2026-10-14 item 4).
 */
describe("isGuid", () => {
  it("accepts every 8-4-4-4-12 hex id Postgres hands out — including the ids strict uuid() refuses", () => {
    for (const id of [
      "00000000-0000-0000-0000-000000000001", // the hosted organisation
      "11111111-1111-1111-1111-111111111111", // a seed id (version 1 bits, variant 0)
      "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01",
      "ABCDEF01-2345-6789-ABCD-EF0123456789", // uppercase: Postgres accepts and lowercases it
    ]) {
      expect(isGuid(id), id).toBe(true);
    }
  });

  it("refuses everything else — PostgREST would answer each with 22P02", () => {
    for (const bad of [
      "",
      "not-a-uuid",
      "lead-1",
      "123",
      "00000000-0000-0000-0000-00000000000", // one digit short
      "00000000-0000-0000-0000-0000000000001", // one digit long
      "0000000g-0000-0000-0000-000000000001", // not hex
      " 00000000-0000-0000-0000-000000000001", // padded
      "00000000-0000-0000-0000-000000000001,owner_contact_id.eq.x", // a filter smuggled after an id
      "{00000000-0000-0000-0000-000000000001}", // Postgres reads braces; no URL of ours writes them
      "00000000000000000000000000000001", // nor the bare 32 hex digits
    ]) {
      expect(isGuid(bad), bad).toBe(false);
    }
  });

  it("refuses what is not a string at all", () => {
    for (const bad of [undefined, null, 1, {}, ["00000000-0000-0000-0000-000000000001"]]) {
      expect(isGuid(bad)).toBe(false);
    }
  });
});

describe("GUID_SHAPES — the good-path ids every call-site test loops over", () => {
  it("are all ids to isGuid, and two of them are exactly what strict z.uuid() refuses", () => {
    for (const id of GUID_SHAPES) expect(isGuid(id), id).toBe(true);
    // if these stop being refused, the call-site tests no longer tell guid from uuid
    expect(GUID_SHAPES.map((id) => z.uuid().safeParse(id).success)).toEqual([true, false, false]);
  });
});

describe("guidOrNull", () => {
  it("keeps an id, drops anything else as if it were absent", () => {
    expect(guidOrNull("00000000-0000-0000-0000-000000000001")).toBe("00000000-0000-0000-0000-000000000001");
    expect(guidOrNull("notauuid")).toBeNull();
    expect(guidOrNull(undefined)).toBeNull();
  });
});
