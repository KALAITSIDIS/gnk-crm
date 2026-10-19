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
// the page reads the caller's role for its scope lines (F06)
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "user-1", orgId: "org-1", role: "admin", fullName: "Admin" }),
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

describe("the stage-conversion section against 0154's answer (F06)", () => {
  const SALE_Q = { deal_type: "sale", stage_id: "s-q", stage: "Qualified", sort_order: 2, entered: 1, advanced: 1, regressed: 0, departed_unknown: 0, advance_rate: 1 };
  const SALE_V = { deal_type: "sale", stage_id: "s-v", stage: "Viewing", sort_order: 3, entered: 1, advanced: 0, regressed: 1, departed_unknown: 0, advance_rate: 0 };
  const LEGACY = { deal_type: "sale", stage_id: null, stage: "OLD-B", sort_order: null, entered: 1, advanced: 0, regressed: 0, departed_unknown: 1, advance_rate: 0 };
  const RENT_Q = { deal_type: "rental", stage_id: "r-q", stage: "Qualified", sort_order: 2, entered: 1, advanced: 0, regressed: 0, departed_unknown: 0, advance_rate: 0 };
  const UNKNOWN = { deal_type: null, stage_id: null, stage: "GONE", sort_order: null, entered: 1, advanced: 0, regressed: 0, departed_unknown: 0, advance_rate: 0 };
  const directional = (over: Record<string, unknown> = {}) =>
    conv({
      stage_key: "id",
      stages: [SALE_Q, SALE_V, LEGACY, RENT_Q, UNKNOWN],
      outcomes: { won: 2, lost: 1 },
      outcomes_by_type: [
        { deal_type: "sale", won: 1, lost: 0 },
        { deal_type: null, won: 1, lost: 1 },
      ],
      ...over,
    });

  it("one table per pipeline, in the answer's order, with the direction split — two 'Qualified' rows never merge", async () => {
    const { stage } = await render({ data: directional(), error: null });
    const sale = stage.indexOf('data-testid="stage-pipeline-sale"');
    const rental = stage.indexOf('data-testid="stage-pipeline-rental"');
    const unknown = stage.indexOf('data-testid="stage-pipeline-unknown"');
    expect(sale).toBeGreaterThan(0);
    expect(rental).toBeGreaterThan(sale);
    expect(unknown).toBeGreaterThan(rental);
    expect(stage).toContain("[stages.pipelines.sale]");
    expect(stage).toContain("[stages.pipelines.rental]");
    expect(stage).toContain("[stages.pipelines.unknown]");
    expect(stage.match(/>Qualified</g), "sale's and rental's Qualified are two rows").toHaveLength(2);
    for (const k of ["[stages.advanced]", "[stages.regressed]", "[stages.departedUnknown]", "[stages.forwardRate]"]) {
      expect(stage).toContain(k);
    }
    expect(stage, "the 0130 any-direction label is not used").not.toContain("stages.advancedAnyDirection");
    expect(stage, "a row without a current stage is labelled as the name recorded at the time").toContain(
      "[stages.recordedName stage=OLD-B]",
    );
    expect(stage).toContain("[stages.idKeyed]");
    expect(stage).not.toContain("stages.nameKeyed");
    expect(stage).toContain(EXPORT_LINK);
  });

  it("closes are counted per pipeline, and the reason they are not attributed stays", async () => {
    const { stage } = await render({ data: directional(), error: null });
    expect(stage).toContain("[stages.outcomes won=2 lost=1]");
    expect(stage).toContain("[stages.pipelines.sale]: [stages.outcomesPipeline won=1 lost=0]");
    expect(stage).toContain("[stages.pipelines.unknown]: [stages.outcomesPipeline won=1 lost=1]");
  });

  it("a database still at 0130 (stage_key 'name') is labelled as what it counts: either direction, merged by name", async () => {
    const { stage } = await render({ data: conv(), error: null });
    expect(stage).toContain("[stages.advancedAnyDirection]");
    expect(stage).toContain("[stages.advanceRate]");
    expect(stage).toContain("[stages.nameKeyed]");
    expect(stage).not.toContain("[stages.advanced]");
    expect(stage).not.toContain("stage-pipeline-");
  });
});
