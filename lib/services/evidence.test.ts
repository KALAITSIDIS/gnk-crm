import { describe, expect, it } from "vitest";
import { reportContentHash, sortChronological, type EvidenceRow } from "./evidence";

let seq = 0;
const row = (occurredAt: string, line: string, extra?: Partial<EvidenceRow>): EvidenceRow => ({
  id: ++seq,
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

  it("breaks timestamp ties by event id (chain order), whatever the input order", () => {
    const a = row("2026-07-12T10:00:00Z", "first-inserted", { id: 7 });
    const b = row("2026-07-12T10:00:00Z", "second-inserted", { id: 9 });
    const c = row("2026-07-12T10:00:00Z", "third-inserted", { id: 12 });
    expect(sortChronological([b, c, a]).map((r) => r.line)).toEqual([
      "first-inserted",
      "second-inserted",
      "third-inserted",
    ]);
    expect(sortChronological([c, a, b])).toEqual(sortChronological([a, b, c]));
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

  it("ignores the internal event id — old report hashes stay recomputable", () => {
    const a = [row("2026-07-10T09:00:00Z", "x", { id: 1 })];
    const b = [row("2026-07-10T09:00:00Z", "x", { id: 999 })];
    expect(reportContentHash(a)).toBe(reportContentHash(b));
  });
});
