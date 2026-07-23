import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { contactCsvColumns, type ContactExportRow } from "./contact-export";

function parseCsvLoose(text: string): string[][] {
  return text
    .replace(/^﻿/, "")
    .trimEnd()
    .split("\r\n")
    .map((line) => {
      // simple splitter adequate for these fixtures (no embedded commas/quotes)
      return line.split(",");
    });
}

const AGENTS = new Map([
  ["agent-active", "Nino Charalambous"],
  ["agent-gone", "Old Agent (inactive)"],
]);

const base: ContactExportRow = {
  display_name: "Δημήτρης Σαββίδης",
  contact_kind: "person",
  phone_e164: "+35799123456",
  email: "d@example.com",
  contact_types: ["buyer", "past_client"],
  temperature: "hot",
  source: "referral",
  nationality: "CY",
  languages: ["el", "en"],
  assigned_agent_id: "agent-active",
  created_at: "2026-07-01T09:00:00Z",
};

describe("contactCsvColumns", () => {
  it("emits a header row naming every exported column", () => {
    const csv = toCsv(contactCsvColumns(AGENTS), []);
    const [header] = parseCsvLoose(csv);
    expect(header).toEqual([
      "Name",
      "Kind",
      "Phone",
      "Email",
      "Types",
      "Temperature",
      "Source",
      "Nationality",
      "Languages",
      "Agent",
      "Added",
    ]);
  });

  it("joins array fields with '; ' and de-underscores contact types", () => {
    const csv = toCsv(contactCsvColumns(AGENTS), [base]);
    expect(csv).toContain("buyer; past client");
    expect(csv).toContain("el; en");
  });

  it("resolves the assigned agent, keeping the inactive suffix", () => {
    const csv = toCsv(contactCsvColumns(AGENTS), [
      { ...base, assigned_agent_id: "agent-gone" },
    ]);
    expect(csv).toContain("Old Agent (inactive)");
  });

  it("renders an unassigned or unknown agent as an empty cell, not a raw id", () => {
    const csv = toCsv(contactCsvColumns(AGENTS), [
      { ...base, assigned_agent_id: null },
      { ...base, assigned_agent_id: "agent-deleted" },
    ]);
    expect(csv).not.toContain("agent-deleted");
  });

  it("formats the phone (formula-guarded) and leaves a missing phone blank", () => {
    const withPhone = toCsv(contactCsvColumns(AGENTS), [base]);
    // formatPhone → international "+357 …"; the leading + is a formula-injection
    // vector, so the serializer prefixes a single quote → "'+357 …".
    expect(withPhone).toContain("'+357");
    const noPhone = toCsv(contactCsvColumns(AGENTS), [{ ...base, phone_e164: null }]);
    // Name is the first column; a blank phone must not shift columns
    expect(noPhone.split("\r\n")[1].startsWith("Δημήτρης Σαββίδης,person,,")).toBe(true);
  });
});
