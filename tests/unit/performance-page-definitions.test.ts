import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { fakeClient } from "@/lib/testing/fake-client";
import en from "@/messages/en.json";
import el from "@/messages/el.json";
import ru from "@/messages/ru.json";

/**
 * F06: the performance page says what its figures are — rendered with the
 * REAL English messages, so these assertions read the words a user reads.
 *
 *   - "Lead sources", never "ROI" (the URL key and audit list `source_roi`
 *     stay — the export link still carries it);
 *   - money in euros through formatMoney (doc 02 §A11);
 *   - the definitions: cohort by enquiry date, the deal's status today,
 *     repeat enquiries and spam, the transaction value not commission, not a
 *     return on investment; the agent table's window rule;
 *   - the scope line chosen from the caller's ROLE (RLS decides it), never
 *     the old "your own records only";
 *   - each report's failure in its own section (BACKLOG "The performance page
 *     paints four other reports' failures as 'Nothing in this window.'"):
 *     role="alert", no export link, the other sections intact — and a
 *     shapeless answer is a failure too, never zeros;
 *   - a database still at 0076 / 0130 (a rollback) is labelled as what it
 *     counts.
 */

type Rpc = { data: unknown; error: unknown };
const state = vi.hoisted(() => ({
  rpc: {} as Record<string, Rpc>,
  role: "admin" as "admin" | "agent" | "listing_manager",
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => state.rpc[name] ?? { data: null, error: null },
    from: fakeClient({
      profiles: [{ data: [{ id: "agent-1", full_name: "Anna Agent", is_active: true }], error: null }],
    }).client.from,
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "user-1", orgId: "org-1", role: state.role, fullName: "Someone" }),
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale: "en",
        messages,
        namespace: namespace as never,
        onError: (e) => {
          throw e;
        },
      }),
  };
});

const SOURCE = {
  source: "website",
  leads: 8,
  spam: 2,
  converted: 5,
  converted_visible: 5,
  won: 2,
  won_value: 302400,
  convert_rate: 5 / 6,
  win_rate: 0.4,
};
const ok = (): Record<string, Rpc> => ({
  report_agent_performance: {
    data: [
      {
        agent_id: "agent-1",
        leads_assigned: 4,
        leads_answered: 3,
        avg_first_response_min: 10,
        viewings_completed: 2,
        deals_won: 1,
        won_value: 1234567,
        deals_lost: 0,
      },
    ],
    error: null,
  },
  report_source_roi: { data: [SOURCE], error: null },
  report_time_to_close: {
    data: { won: { count: 1, avg_days: 10, median_days: 10, p90_days: 10 }, lost: { count: 0, avg_days: null, median_days: null } },
    error: null,
  },
  report_stage_conversion: {
    data: {
      derived_from: "events",
      stage_key: "id",
      moves_total: 1,
      moves_with_ids: 1,
      moves_malformed: 0,
      stages: [
        { deal_type: "sale", stage_id: "s-q", stage: "Qualified", sort_order: 2, entered: 1, advanced: 1, regressed: 0, departed_unknown: 0, advance_rate: 1 },
      ],
      transitions: [],
      outcomes: { won: 0, lost: 0 },
      outcomes_by_type: [],
      note: "THE-NOTE",
    },
    error: null,
  },
  report_price_reductions: {
    data: { reductions: 1, properties_affected: 1, avg_cut_fraction: 0.1, median_cut_fraction: 0.1, total_cut_amount: 50000, repeat_cuts: [] },
    error: null,
  },
  report_citation: {
    data: {
      computed_at: "2026-01-31T10:00:00Z",
      visible_last_event_id: 9,
      chain_verified_through: 7,
      chain_verified_hash: "abcdef0123456789",
      chain_verified_at: "2026-01-31T03:00:00Z",
      chain_full_walk_at: null,
      scope: "org",
    },
    error: null,
  },
});

beforeEach(() => {
  state.rpc = ok();
  state.role = "admin";
});

const HEADINGS = {
  agents: "Agent performance",
  sources: "Lead sources",
  ttc: "Time to close",
  stages: "Stage conversion",
  prices: "Price reductions",
} as const;

async function render() {
  const { default: Page } = await import("@/app/(app)/reports/performance/page");
  const el = (await Page({ searchParams: Promise.resolve({ from: "2026-01-01", to: "2026-01-31" }) })) as ReactElement;
  const html = renderToStaticMarkup(el);
  const sections = html.split("<section").slice(1);
  const section = (heading: string) => {
    const s = sections.find((x) => x.includes(`>${heading}</h2>`));
    expect(s, `the "${heading}" section renders`).toBeDefined();
    return s!;
  };
  return { html, section };
}

/** Text without tags and entities — what a reader sees. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the performance page's words (F06)", () => {
  it("calls the section 'Lead sources' and never says ROI; the export keeps its source_roi key", async () => {
    const { html, section } = await render();
    expect(text(section(HEADINGS.sources))).toContain("Lead sources");
    expect(text(html)).not.toMatch(/\bROI\b/i);
    expect(section(HEADINGS.sources)).toContain("report=source_roi");
  });

  it("shows money in euros through formatMoney", async () => {
    const { section } = await render();
    expect(text(section(HEADINGS.agents))).toContain("€1.234.567");
    expect(text(section(HEADINGS.sources))).toContain("€302.400");
    expect(text(section(HEADINGS.prices))).toContain("€50.000");
    expect(text(section(HEADINGS.sources))).toContain("Won deal value");
  });

  it("defines the lead-source figures: cohort, today's status, repeats and spam, transaction value not commission, not a return on investment", async () => {
    const { section } = await render();
    const def = text(section(HEADINGS.sources));
    expect(def).toContain("Enquiries received in this window, by the source recorded on each enquiry.");
    expect(def).toContain("repeat enquiries from one person included");
    expect(def).toContain("whenever the deal was won (its status today)");
    expect(def).toContain("the transaction value, not commission");
    expect(def).toContain("sale prices and rents added together");
    expect(def).toContain("No marketing spend is recorded, so this is not a return on investment.");
    expect(def).toContain("Enquiries marked spam count under Leads and Spam and are left out of the convert rate.");
    expect(def).toContain("Convert rate (excl. spam)");
    expect(def).toContain("83.3%");
  });

  it("states the agent table's window rule", async () => {
    const { section } = await render();
    expect(text(section(HEADINGS.agents))).toContain("won or lost deals in the window they closed");
  });

  it("says nothing false about stage names: no 'renaming splits its history'; it names the tamper-evident activity log", async () => {
    const { html, section } = await render();
    expect(text(html)).not.toMatch(/renaming one splits its history/);
    expect(text(html)).not.toMatch(/hash-chained event log/);
    expect(text(section(HEADINGS.stages))).toContain("Computed from the tamper-evident activity log.");
    expect(text(section(HEADINGS.stages))).toContain("A renamed stage keeps its history");
    expect(text(section(HEADINGS.stages))).toContain("Moved forward");
  });

  it("an admin's scope: the whole agency, everywhere", async () => {
    const { html, section } = await render();
    expect(text(html)).toContain("Every figure on this page covers the whole agency.");
    expect(text(section(HEADINGS.sources))).toContain("These figures cover the whole agency.");
    expect(text(html), "the old claim was false for every non-admin").not.toContain("your own records only");
  });

  it("a listing manager's scope: the whole agency except stage conversion", async () => {
    state.role = "listing_manager";
    const { html, section } = await render();
    expect(text(html)).toContain("except stage conversion, which counts only the stage changes and closes you recorded yourself");
    expect(text(section(HEADINGS.sources))).toContain("These figures cover the whole agency.");
  });

  it("an agent's scope: shared enquiries, own deals, and the win rate within that scope", async () => {
    state.role = "agent";
    state.rpc.report_source_roi = { data: [{ ...SOURCE, converted_visible: 2, won: 1, won_value: 300000, win_rate: 0.5 }], error: null };
    const { html, section } = await render();
    expect(text(html)).toContain("Deals — won, lost, their value and time to close — count only the deals assigned to you or created by you");
    const src = text(section(HEADINGS.sources));
    expect(src).toContain("Leads, spam and conversions cover the whole agency — the enquiry inbox is shared.");
    expect(src).toContain("Win rate is Won divided by the converted enquiries whose deal you can see.");
    expect(src, "the converted count says how many of them the agent can see").toContain("2 with a deal you can see");
    expect(src).not.toContain("These figures cover the whole agency.");
  });

  const failures: Array<[string, string, string, string]> = [
    ["report_agent_performance", HEADINGS.agents, "agent-performance-error", "report=agent_performance"],
    ["report_source_roi", HEADINGS.sources, "lead-sources-error", "report=source_roi"],
    ["report_time_to_close", HEADINGS.ttc, "time-to-close-error", "report=time_to_close"],
    ["report_price_reductions", HEADINGS.prices, "price-reductions-error", "report=price_reductions"],
  ];
  for (const [rpc, heading, testId, link] of failures) {
    for (const [label, answer] of [
      ["an RPC error", { data: null, error: { code: "57014", message: "secret-detail" } }],
      ["a missing body", { data: null, error: null }],
    ] as const) {
      it(`${rpc}: ${label} is a failure in its own section — alert, no export, no zeros — and the rest renders`, async () => {
        state.rpc[rpc] = answer;
        const { html, section } = await render();
        const s = section(heading);
        expect(s).toContain('role="alert"');
        expect(s).toContain(`data-testid="${testId}"`);
        expect(text(s)).toContain("This report could not be loaded. Reload the page to try again.");
        expect(s).not.toContain(link);
        expect(text(s)).not.toContain("Nothing in this window.");
        expect(text(s), "no figure is shown for a report that failed").not.toMatch(/€|\b0 deals\b/);
        expect(html).not.toContain("secret-detail");
        for (const [otherRpc, otherHeading, , otherLink] of failures) {
          if (otherRpc === rpc) continue;
          expect(section(otherHeading), `${otherHeading} still renders`).toContain(otherLink);
          expect(section(otherHeading)).not.toContain('role="alert"');
        }
      });
    }
  }

  it("a summary report missing its counts is a failure, not zeros", async () => {
    state.rpc.report_time_to_close = { data: { won: { avg_days: 1 }, lost: {} }, error: null };
    state.rpc.report_price_reductions = { data: { repeat_cuts: [] }, error: null };
    const { section } = await render();
    expect(section(HEADINGS.ttc)).toContain('data-testid="time-to-close-error"');
    expect(section(HEADINGS.prices)).toContain('data-testid="price-reductions-error"');
  });

  it("a failed citation says so instead of vanishing; the reports still render", async () => {
    state.rpc.report_citation = { data: null, error: { message: "boom" } };
    const { html, section } = await render();
    expect(html).toContain('data-testid="citation-error"');
    expect(text(html)).toContain("The audit anchor could not be loaded");
    expect(section(HEADINGS.sources)).toContain("report=source_roi");
  });

  it("a database still at 0076 / 0130: no 'excl. spam' over a rate that counts spam; an agent is told the win rate mixes scopes", async () => {
    state.role = "agent";
    const legacy: Record<string, unknown> = { ...SOURCE, convert_rate: 5 / 8, win_rate: 0.2 };
    delete legacy.spam;
    delete legacy.converted_visible;
    state.rpc.report_source_roi = { data: [legacy], error: null };
    const { section } = await render();
    const src = text(section(HEADINGS.sources));
    expect(src).not.toContain("excl. spam");
    expect(src).not.toContain("left out of the convert rate");
    expect(src).toContain("Win rate divides the won deals you can see by the whole agency's conversions");
    expect(src, "the spam cell is a dash, not 0").toMatch(/website 8 — 5/);
  });
});

describe("no locale calls the report a return on investment", () => {
  const values = (node: unknown): string[] =>
    typeof node === "string" ? [node] : node && typeof node === "object" ? Object.values(node).flatMap(values) : [];
  for (const [name, messages] of Object.entries({ en, el, ru })) {
    it(`${name}: no message says ROI; the section heading is the lead-sources one`, () => {
      expect(values(messages).filter((v) => /\bROI\b/i.test(v))).toEqual([]);
      expect(messages.reports.performance.sources.heading).not.toMatch(/ROI|отдача|απόδοση/i);
    });
  }
});
