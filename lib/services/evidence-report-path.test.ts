import { describe, expect, it } from "vitest";
import { EVIDENCE_REPORT_PATH_LIKE, isEvidenceReportPath } from "./evidence-report-path";

const ORG = "00000000-0000-0000-0000-000000000001";
const CONTACT = "11111111-1111-1111-1111-111111111111";

/** Postgres LIKE semantics for the one pattern: `%` is any run, everything else literal. */
const like = (pattern: string, value: string) =>
  new RegExp(`^${pattern.split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(value);

const SAMPLES: [string, boolean][] = [
  [`${ORG}/reports/evidence-${CONTACT}-1760000000000.pdf`, true], // what lib/actions/reports.ts writes
  [`${ORG}/contacts/${CONTACT}/passport.pdf`, false],
  [`${ORG}/contacts/${CONTACT}/evidence-scan.pdf`, false],
  [`${ORG}/contacts/${CONTACT}/reports/passport.pdf`, false],
  [`${ORG}/reports/summary.pdf`, false],
  ["", false],
];

describe("isEvidenceReportPath", () => {
  it.each(SAMPLES)("%s → %s", (path, expected) => {
    expect(isEvidenceReportPath(path)).toBe(expected);
  });

  it("a document with no path is not a report", () => {
    expect(isEvidenceReportPath(null)).toBe(false);
    expect(isEvidenceReportPath(undefined)).toBe(false);
  });

  it("agrees with the LIKE pattern the reports page queries with, on every sample", () => {
    for (const [path, expected] of SAMPLES) expect(like(EVIDENCE_REPORT_PATH_LIKE, path), path).toBe(expected);
  });
});
