import { describe, expect, it } from "vitest";
import {
  DEAL_TYPES,
  areaNameSchema,
  cyprusConfigSchema,
  inviteUserSchema,
  orgNameSchema,
  leadRoutingSchema,
  stageNameSchema,
} from "./settings";

describe("orgNameSchema", () => {
  it("trims and enforces 2–200 chars", () => {
    const ok = orgNameSchema.safeParse({ name: "  GN Kalaitsidis Capital  " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.name).toBe("GN Kalaitsidis Capital");
    expect(orgNameSchema.safeParse({ name: " a " }).success).toBe(false);
    expect(orgNameSchema.safeParse({ name: "x".repeat(201) }).success).toBe(false);
  });
});

describe("inviteUserSchema", () => {
  it("lowercases email and rejects invalid ones", () => {
    const ok = inviteUserSchema.safeParse({
      email: "New.Agent@GNK.Local",
      full_name: "New Agent",
      role: "agent",
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.email).toBe("new.agent@gnk.local");
    expect(
      inviteUserSchema.safeParse({ email: "nope", full_name: "New Agent", role: "agent" }).success,
    ).toBe(false);
  });

  it("only hands out Phase 1 roles", () => {
    expect(
      inviteUserSchema.safeParse({ email: "a@b.co", full_name: "AB", role: "owner" }).success,
    ).toBe(false);
    expect(
      inviteUserSchema.safeParse({ email: "a@b.co", full_name: "AB", role: "listing_manager" })
        .success,
    ).toBe(true);
  });
});

describe("stage & area names", () => {
  it("requires non-empty trimmed names within length caps", () => {
    expect(stageNameSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(stageNameSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
    expect(stageNameSchema.safeParse({ name: " Reservation " }).success).toBe(true);
    expect(areaNameSchema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(areaNameSchema.safeParse({ name: "Coral Bay" }).success).toBe(true);
  });
});

describe("DEAL_TYPES", () => {
  it("matches the doc 03 deal_type enum the stage editors write", () => {
    expect(DEAL_TYPES).toEqual(["sale", "rental", "antiparoxi", "advisory"]);
  });
});

describe("cyprusConfigSchema", () => {
  const base = { key: "stamp_duty", value_json: "{}" };

  it("keeps only well-formed verified_at dates", () => {
    const ok = cyprusConfigSchema.safeParse({ ...base, verified_at: "2026-07-20" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.verified_at).toBe("2026-07-20");
    const junk = cyprusConfigSchema.safeParse({ ...base, verified_at: "20/07/2026" });
    expect(junk.success).toBe(true);
    if (junk.success) expect(junk.data.verified_at).toBeUndefined();
  });

  it("source_note always parses to a string so an emptied field clears the note", () => {
    const absent = cyprusConfigSchema.safeParse(base);
    expect(absent.success).toBe(true);
    if (absent.success) expect(absent.data.source_note).toBe("");
    const padded = cyprusConfigSchema.safeParse({ ...base, source_note: "  DLS scale  " });
    expect(padded.success).toBe(true);
    if (padded.success) expect(padded.data.source_note).toBe("DLS scale");
    expect(
      cyprusConfigSchema.safeParse({ ...base, source_note: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("requires a key and non-trivial JSON payload", () => {
    expect(cyprusConfigSchema.safeParse({ key: "", value_json: "{}" }).success).toBe(false);
    expect(cyprusConfigSchema.safeParse({ key: "stamp_duty", value_json: "" }).success).toBe(false);
  });
});

describe("leadRoutingSchema (0098)", () => {
  const A = "aaaaaaaa-0000-0000-0000-000000000001";
  const B = "bbbbbbbb-0000-0000-0000-000000000001";

  it("takes off with no members, and round-robin with at least one", () => {
    expect(leadRoutingSchema.safeParse({ mode: "off", agents: [] }).success).toBe(true);
    const rr = leadRoutingSchema.safeParse({ mode: "round_robin", agents: [A, B] });
    expect(rr.success).toBe(true);
    if (rr.success) expect(rr.data.agents).toEqual([A, B]);
  });

  it("refuses round-robin over nobody, with a sentence", () => {
    const r = leadRoutingSchema.safeParse({ mode: "round_robin", agents: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toMatch(/at least one member/i);
  });

  it("refuses an unknown mode and a non-id member", () => {
    expect(leadRoutingSchema.safeParse({ mode: "random", agents: [A] }).success).toBe(false);
    expect(leadRoutingSchema.safeParse({ mode: "round_robin", agents: ["not-an-id"] }).success).toBe(false);
  });

  it("drops a member listed twice", () => {
    const r = leadRoutingSchema.safeParse({ mode: "round_robin", agents: [A, A, B] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.agents).toEqual([A, B]);
  });
});
