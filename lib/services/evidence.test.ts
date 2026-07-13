import { describe, expect, it } from "vitest";
import { reportContentHash, sortChronological, type EvidenceRow } from "./evidence";

const row = (occurredAt: string, line: string, extra?: Partial<EvidenceRow>): EvidenceRow => ({
  occurredAt,
  entityType: "deal",
  line,
  propertyRef: null,
  actorName: null,
  ...extra,
});

describe("sortChronological", () => {
  it("orders oldest first regardless of input order", () => {
    const out = sortChronological([
      row("2026-07-12T10:00:00Z", "second"),
      row("2026-07-10T09:00:00Z", "first"),
      row("2026-07-13T08:00:00Z", "third"),
    ]);
    expect(out.map((r) => r.line)).toEqual(["first", "second", "third"]);
  });

  it("does not mutate the input", () => {
    const input = [row("2026-07-12T10:00:00Z", "b"), row("2026-07-10T09:00:00Z", "a")];
    sortChronological(input);
    expect(input[0].line).toBe("b");
  });
});

describe("reportContentHash", () => {
  const rows = [
    row("2026-07-10T09:00:00Z", "Created", { propertyRef: "GNK-PAF-0001", actorName: "G. K." }),
    row("2026-07-11T10:00:00Z", "Stage New → Qualified"),
  ];

  it("is deterministic for identical content", () => {
    expect(reportContentHash(rows)).toBe(reportContentHash([...rows]));
  });

  it("is a 64-char lowercase hex digest", () => {
    expect(reportContentHash(rows)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any row field changes", () => {
    const base = reportContentHash(rows);
    const tamperedLine = [rows[0], { ...rows[1], line: "Stage New → Viewing" }];
    const tamperedActor = [{ ...rows[0], actorName: "someone else" }, rows[1]];
    expect(reportContentHash(tamperedLine)).not.toBe(base);
    expect(reportContentHash(tamperedActor)).not.toBe(base);
  });

  it("treats null and empty-string fields identically (canonical form)", () => {
    const a = [row("2026-07-10T09:00:00Z", "x", { propertyRef: null })];
    const b = [row("2026-07-10T09:00:00Z", "x", { propertyRef: "" as unknown as null })];
    expect(reportContentHash(a)).toBe(reportContentHash(b));
  });
});
