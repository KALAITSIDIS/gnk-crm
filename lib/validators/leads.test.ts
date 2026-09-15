import { describe, expect, it } from "vitest";
import { createLeadSchema } from "./leads";
import { utcToDatetimeLocal } from "@/lib/utils/tz";

/**
 * The Add-lead form (0098, audit LR-04): a call or a WhatsApp logged after
 * the fact carries WHEN it arrived, so the response-time KPI measures the
 * desk and not the typing; and the lead can name the listing it was about.
 */
const base = { source: "phone" };

describe("createLeadSchema — received_at", () => {
  it("takes a wall-clock time in the past, and leaves blank as 'now'", () => {
    const r = createLeadSchema.safeParse({ ...base, received_at: "2026-09-15T09:30" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.received_at).toBe("2026-09-15T09:30");
    const blank = createLeadSchema.safeParse({ ...base, received_at: "" });
    expect(blank.success).toBe(true);
    if (blank.success) expect(blank.data.received_at).toBeUndefined();
  });

  it("refuses a time in the future — a lead cannot arrive tomorrow", () => {
    const future = utcToDatetimeLocal(new Date(Date.now() + 2 * 3_600_000));
    const r = createLeadSchema.safeParse({ ...base, received_at: future });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toMatch(/future/i);
  });

  it("refuses a value that is not what a datetime-local input posts", () => {
    expect(createLeadSchema.safeParse({ ...base, received_at: "yesterday" }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...base, received_at: "2026-09-15" }).success).toBe(false);
  });
});

describe("createLeadSchema — property_id", () => {
  it("takes a property id, and none", () => {
    const ok = createLeadSchema.safeParse({ ...base, property_id: "aaaaaaaa-0000-0000-0000-000000000001" });
    expect(ok.success).toBe(true);
    const none = createLeadSchema.safeParse({ ...base, property_id: "" });
    expect(none.success).toBe(true);
    if (none.success) expect(none.data.property_id).toBeUndefined();
    expect(createLeadSchema.safeParse({ ...base, property_id: "PAF0001" }).success).toBe(false);
  });
});
