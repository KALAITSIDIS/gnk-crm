import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * The performance page tells a failed stage-conversion report from an empty
 * one (T-stage-conversion-malformed, migration 0130).
 *
 * Before: the page read `convRes.data` and never `convRes.error`, so the 22P02
 * one malformed event caused rendered as "Nothing in this window." These tests
 * render the REAL server component with each answer the RPC can give — the
 * other five RPCs answering normally — and read the stage-conversion section
 * of the markup.
 */

type Rpc = { data: unknown; error: unknown };
const state = vi.hoisted(() => ({ rpc: {} as Record<string, Rpc> }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => state.rpc[name] ?? { data: null, error: null },
    from: fakeClient({ profiles: [{ data: [{ id: "agent-1", full_name: "Anna Agent", is_active: true }], error: null }] })
      .client.from,
  }),
}));
// keys and values, so the markup says exactly which message was chosen
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `[${key} ${Object.entries(vars).map(([k, v]) => `${k}=${String(v)}`).join(" ")}]` : `[${key}]`,
}));

const ROW = { stage: "Qualified", entered: 2, advanced: 1, advance_rate: 0.5 };
const conv = (over: Record<string, unknown> = {}) => ({
  derived_from: "events",
  stage_key: "name",
  moves_total: 3,
  moves_with_ids: 3,
  moves_malformed: 0,
  stages: [ROW],
  transitions: [],
  outcomes: { won: 1, lost: 0 },
  note: "THE-NOTE",
  ...over,
});
const NONE = { stages: [], moves_total: 0, moves_with_ids: 0 };

beforeEach(() => {
  state.rpc = {
    report_agent_performance: {
      data: [
        {
          agent_id: "agent-1",
          leads_assigned: 4,
          leads_answered: 3,
          avg_first_response_min: 10,
          viewings_completed: 2,
          deals_won: 1,
          won_value: 1000,
          deals_lost: 0,
        },
      ],
      error: null,
    },
    report_source_roi: { data: [], error: null },
    report_time_to_close: { data: null, error: null },
    report_price_reductions: { data: null, error: null },
    report_citation: { data: null, error: null },
  };
});

async function render(stageConversion: Rpc) {
  state.rpc.report_stage_conversion = stageConversion;
  const { default: Page } = await import("@/app/(app)/reports/performance/page");
  const el = (await Page({ searchParams: Promise.resolve({ from: "2026-01-01", to: "2026-01-31" }) })) as ReactElement;
  const html = renderToStaticMarkup(el);
  const sections = html.split("<section").slice(1);
  const stage = sections.find((s) => s.includes("[stages.heading]"));
  const agents = sections.find((s) => s.includes("[agents.heading]"));
  expect(stage, "the stage-conversion section renders").toBeDefined();
  return { html, stage: stage!, agents: agents! };
}

const EXPORT_LINK = "report=stage_conversion";

describe("the stage-conversion section", () => {
  it("an RPC failure renders as a failure — not as an empty window — and hides the export", async () => {
    const { stage, agents, html } = await render({
      data: null,
      error: { code: "22P02", message: 'invalid input syntax for type uuid: "secret-payload"' },
    });
    expect(stage).toContain("[stages.loadError]");
    expect(stage).toContain('role="alert"');
    expect(stage).not.toContain("[empty]");
    expect(stage).not.toContain(EXPORT_LINK);
    expect(stage, "no outcomes line from a report that failed").not.toContain("stages.outcomes");
    expect(html, "the raw database error never reaches the page").not.toContain("secret-payload");
    expect(html).not.toContain("22P02");
    // an unrelated section still renders its data
    expect(agents).toContain("Anna Agent");
    expect(agents).toContain("report=agent_performance");
  });

  it("a successful report with no activity is the plain empty state, with its export", async () => {
    const { stage } = await render({ data: conv(NONE), error: null });
    expect(stage).toContain("[empty]");
    expect(stage).not.toContain("stages.loadError");
    expect(stage).not.toContain("stages.excluded");
    expect(stage).not.toContain("stages.allExcluded");
    expect(stage).toContain(EXPORT_LINK);
  });

  it("valid data with exclusions shows the data AND a count of what was left out", async () => {
    const { stage } = await render({ data: conv({ moves_malformed: 2 }), error: null });
    expect(stage).toContain(">Qualified<");
    expect(stage).toContain('[stages.excluded count=2]');
    expect(stage).toContain('data-testid="stage-conversion-excluded"');
    expect(stage).not.toContain("[empty]");
    expect(stage).toContain(EXPORT_LINK);
    expect(stage).toContain("THE-NOTE");
  });

  it("valid data with nothing excluded shows no warning", async () => {
    const { stage } = await render({ data: conv(), error: null });
    expect(stage).toContain(">Qualified<");
    expect(stage).not.toContain("stages.excluded");
  });

  it("no stage rows, a valid move AND exclusions: empty plus the exclusion count — never 'all unreadable'", async () => {
    const { stage } = await render({ data: conv({ stages: [], moves_total: 1, moves_with_ids: 0, moves_malformed: 2 }), error: null });
    expect(stage).toContain("[empty]");
    expect(stage).toContain("[stages.excluded count=2]");
    expect(stage).not.toContain("stages.allExcluded");
    expect(stage, "the route would refuse it (422), so no link").not.toContain(EXPORT_LINK);
  });

  it("an all-malformed window says so instead of 'nothing in this window', and offers no export", async () => {
    const { stage } = await render({ data: conv({ ...NONE, moves_malformed: 3 }), error: null });
    expect(stage).toContain('[stages.allExcluded count=3]');
    expect(stage).not.toContain("[empty]");
    expect(stage).not.toContain("<table");
    expect(stage).not.toContain(EXPORT_LINK);
  });
});
