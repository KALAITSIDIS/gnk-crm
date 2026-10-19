import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import {
  agentPerformanceCsv,
  isCitation,
  isDirectional,
  isPriceReductions,
  isReportKey,
  isTimeToClose,
  num,
  pct,
  priceReductionsCsv,
  reportObject,
  reportRows,
  sourceRoiCsv,
  sourceRowsDefineSpam,
  stageConversionCsv,
  stageConversionView,
  stagesByPipeline,
  timeToCloseCsv,
  timeToCloseRows,
  withExcluded,
  withSourceSplits,
  withStageSplits,
  withWindow,
  type AgentPerformanceRow,
  type RepeatCut,
  type SourceRoiRow,
  type StageConversion,
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

  describe("stageConversionView — the section's four honest states (0130)", () => {
    const report = (over: Record<string, unknown> = {}) => ({
      derived_from: "events",
      stage_key: "name",
      moves_total: 0,
      moves_with_ids: 0,
      moves_malformed: 0,
      stages: [],
      transitions: [],
      outcomes: { won: 0, lost: 0 },
      note: "n",
      ...over,
    });
    const row = { stage: "Qualified", entered: 2, advanced: 1, advance_rate: 0.5 };

    it("an RPC error is an error — never an empty window", () => {
      expect(stageConversionView({ data: null, error: { code: "22P02", message: "x" } })).toEqual({ status: "error" });
      // even if a body came back alongside it
      expect(stageConversionView({ data: report({ stages: [row] }), error: { message: "x" } }).status).toBe("error");
    });

    it("a missing or shapeless body is an error too", () => {
      for (const data of [null, undefined, "x", 1, [], {}, { stages: "nope" }]) {
        expect(stageConversionView({ data, error: null }).status, JSON.stringify(data)).toBe("error");
      }
    });

    it("no rows and nothing excluded is a genuine empty window", () => {
      expect(stageConversionView({ data: report(), error: null })).toMatchObject({ status: "empty", excluded: 0 });
    });

    it("rows with nothing excluded, and rows with exclusions, both keep their data", () => {
      expect(stageConversionView({ data: report({ stages: [row] }), error: null })).toMatchObject({
        status: "data",
        excluded: 0,
      });
      const mixed = stageConversionView({ data: report({ stages: [row], moves_malformed: 3 }), error: null });
      expect(mixed).toMatchObject({ status: "data", excluded: 3 });
      expect(mixed.status === "data" && mixed.conv.stages).toEqual([row]);
    });

    it("no valid movement but exclusions is its own state, not 'empty'", () => {
      expect(stageConversionView({ data: report({ moves_malformed: 2 }), error: null })).toMatchObject({
        status: "excluded_only",
        excluded: 2,
      });
    });

    it("no rows, but a valid movement beside the exclusions, is empty-with-exclusions — not 'all unreadable'", () => {
      expect(stageConversionView({ data: report({ moves_total: 1, moves_malformed: 2 }), error: null })).toMatchObject({
        status: "empty",
        excluded: 2,
      });
    });

    it("a body from before 0130 (no moves_malformed) reads as nothing excluded; a string count is a count", () => {
      const legacy = report({ stages: [row] }) as Record<string, unknown>;
      delete legacy.moves_malformed;
      expect(stageConversionView({ data: legacy, error: null })).toMatchObject({ status: "data", excluded: 0 });
      expect(stageConversionView({ data: report({ moves_malformed: "4" }), error: null })).toMatchObject({
        status: "excluded_only",
        excluded: 4,
      });
    });
  });

  it("the exclusion count is APPENDED after From/To on every row, 0 included", () => {
    const rows: StageRow[] = [{ stage: "Qualified", entered: 3, advanced: 2, advance_rate: 2 / 3 }];
    const csv = toCsv(withExcluded(withWindow(stageConversionCsv("n"), "2026-01-01", "2026-01-31"), 5), rows);
    const [header, line] = csv.replace(/^﻿/, "").split("\r\n");
    expect(header).toBe("Stage,Entered,Advanced,Advance rate,Note,From,To,Malformed moves excluded");
    expect(line).toBe("Qualified,3,2,66.7%,n,2026-01-01,2026-01-31,5");
    const zero = toCsv(withExcluded(withWindow(stageConversionCsv("n"), "a", "b"), 0), rows);
    expect(zero.replace(/^﻿/, "").split("\r\n")[1]).toBe("Qualified,3,2,66.7%,n,a,b,0");
  });

  it("a stage name that looks like a formula is neutralised, as on every other export", () => {
    const rows: StageRow[] = [{ stage: "=HYPERLINK(\"evil\")", entered: 1, advanced: 0, advance_rate: 0 }];
    const csv = toCsv(stageConversionCsv(), rows);
    expect(csv).toContain("'=HYPERLINK");
  });

  describe("0154 (F06): the lead-source and stage splits", () => {
    it("lead sources append Spam and the visible conversions after From / To; blank before 0154", () => {
      const rows: SourceRoiRow[] = [
        { source: "website", leads: 8, spam: 2, converted: 5, converted_visible: 2, won: 1, won_value: 300000, convert_rate: 5 / 6, win_rate: 0.5 },
        { source: "referral", leads: 1, converted: 0, won: 0, won_value: 0, convert_rate: 0, win_rate: null },
      ];
      const [header, a, b] = toCsv(withSourceSplits(withWindow(sourceRoiCsv(), "f", "t")), rows)
        .replace(/^﻿/, "")
        .split("\r\n");
      expect(header).toBe('Source,Leads,Converted,Won,Won value,Convert rate,Win rate,From,To,Spam,"Converted, deal visible"');
      expect(a, "the 0065 row pin still reads left to right").toBe("website,8,5,1,300000.00,83.3%,50.0%,f,t,2,2");
      expect(b).toBe("referral,1,0,0,0.00,0.0%,,f,t,,");
    });

    it("sourceRowsDefineSpam tells 0154's rows from 0076's", () => {
      const row = { source: "x", leads: 1, converted: 0, won: 0, won_value: 0, convert_rate: 0, win_rate: null };
      expect(sourceRowsDefineSpam([{ ...row, spam: 0 }])).toBe(true);
      expect(sourceRowsDefineSpam([row])).toBe(false);
      expect(sourceRowsDefineSpam([])).toBe(false);
    });

    it("the stage split is appended after the exclusion count; an unknown pipeline says 'unknown', a recorded name has no id", () => {
      const rows: StageRow[] = [
        { deal_type: "sale", stage_id: "s-1", stage: "Viewing", sort_order: 3, entered: 2, advanced: 1, regressed: 1, departed_unknown: 0, advance_rate: 0.5 },
        { deal_type: null, stage_id: null, stage: "OLD", sort_order: null, entered: 1, advanced: 0, regressed: 0, departed_unknown: 1, advance_rate: 0 },
        { stage: "Legacy", entered: 1, advanced: 1, advance_rate: 1 },
      ];
      const [header, a, b, c] = toCsv(withStageSplits(withExcluded(withWindow(stageConversionCsv("n"), "f", "t"), 0)), rows)
        .replace(/^﻿/, "")
        .split("\r\n");
      expect(header).toBe(
        "Stage,Entered,Advanced,Advance rate,Note,From,To,Malformed moves excluded,Deal type,Moved back,Direction unknown,Stage id",
      );
      expect(a).toBe("Viewing,2,1,50.0%,n,f,t,0,sale,1,0,s-1");
      expect(b).toBe("OLD,1,0,0.0%,n,f,t,0,unknown,0,1,");
      expect(c, "a 0130 row: four blank cells").toBe("Legacy,1,1,100.0%,n,f,t,0,,,,");
    });

    it("stagesByPipeline keeps the answer's order and puts an unreadable pipeline in its own group", () => {
      const rows: StageRow[] = [
        { deal_type: "sale", stage: "A", entered: 1, advanced: 0, advance_rate: 0 },
        { deal_type: "sale", stage: "B", entered: 1, advanced: 0, advance_rate: 0 },
        { deal_type: "rental", stage: "A", entered: 1, advanced: 0, advance_rate: 0 },
        { deal_type: null, stage: "C", entered: 1, advanced: 0, advance_rate: 0 },
      ];
      expect(stagesByPipeline(rows).map((g) => [g.dealType, g.stages.map((s) => s.stage)])).toEqual([
        ["sale", ["A", "B"]],
        ["rental", ["A"]],
        [null, ["C"]],
      ]);
      // a 0130 body has no deal_type: one group, as it always was
      expect(stagesByPipeline([{ stage: "A", entered: 1, advanced: 0, advance_rate: 0 }]).map((g) => g.dealType)).toEqual([null]);
    });

    it("isDirectional reads stage_key: 'id' since 0154, 'name' at 0130", () => {
      const base = { derived_from: "events", stages: [], transitions: [], outcomes: { won: 0, lost: 0 }, note: "" };
      expect(isDirectional({ ...base, stage_key: "id" } as StageConversion)).toBe(true);
      expect(isDirectional({ ...base, stage_key: "name" } as StageConversion)).toBe(false);
    });
  });

  describe("the other reports' answers: a failure is never an empty list or zeros", () => {
    it("reportRows: an error or a non-array is an error; an array is rows (empty included)", () => {
      expect(reportRows({ data: [], error: null })).toEqual({ status: "ok", rows: [] });
      expect(reportRows({ data: [{ a: 1 }], error: null })).toEqual({ status: "ok", rows: [{ a: 1 }] });
      for (const data of [null, undefined, {}, "x", 1]) {
        expect(reportRows({ data, error: null }).status, JSON.stringify(data)).toBe("error");
      }
      expect(reportRows({ data: [], error: { message: "x" } }).status).toBe("error");
    });

    it("reportObject: only a body its validator accepts", () => {
      const ttc = { won: { count: 1, avg_days: 1, median_days: 1, p90_days: 1 }, lost: { count: "0", avg_days: null, median_days: null } };
      expect(reportObject({ data: ttc, error: null }, isTimeToClose).status).toBe("ok");
      expect(reportObject({ data: { won: {}, lost: {} }, error: null }, isTimeToClose).status).toBe("error");
      expect(reportObject({ data: ttc, error: { message: "x" } }, isTimeToClose).status).toBe("error");
      expect(reportObject({ data: [ttc], error: null }, isTimeToClose).status).toBe("error");

      const price = { reductions: 0, properties_affected: 0, avg_cut_fraction: null, median_cut_fraction: null, total_cut_amount: null, repeat_cuts: [] };
      expect(reportObject({ data: price, error: null }, isPriceReductions).status).toBe("ok");
      expect(reportObject({ data: { ...price, repeat_cuts: null }, error: null }, isPriceReductions).status).toBe("error");
      expect(reportObject({ data: { repeat_cuts: [] }, error: null }, isPriceReductions).status).toBe("error");

      const cite = { chain_verified_through: null, chain_verified_hash: null, chain_verified_at: null, scope: "own" };
      expect(reportObject({ data: cite, error: null }, isCitation).status, "no checkpoint yet is a real answer").toBe("ok");
      expect(reportObject({ data: null, error: null }, isCitation).status).toBe("error");
    });
  });
});
