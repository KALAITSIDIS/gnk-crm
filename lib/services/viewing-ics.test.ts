import { describe, expect, it } from "vitest";
import { buildViewingIcs, escapeIcsText, foldIcsLine, icsUtcStamp } from "./viewing-ics";

const base = {
  id: "11111111-2222-3333-4444-555555555555",
  scheduledAt: "2026-09-01T10:30:00.000Z",
  durationMin: 45,
  propertyRef: "PAF0001",
  propertyAddress: "Coral Bay Ave 12, Peyia",
  contactName: "Maria Ioannou",
  agentName: "G. Kalaitsidis",
};

describe("viewing .ics (ICS-1)", () => {
  it("emits a UTC-basis event the length of the viewing", () => {
    const ics = buildViewingIcs(base, new Date("2026-08-30T12:00:00Z"));
    expect(ics).toContain("DTSTART:20260901T103000Z");
    expect(ics).toContain("DTEND:20260901T111500Z"); // 10:30 + 45 min
    expect(ics).toContain("DTSTAMP:20260830T120000Z");
    expect(ics).toContain("SUMMARY:Viewing: PAF0001 — Maria Ioannou");
    expect(ics).toContain("LOCATION:Coral Bay Ave 12\\, Peyia");
  });

  it("keeps the UID stable so a reschedule REPLACES the entry on re-import", () => {
    const a = buildViewingIcs(base, new Date("2026-08-30T12:00:00Z"));
    const b = buildViewingIcs(
      { ...base, scheduledAt: "2026-09-02T09:00:00.000Z" },
      new Date("2026-08-31T12:00:00Z"),
    );
    const uid = "UID:viewing-11111111-2222-3333-4444-555555555555@gnk-crm";
    expect(a).toContain(uid);
    expect(b).toContain(uid);
    expect(a).toContain("METHOD:PUBLISH");
  });

  it("omits LOCATION when there is no address and survives a null contact", () => {
    const ics = buildViewingIcs({ ...base, propertyAddress: null, contactName: null });
    expect(ics).not.toContain("LOCATION");
    expect(ics).toContain("SUMMARY:Viewing: PAF0001");
    expect(ics).not.toContain("— null");
  });

  it("escapes RFC 5545 specials, backslash first", () => {
    expect(escapeIcsText("a;b,c\nd\\e")).toBe("a\\;b\\,c\\nd\\\\e");
  });

  it("folds long lines at 75 octets with CRLF + space continuation", () => {
    const folded = foldIcsLine("X:" + "a".repeat(200));
    const lines = folded.split("\r\n");
    expect(lines[0]).toHaveLength(75);
    expect(lines.slice(1).every((l) => l.startsWith(" ") && l.length <= 75)).toBe(true);
    const unfolded = lines.map((l, i) => (i === 0 ? l : l.slice(1))).join("");
    expect(unfolded).toBe("X:" + "a".repeat(200));
  });

  it("uses CRLF line endings throughout — calendar clients require them", () => {
    const ics = buildViewingIcs(base);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it("stamps drop milliseconds and separators", () => {
    expect(icsUtcStamp("2026-12-31T23:59:59.999Z")).toBe("20261231T235959Z");
  });
});
