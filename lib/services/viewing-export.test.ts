import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { viewingCsvColumns, type ViewingExportRow } from "./viewing-export";

const base: ViewingExportRow = {
  scheduled_at: "2026-07-23T14:00:00Z",
  status: "completed",
  duration_min: 30,
  route_date: "2026-07-23",
  properties: { reference: "GNK-PAF-0001" },
  contacts: { display_name: "Δημήτρης Σαββίδης" },
  agent: { full_name: "Nino Charalambous" },
  viewing_slips: [{ signer_name: "Δημήτρης Σαββίδης", signed_at: "2026-07-23T14:22:00Z" }],
};

const line = (csv: string, i = 1) => csv.replace(/^﻿/, "").split("\r\n")[i];

describe("viewingCsvColumns", () => {
  it("names every column in the header", () => {
    expect(line(toCsv(viewingCsvColumns(), []), 0)).toBe(
      "Scheduled,Status,Duration (min),Property,Attendee,Agent,Signed by,Signed at,Route date",
    );
  });

  it("surfaces the signed slip's signer for commission evidence", () => {
    const csv = toCsv(viewingCsvColumns(), [base]);
    expect(csv).toContain("GNK-PAF-0001");
    expect(csv).toContain("Nino Charalambous");
    expect(csv).toContain("Δημήτρης Σαββίδης");
  });

  it("leaves the slip columns blank for an unsigned viewing", () => {
    const csv = toCsv(viewingCsvColumns(), [
      { ...base, status: "scheduled", viewing_slips: [] },
    ]);
    const row = line(csv);
    // Agent then two empty slip cells (Signed by, Signed at) before Route date
    expect(row).toContain("Nino Charalambous,,,2026-07-23");
  });
});
