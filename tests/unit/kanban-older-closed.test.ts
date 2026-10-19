import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the board's hooks and action, outside a Next app: rendering needs neither
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/actions/deals", () => ({ moveDealToStage: vi.fn() }));

const { KanbanBoard } = await import("@/components/features/pipeline/kanban");

/**
 * The board's won and lost columns hold the last 30 days only (DECISIONS
 * T-audit-pipeline item 4). Each now links to the deals closed before that —
 * the /deals register, pre-filtered to the board's type and the column's
 * outcome (F05) — so a deal closed on day 31 is one click away, not lost.
 */
const stages = [
  { id: "s-open", name: "Negotiation", sort_order: 1, is_won: false, is_lost: false },
  { id: "s-won", name: "Won", sort_order: 2, is_won: true, is_lost: false },
  { id: "s-lost", name: "Lost", sort_order: 3, is_won: false, is_lost: true },
];

const render = (dealType?: string) =>
  renderToStaticMarkup(createElement(KanbanBoard, { stages, deals: [], canMove: true, dealType })).replace(
    /&amp;/g,
    "&",
  );

/** The markup of one column, by its stage id. */
const column = (html: string, id: string) => {
  const start = html.indexOf(`data-stage-id="${id}"`);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
};

describe("the closed columns link to the deals closed before the board's window", () => {
  it("won → /deals for this type, won; lost → /deals for this type, lost", () => {
    const html = render("rental");
    expect(column(html, "s-won")).toContain('href="/deals?type=rental&status=won"');
    expect(column(html, "s-lost")).toContain('href="/deals?type=rental&status=lost"');
    expect(column(html, "s-won")).toContain("Older closed deals →");
    // the window and how to close are still said
    expect(column(html, "s-lost")).toContain("Last 30 days — close deals from the deal page");
  });

  it("an open column carries no such link", () => {
    expect(column(render("sale"), "s-open")).not.toContain("/deals?");
  });

  it("without a deal type the board renders as before, with no link", () => {
    const html = render(undefined);
    expect(html).not.toContain("Older closed deals");
    expect(column(html, "s-won")).toContain("Last 30 days — close deals from the deal page");
  });
});
