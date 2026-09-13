import { describe, expect, it } from "vitest";
import { buildProgress } from "./construction";

/**
 * A build year beside a pre-completion status is a contradiction, and the
 * record should say so (audit 2026-09-13, CRM-05).
 *
 * PAF0001 is stored as built in 2007, construction "finishing", delivery
 * 29 November 2026, quality score 85. The public site withholds the two
 * construction fields because a year built settles them; the CRM showed all
 * three side by side with no warning, and the same shape put a
 * self-contradicting statement on a live listing on 4 September. The rule
 * warns; it does not block — the operator may be recording a rebuild.
 */
const NOW = new Date("2026-09-13T12:00:00Z");

describe("buildProgress with a year built", () => {
  it("flags a past build year beside a pre-completion status", () => {
    const b = buildProgress("finishing", "2026-11-29", NOW, 2007);
    expect(b.mismatch).toMatch(/2007/);
    expect(b.mismatch).toMatch(/finishing/i);
  });

  it("flags a past build year beside a delivery date even with no status", () => {
    const b = buildProgress(null, "2026-11-29", NOW, 2007);
    expect(b.mismatch).toMatch(/2007/);
    expect(b.mismatch).toMatch(/delivery date/i);
  });

  it("accepts a past build year with a finished status", () => {
    expect(buildProgress("completed", null, NOW, 2007).mismatch).toBeNull();
    expect(buildProgress("delivered", "2008-03-01", NOW, 2007).mismatch).toBeNull();
  });

  it("accepts a build year in the future beside an unfinished build — it is the planned completion", () => {
    expect(buildProgress("under_construction", "2027-06-01", NOW, 2027).mismatch).toBeNull();
    expect(buildProgress("finishing", "2026-11-29", NOW, 2026).mismatch).toBeNull();
  });

  it("is unchanged without a year built — the existing rules still apply", () => {
    expect(buildProgress("finishing", "2026-11-29", NOW).mismatch).toBeNull();
    expect(buildProgress("finishing", "2026-11-29", NOW, null).mismatch).toBeNull();
    expect(buildProgress("delivered", "2027-01-01", NOW, null).mismatch).toMatch(/still in the future/);
  });

  it("lets the existing delivered-but-future rule speak first when both apply", () => {
    expect(buildProgress("delivered", "2027-01-01", NOW, 2007).mismatch).toMatch(/still in the future/);
  });
});
