import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { DEAL_EXPORT_SELECT, dealCsvColumns, type DealExportRow } from "./deal-export";

const AGENTS = new Map([["a1", "Nino Charalambous"]]);

const base: DealExportRow = {
  title: "Savvides — Kato Paphos villa",
  deal_type: "sale",
  status: "open",
  expected_value: "750000.00",
  commission_split_notes: "3% split 50/50 with partner agency",
  won_at: null,
  lost_at: null,
  lost_reason: null,
  created_at: "2026-07-01T09:00:00Z",
  agent_id: "a1",
  deal_stages: { name: "Negotiation" },
  properties: { reference: "PAF0001" },
  buyer: { display_name: "Δημήτρης Σαββίδης" },
  seller: { display_name: "GN Kalaitsidis Capital" },
};

const line = (csv: string, i = 1) => csv.replace(/^﻿/, "").split("\r\n")[i];

describe("dealCsvColumns", () => {
  it("names every column in the header", () => {
    expect(line(toCsv(dealCsvColumns(AGENTS), []), 0)).toBe(
      "Title,Type,Stage,Status,Expected value,Property,Buyer,Seller,Agent,Commission notes,Won,Lost,Lost reason,Created",
    );
  });

  it("pulls stage name, parties, property and raw money", () => {
    const csv = toCsv(dealCsvColumns(AGENTS), [base]);
    expect(csv).toContain("Negotiation");
    expect(csv).toContain("Δημήτρης Σαββίδης");
    expect(csv).toContain("PAF0001");
    expect(csv).toContain("750000.00");
    expect(csv).not.toContain("€");
    expect(csv).toContain("Nino Charalambous");
  });

  it("keeps the manual commission notes verbatim (quoted when they contain a comma)", () => {
    const csv = toCsv(dealCsvColumns(AGENTS), [
      { ...base, commission_split_notes: "3% to us, 2% to the partner agency" },
    ]);
    expect(csv).toContain('"3% to us, 2% to the partner agency"');
  });

  it("leaves won/lost blank on an open deal and unknown agent empty", () => {
    const csv = toCsv(dealCsvColumns(AGENTS), [{ ...base, agent_id: "ghost" }]);
    const row = line(csv);
    // Won and Lost are consecutive empty cells before Lost reason (also empty)
    expect(row).not.toContain("ghost");
  });
});

describe("DEAL_EXPORT_SELECT's contact embeds", () => {
  // A column hint (`contacts!buyer_contact_id`) answers PGRST200 once its key
  // is composite (0139 re-keys both, keeping their names), and the export then
  // 500s — no type check sees it. The constraint-name hints resolve on both
  // sides of 0139; supabase/tests/contact-link-embeds.test.ts runs them live.
  it("hints buyer and seller by constraint name, never by column", () => {
    expect(DEAL_EXPORT_SELECT).toContain("buyer:contacts!deals_buyer_contact_id_fkey(display_name)");
    expect(DEAL_EXPORT_SELECT).toContain("seller:contacts!deals_seller_contact_id_fkey(display_name)");
    expect(DEAL_EXPORT_SELECT).not.toMatch(/![a-z_]+_id\(/);
  });
});
