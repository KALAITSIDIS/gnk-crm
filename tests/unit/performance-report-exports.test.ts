import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The performance-report CSVs other than stage conversion (F06).
 *
 *   - lead sources: the `source_roi` key and its seven columns stay; 0154's
 *     Spam and "Converted, deal visible" are APPENDED after From / To (the
 *     withWindow rule), blank against a database still at 0076;
 *   - every report: an RPC error, or an answer that is not the report, is an
 *     explicit 500 with no audit line — never a header-only file that reads
 *     as an empty window (the stage export has done this since 0130).
 *
 * Drives the REAL route handler and reads the response and the audit event it
 * actually writes.
 */

const state = vi.hoisted(() => ({ rpc: {} as Record<string, { data: unknown; error: unknown }> }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => state.rpc[name] ?? { data: null, error: null },
    from: () => ({
      select: () => ({ in: async () => ({ data: [], error: null }) }),
    }),
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "user-1", orgId: "org-1", role: "agent", fullName: "Agent" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));

beforeEach(() => {
  logEvent.mockClear();
  state.rpc = {};
});

async function exportOf(report: string) {
  const { GET } = (await import("@/app/(app)/reports/performance/export/route")) as {
    GET: (r: NextRequest) => Promise<Response>;
  };
  const url = new URL("http://localhost/reports/performance/export");
  url.searchParams.set("report", report);
  url.searchParams.set("from", "2026-01-01");
  url.searchParams.set("to", "2026-01-31");
  const res = await GET(new NextRequest(url));
  return { res, body: await res.text() };
}

const lines = (csv: string) => csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
const SOURCE_HEADER =
  "Source,Leads,Converted,Won,Won value,Convert rate,Win rate,From,To,Spam,\"Converted, deal visible\"";

describe("lead-source CSV (report=source_roi)", () => {
  it("keeps its columns and key, and appends Spam and the converted deals the exporter can see", async () => {
    state.rpc.report_source_roi = {
      data: [
        {
          source: "website",
          leads: 8,
          spam: 2,
          converted: 5,
          converted_visible: 2,
          won: 1,
          won_value: 300000,
          convert_rate: 5 / 6,
          win_rate: 0.5,
        },
      ],
      error: null,
    };
    const { res, body } = await exportOf("source_roi");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("report-source_roi-2026-01-01-to-2026-01-31");
    expect(lines(body)).toEqual([SOURCE_HEADER, "website,8,5,1,300000.00,83.3%,50.0%,2026-01-01,2026-01-31,2,2"]);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({ payload: { list: "report:source_roi", count: 1 } });
  });

  it("a database still at 0076 leaves the two appended cells blank — never a made-up 0", async () => {
    state.rpc.report_source_roi = {
      data: [{ source: "referral", leads: 1, converted: 0, won: 0, won_value: 0, convert_rate: 0, win_rate: null }],
      error: null,
    };
    const { body } = await exportOf("source_roi");
    expect(lines(body)[1]).toBe("referral,1,0,0,0.00,0.0%,,2026-01-01,2026-01-31,,");
  });
});

describe("a failed report is a failed export, for every report", () => {
  const cases: Array<[string, string]> = [
    ["agent_performance", "report_agent_performance"],
    ["source_roi", "report_source_roi"],
    ["time_to_close", "report_time_to_close"],
    ["price_reductions", "report_price_reductions"],
  ];
  for (const [report, rpc] of cases) {
    it(`${report}: an RPC error is a 500 that leaks nothing, and nothing is audited`, async () => {
      state.rpc[rpc] = { data: null, error: { code: "57014", message: "secret-detail" } };
      const { res, body } = await exportOf(report);
      expect(res.status).toBe(500);
      expect(JSON.parse(body)).toEqual({ error: "Export failed." });
      expect(body).not.toContain("secret-detail");
      expect(logEvent).not.toHaveBeenCalled();
    });

    it(`${report}: a missing body is a 500 too — not a header-only "empty" file`, async () => {
      state.rpc[rpc] = { data: null, error: null };
      const { res } = await exportOf(report);
      expect(res.status).toBe(500);
      expect(logEvent).not.toHaveBeenCalled();
    });
  }

  it("a summary without its counts is a failure, not a file of zeros", async () => {
    state.rpc.report_time_to_close = { data: { won: {}, lost: {} }, error: null };
    expect((await exportOf("time_to_close")).res.status).toBe(500);
    state.rpc.report_price_reductions = { data: { reductions: 1 }, error: null };
    expect((await exportOf("price_reductions")).res.status).toBe(500);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a real empty window still exports its header and is audited with count 0", async () => {
    state.rpc.report_source_roi = { data: [], error: null };
    const { res, body } = await exportOf("source_roi");
    expect(res.status).toBe(200);
    expect(lines(body)).toEqual([SOURCE_HEADER]);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({ payload: { list: "report:source_roi", count: 0 } });
  });
});
