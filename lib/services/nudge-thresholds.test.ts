import { describe, expect, it } from "vitest";
import {
  FORM_BOUNDS,
  NUDGE_DEFAULTS,
  NUDGE_THRESHOLD_KEYS,
  isOutsideFormBounds,
  readThreshold,
  readThresholds,
} from "./nudge-thresholds";

/**
 * These cases are the SAME TABLE that migration 0052's assertion block runs
 * against `public.nudge_threshold(text, numeric)`. The two readers must agree,
 * or the settings page shows a number the nightly sweeps are not using — which
 * is a worse failure than the hardcoding this replaced, because it looks
 * authoritative. If you change one, change the other and both tables.
 */
describe("readThreshold mirrors the SQL fallback rules", () => {
  it("reads a good value", () => {
    expect(readThreshold({ deal_no_contact_days: 21 }, "deal_no_contact_days")).toBe(21);
  });

  it("falls back when the key is absent", () => {
    expect(readThreshold({ something_else: 5 }, "deal_no_contact_days")).toBe(14);
  });

  it("falls back when there is no config at all", () => {
    // a missing `nudge_thresholds` row is the state a fresh database is in
    // between shipping the code and applying 0052 — the sweeps must keep their
    // shipped behaviour, not stop
    expect(readThreshold(null, "viewing_feedback_hours")).toBe(48);
    expect(readThreshold(undefined, "reservation_expiry_days")).toBe(2);
  });

  it("falls back on a value that is not a plain number", () => {
    // reachable: /settings/cyprus-config edits this row as raw JSON
    for (const bad of ["fourteen", "", "  ", true, [], {}, null, "1e3", "-5", "+5", "0x10"]) {
      expect(
        readThreshold({ deal_no_contact_days: bad }, "deal_no_contact_days"),
        `${JSON.stringify(bad)} must fall back`,
      ).toBe(14);
    }
  });

  it("falls back on zero and negatives", () => {
    // 0 would chase instantly and forever; negative is meaningless
    expect(readThreshold({ installment_due_days: 0 }, "installment_due_days")).toBe(7);
    expect(readThreshold({ installment_due_days: -3 }, "installment_due_days")).toBe(7);
  });

  it("falls back above the SQL ceiling of 3650, and accepts the ceiling itself", () => {
    expect(readThreshold({ installment_due_days: 999999 }, "installment_due_days")).toBe(7);
    expect(readThreshold({ installment_due_days: 3651 }, "installment_due_days")).toBe(7);
    expect(readThreshold({ installment_due_days: 3650 }, "installment_due_days")).toBe(3650);
  });

  it("accepts a numeric STRING, because that is how Postgres hands numbers over", () => {
    // the bug that silently killed the price-drop alert: `numeric` arrives from
    // PostgREST as a string, so Number.isFinite("21") is not the test to run
    expect(readThreshold({ deal_no_contact_days: "21" }, "deal_no_contact_days")).toBe(21);
    expect(readThreshold({ deal_no_contact_days: " 21 " }, "deal_no_contact_days")).toBe(21);
    expect(readThreshold({ deal_no_contact_days: "21.5" }, "deal_no_contact_days")).toBe(21.5);
  });

  it("does not treat an array as a config object", () => {
    expect(readThreshold([14] as unknown, "deal_no_contact_days")).toBe(14);
  });
});

describe("readThresholds", () => {
  it("returns every key, defaulting the ones that are missing or broken", () => {
    expect(readThresholds({ deal_no_contact_days: 21, viewing_feedback_hours: "nope" })).toEqual({
      deal_no_contact_days: 21,
      viewing_feedback_hours: 48,
      reservation_expiry_days: 2,
      installment_due_days: 7,
    });
  });

  it("an empty config yields exactly the shipped constants", () => {
    // i.e. deleting the row restores today's behaviour, which is the promise
    // 0052 makes in its header
    expect(readThresholds({})).toEqual(NUDGE_DEFAULTS);
  });
});

describe("form bounds are a separate, narrower question", () => {
  it("every default sits inside its own form range", () => {
    for (const k of NUDGE_THRESHOLD_KEYS) {
      expect(NUDGE_DEFAULTS[k], `${k} default`).toBeGreaterThanOrEqual(FORM_BOUNDS[k].min);
      expect(NUDGE_DEFAULTS[k], `${k} default`).toBeLessThanOrEqual(FORM_BOUNDS[k].max);
      expect(isOutsideFormBounds(k, NUDGE_DEFAULTS[k])).toBe(false);
    }
  });

  it("flags a value SQL accepts but the form would refuse", () => {
    // 2000 days is a legal value as far as the sweeps are concerned, so the
    // page must show it and say it came from somewhere else — not round it
    expect(readThreshold({ deal_no_contact_days: 2000 }, "deal_no_contact_days")).toBe(2000);
    expect(isOutsideFormBounds("deal_no_contact_days", 2000)).toBe(true);
  });

  it("flags a fractional value, which the form requires to be whole", () => {
    expect(isOutsideFormBounds("deal_no_contact_days", 21.5)).toBe(true);
  });
});
