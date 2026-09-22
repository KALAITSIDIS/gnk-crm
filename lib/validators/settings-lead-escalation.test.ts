import { describe, expect, it } from "vitest";
import { leadEscalationPreviewSchema, leadEscalationSchema } from "@/lib/validators/settings";

/**
 * The lead-escalation form has two readers (0107 save, 0112 preview) of ONE
 * schema: the preview schema is the form's fields and the working-hours
 * refinements; the save schema is that plus "tick at least one person".
 * A preview with nobody ticked is the one that must show every enquiry as
 * unsendable, so the save-only refinement must not reach it — and nothing
 * else may differ, or the preview would evaluate values the save refuses.
 */
const A = "11111111-1111-1111-1111-111111111111";
const base = { enabled: "on", after_minutes: "15", max_age_hours: "48", recipients: [A], hours_enabled: "on", days: ["1", "2"], start: "09:00", end: "18:00" };

describe("leadEscalationPreviewSchema vs leadEscalationSchema", () => {
  it("both accept the same well-formed form, with the same output", () => {
    const p = leadEscalationPreviewSchema.safeParse(base);
    const s = leadEscalationSchema.safeParse(base);
    expect(p.success && s.success).toBe(true);
    expect(p.data).toEqual(s.data);
    expect(p.data).toMatchObject({ enabled: true, after_minutes: 15, max_age_hours: 48, recipients: [A], hours_enabled: true, days: [1, 2] });
  });

  it("switching on with nobody ticked: the save refuses with a sentence, the preview goes ahead", () => {
    const s = leadEscalationSchema.safeParse({ ...base, recipients: [] });
    expect(s.success).toBe(false);
    expect(s.success ? "" : s.error.issues[0]!.message).toMatch(/at least one person/i);
    const p = leadEscalationPreviewSchema.safeParse({ ...base, recipients: [] });
    expect(p.success).toBe(true);
    expect(p.success && p.data.recipients).toEqual([]);
  });

  it("both refuse the same silly values: hours without days, hours that end before they start, a wait outside the form's range", () => {
    for (const bad of [
      { ...base, days: [] },
      { ...base, start: "18:00", end: "09:00" },
      { ...base, after_minutes: "4" },
      { ...base, max_age_hours: "0" },
      { ...base, recipients: ["not-a-uuid"] },
    ]) {
      expect(leadEscalationPreviewSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(leadEscalationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("both de-duplicate recipients and days the same way", () => {
    const twice = { ...base, recipients: [A, A], days: ["2", "1", "2"] };
    const p = leadEscalationPreviewSchema.safeParse(twice);
    const s = leadEscalationSchema.safeParse(twice);
    expect(p.success && p.data.recipients).toEqual([A]);
    expect(s.success && s.data.days).toEqual([1, 2]);
  });
});
