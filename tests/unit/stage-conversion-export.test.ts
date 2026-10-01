import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The stage-conversion CSV is honest about what it left out
 * (T-stage-conversion-malformed, migration 0130).
 *
 * Before 0130 one malformed `stage_changed` made `report_stage_conversion`
 * raise 22P02 and this export answered 500 for every window containing it.
 * The RPC now excludes and counts such movements (`moves_malformed`); these
 * tests drive the REAL route handler with each answer the RPC can give and
 * read the response and the audit event the handler actually writes.
 */

const state = vi.hoisted(() => ({ rpc: { data: null as unknown, error: null as unknown } }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => {
      expect(name).toBe("report_stage_conversion");
      return state.rpc;
    },
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "user-1", orgId: "org-1", role: "admin", fullName: "Admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));

const NOTE = "advanced counts departures in ANY direction";
const ROW = { stage: "Qualified", entered: 2, advanced: 1, advance_rate: 0.5 };
const report = (over: Record<string, unknown> = {}) => ({
  derived_from: "events",
  stage_key: "name",
  moves_total: 3,
  moves_with_ids: 3,
  moves_malformed: 0,
  stages: [ROW],
  transitions: [{ from: "New", to: "Qualified", deals: 2 }],
  outcomes: { won: 0, lost: 0 },
  note: NOTE,
  ...over,
});

beforeEach(() => {
  logEvent.mockClear();
});

async function exportWith(rpc: { data: unknown; error: unknown }) {
  state.rpc = rpc;
  const { GET } = (await import("@/app/(app)/reports/performance/export/route")) as {
    GET: (r: NextRequest) => Promise<Response>;
  };
  const url = new URL("http://localhost/reports/performance/export");
  url.searchParams.set("report", "stage_conversion");
  url.searchParams.set("from", "2026-01-01");
  url.searchParams.set("to", "2026-01-31");
  const res = await GET(new NextRequest(url));
  return { res, body: await res.text() };
}

const lines = (csv: string) => csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
const HEADER = "Stage,Entered,Advanced,Advance rate,Note,From,To,Malformed moves excluded";

describe("stage-conversion CSV export", () => {
  it("a normal report exports its rows, with 0 excluded on every row", async () => {
    const { res, body } = await exportWith({ data: report(), error: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(lines(body)).toEqual([HEADER, `Qualified,2,1,50.0%,${NOTE},2026-01-01,2026-01-31,0`]);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({ payload: { list: "report:stage_conversion", count: 1 } });
  });

  it("a mixed window keeps its valid rows exportable and states the exclusions on each", async () => {
    const { res, body } = await exportWith({ data: report({ moves_malformed: 2 }), error: null });
    expect(res.status).toBe(200);
    expect(lines(body)).toEqual([HEADER, `Qualified,2,1,50.0%,${NOTE},2026-01-01,2026-01-31,2`]);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("a genuinely empty window is a header-only file, as every export's is", async () => {
    const { res, body } = await exportWith({
      data: report({ stages: [], transitions: [], moves_total: 0, moves_with_ids: 0 }),
      error: null,
    });
    expect(res.status).toBe(200);
    expect(lines(body)).toEqual([HEADER]);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({ payload: { count: 0 } });
  });

  it("an all-malformed window is refused with 422 — never an apparently complete empty file", async () => {
    const { res, body } = await exportWith({
      data: report({ stages: [], transitions: [], moves_total: 0, moves_with_ids: 0, moves_malformed: 3 }),
      error: null,
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = JSON.parse(body) as { error: string };
    expect(json.error).toMatch(/no stage figures, and 3 stage change\(s\) with an unreadable stage reference were excluded/);
    expect(logEvent, "nothing was exported, so nothing is audited as exported").not.toHaveBeenCalled();
  });

  it("no stage rows beside a valid movement AND exclusions is refused too — the count has no row to ride on", async () => {
    const { res, body } = await exportWith({
      data: report({ stages: [], transitions: [], moves_total: 1, moves_with_ids: 0, moves_malformed: 2 }),
      error: null,
    });
    expect(res.status).toBe(422);
    expect((JSON.parse(body) as { error: string }).error).toMatch(/2 stage change\(s\)/);
    expect((JSON.parse(body) as { error: string }).error, "and it does not claim ALL were unreadable").not.toMatch(/\ball\b/i);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a genuine RPC failure is still an explicit 500, and the database's error text does not leak", async () => {
    const { res, body } = await exportWith({
      data: null,
      error: { code: "22P02", message: 'invalid input syntax for type uuid: "secret-payload"' },
    });
    expect(res.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: "Export failed." });
    expect(body).not.toContain("secret-payload");
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a body that is not a report is a failure, not an empty file", async () => {
    const { res } = await exportWith({ data: null, error: null });
    expect(res.status).toBe(500);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a database still at 0076's body (no moves_malformed) exports as before, 0 excluded", async () => {
    const legacy = report() as Record<string, unknown>;
    delete legacy.moves_malformed;
    const { res, body } = await exportWith({ data: legacy, error: null });
    expect(res.status).toBe(200);
    expect(lines(body)[1]).toBe(`Qualified,2,1,50.0%,${NOTE},2026-01-01,2026-01-31,0`);
  });
});
