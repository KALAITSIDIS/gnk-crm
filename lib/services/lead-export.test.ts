import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { leadCsvColumns, type LeadExportRow } from "./lead-export";

const AGENTS = new Map([["a1", "Nino Charalambous"]]);

const base: LeadExportRow = {
  received_at: "2026-07-20T09:00:00Z",
  status: "new",
  source: "website",
  channel: "form",
  message: "Interested in sea-view villas",
  first_response_at: null,
  lost_reason: null,
  assigned_agent_id: "a1",
  contacts: { display_name: "Δημήτρης Σαββίδης", phone_e164: "+35799123456" },
  properties: { reference: "GNK-PAF-0001" },
};

const line = (csv: string, i = 1) => csv.replace(/^﻿/, "").split("\r\n")[i];

describe("leadCsvColumns", () => {
  it("names every column in the header", () => {
    expect(line(toCsv(leadCsvColumns(AGENTS), []), 0)).toBe(
      "Received,Status,Source,Channel,Contact,Phone,Property,Message,First response,Agent,Lost reason",
    );
  });

  it("pulls the linked contact, phone and property", () => {
    const csv = toCsv(leadCsvColumns(AGENTS), [base]);
    expect(csv).toContain("Δημήτρης Σαββίδης");
    expect(csv).toContain("'+357"); // formatted phone, formula-guarded leading +
    expect(csv).toContain("GNK-PAF-0001");
    expect(csv).toContain("Nino Charalambous");
  });

  it("leaves unlinked contact/property and empty response as blank cells", () => {
    const csv = toCsv(leadCsvColumns(AGENTS), [
      { ...base, contacts: null, properties: null, first_response_at: null, assigned_agent_id: null },
    ]);
    const row = line(csv);
    // Contact, Phone, Property all empty → three consecutive commas after Channel
    expect(row).toContain("website,form,,,,");
  });
});
