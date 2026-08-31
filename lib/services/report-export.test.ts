import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import {
  agentPerformanceCsv,
  isReportKey,
  num,
  pct,
  priceReductionsCsv,
  sourceRoiCsv,
  stageConversionCsv,
  timeToCloseCsv,
  timeToCloseRows,
  type AgentPerformanceRow,
  type RepeatCut,
  type SourceRoiRow,
  type StageRow,
  type TimeToClose,
} from "./report-export";

describe("report-export", () => {
  it("num() survives jsonb numerics arriving as strings", () => {
    // Postgres serialises `numeric` inside jsonb as a JSON number for values it
    // can represent and as a STRING otherwise. Trusting the type is the same
    // defect class that made the events backup script necessary.
    expect(num(300000)).toBe(300000);
    expect(num("300000.00")).toBe(300000);
    expect(num("0.33333333333333333333")).toBeCloseTo(1 / 3, 15);
    expect(num(null)).toBeNull();
    expect(num("")).toBeNull();
    expect(num("not a number")).toBeNull();
  });

  it("pct() renders a rate, and an undefined rate as blank rather than 0%", () => {
    // 0/0 is not 0. A source with no conversions has NO win rate, and printing
    // "0.0%" would read as a measured failure rather than an absent measurement.
    expect(pct(1)).toBe("100.0%");
    expect(pct(1 / 3)).toBe("33.3%");
    expect(pct(0)).toBe("0.0%");
    expect(pct(null)).toBe("");
  });

  it("isReportKey() rejects anything not a known report", () => {
    expect(isReportKey("agent_performance")).toBe(true);
    expect(isReportKey("source_roi")).toBe(true);
    expect(isReportKey("../../etc/passwd")).toBe(false);
    expect(isReportKey("")).toBe(false);
    expect(isReportKey(null)).toBe(false);
  });

  it("agent performance CSV resolves names and formats money and minutes", () => {
    const rows: AgentPerformanceRow[] = [
      {
        agent_id: "a-1",
        leads_assigned: 3,
        leads_answered: 2,
        avg_first_response_min: 60,
        viewings_completed: 2,
        deals_won: 2,
        won_value: 300000,
        deals_lost: 0,
      },
      {
        agent_id: "a-2",
        leads_assigned: 1,
        leads_answered: 0,
        avg_first_response_min: null,
        viewings_completed: 0,
        deals_won: 0,
        won_value: 0,
        deals_lost: 1,
      },
    ];
    const csv = toCsv(agentPerformanceCsv(new Map([["a-1", "Maria"]])), rows);
    expect(csv).toContain("Maria,3,2,60.0,2,2,300000.00,0");
    // unresolved ids fall back to the id rather than an empty cell
    expect(csv).toContain("a-2,1,0,,0,0,0.00,1");
  });

  it("source ROI CSV leaves an undefined win rate blank", () => {
    const rows: SourceRoiRow[] = [
      {
        source: "website",
        leads: 3,
        converted: 1,
        won: 1,
        won_value: 100000,
        convert_rate: 1 / 3,
        win_rate: 1,
      },
      {
        source: "referral",
        leads: 1,
        converted: 0,
        won: 0,
        won_value: 0,
        convert_rate: 0,
        win_rate: null,
      },
    ];
    const csv = toCsv(sourceRoiCsv(), rows);
    expect(csv).toContain("website,3,1,1,100000.00,33.3%,100.0%");
    expect(csv).toContain("referral,1,0,0,0.00,0.0%,");
  });

  it("time to close flattens to one row per outcome, and lost has no p90", () => {
    const t: TimeToClose = {
      won: { count: 2, avg_days: 15, median_days: 15, p90_days: 19 },
      lost: { count: 1, avg_days: 10, median_days: 10 },
    };
    const csv = toCsv(timeToCloseCsv(), timeToCloseRows(t));
    expect(csv).toContain("won,2,15.0,15.0,19.0");
    expect(csv).toContain("lost,1,10.0,10.0,");
  });

  it("stage conversion CSV keeps a stage nobody advanced out of", () => {
    const rows: StageRow[] = [
      { stage: "Qualified", entered: 3, advanced: 2, advance_rate: 2 / 3 },
      { stage: "Offer", entered: 2, advanced: 0, advance_rate: 0 },
    ];
    const csv = toCsv(stageConversionCsv(), rows);
    expect(csv).toContain("Qualified,3,2,66.7%");
    // 0 of 2 is a real, measured 0% — distinct from a blank
    expect(csv).toContain("Offer,2,0,0.0%");
  });

  it("the RPC's caveat travels in the CSV — the note column carries it verbatim", () => {
    // RPT-2 residual (2026-09-01 review): the caveat that demotions count as
    // advancement lived only in the payload; a desk spreadsheet built on this
    // export had no way to know. Appended, never inserted — the withWindow rule.
    const NOTE =
      "advanced counts departures in ANY direction (demotions included) by deals that entered the stage in-window";
    const rows: StageRow[] = [
      { stage: "Qualified", entered: 3, advanced: 2, advance_rate: 2 / 3 },
    ];
    const csv = toCsv(stageConversionCsv(NOTE), rows);
    const header = csv.replace(/^﻿/, "").split("\r\n")[0];
    expect(header).toBe("Stage,Entered,Advanced,Advance rate,Note");
    // comma-free fragment — the full cell arrives RFC-4180-quoted
    expect(csv).toContain("demotions included");
    // the existing left-to-right row pin still holds with the appended column
    expect(csv).toContain("Qualified,3,2,66.7%");
    // and an absent note stays an empty cell, not a dropped column
    const bare = toCsv(stageConversionCsv(), rows);
    expect(bare.replace(/^﻿/, "").split("\r\n")[0]).toBe(
      "Stage,Entered,Advanced,Advance rate,Note",
    );
  });

  it("price reductions CSV resolves property references", () => {
    const rows: RepeatCut[] = [
      {
        property_id: "p-1",
        cuts: 2,
        total_cut: 95000,
        first_cut_at: "2024-03-02T12:00:00Z",
        last_cut_at: "2024-03-10T12:00:00Z",
      },
    ];
    const csv = toCsv(priceReductionsCsv(new Map([["p-1", "PAF0001"]])), rows);
    expect(csv).toContain("PAF0001,2,95000.00,2024-03-02T12:00:00Z,2024-03-10T12:00:00Z");
  });

  it("a stage name that looks like a formula is neutralised, as on every other export", () => {
    const rows: StageRow[] = [{ stage: "=HYPERLINK(\"evil\")", entered: 1, advanced: 0, advance_rate: 0 }];
    const csv = toCsv(stageConversionCsv(), rows);
    expect(csv).toContain("'=HYPERLINK");
  });
});
