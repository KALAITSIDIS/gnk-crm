import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the board's hooks and action, outside a Next app: rendering needs neither
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/actions/deals", () => ({ moveDealToStage: vi.fn() }));

const { KanbanBoard } = await import("@/components/features/pipeline/kanban");
const { MOVE_READ_ONLY_TEXT } = await import("@/lib/services/pipeline-move");

/**
 * The pipeline board's drop (T-kanban-drop-settle). The decisions live in
 * lib/services/pipeline-move.ts (`settleMove`, `mayMoveDeals`) and are
 * unit-tested there; this file pins that the board and its page USE them —
 * no jsdom here, so the component is read as source (comments stripped) for
 * the transition, and rendered on the server for the role gate.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf-8");

/** Code, not commentary. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\s*\}/g, "{}");
const code = (...parts: string[]) => stripComments(read(...parts));

/** The body of the first `opener … {` block, braces balanced (no braces in this file's strings). */
function blockAfter(src: string, opener: RegExp): string {
  const match = opener.exec(src);
  if (!match) return "";
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i);
    }
  }
  return "";
}

const BOARD = ["components", "features", "pipeline", "kanban.tsx"] as const;
const PAGE = ["app", "(app)", "pipeline", "page.tsx"] as const;

describe("the board's drop settles every answer inside its transition", () => {
  const src = code(...BOARD);
  const transition = blockAfter(src, /startTransition\(async \(\) => \{/);

  it("the action is called once, and only inside the transition's try", () => {
    expect(transition, "no startTransition(async () => { … }) block found").not.toBe("");
    // the import, and the one call — a second, unguarded call would bypass all of this
    expect(src.match(/moveDealToStage\(/g) ?? []).toHaveLength(1);
    const tryBody = blockAfter(transition, /\btry \{/);
    expect(tryBody).toMatch(/await moveDealToStage\(dealId, stageId\)/);
    // a rejection is caught HERE — React 19 would rethrow it to app/(app)/error.tsx
    expect(transition).toMatch(/\btry \{[\s\S]*?await moveDealToStage\([\s\S]*?\}\s*catch\s*\(\s*thrown\s*\)\s*\{/);
  });

  it("both an answer and a rejection go to settleMove, and the board obeys it", () => {
    expect(transition).toMatch(/\{\s*answer:\s*await moveDealToStage\(dealId, stageId\)\s*\}/);
    expect(blockAfter(transition, /catch\s*\(\s*thrown\s*\)\s*\{/)).toMatch(/\{\s*thrown\s*\}/);
    expect(transition).toMatch(/const outcome = settleMove\(attempt\)/);
    expect(transition).toMatch(/if \(outcome\.toast\) toast\.error\(outcome\.toast,\s*outcome\.sticky \? UNTIL_DISMISSED : undefined\)/);
  });

  it("the refresh runs INSIDE the transition, after the answer — on a refusal and on a throw alike", () => {
    // in the transition, so the optimistic revert and the fresh props land together
    expect(transition).toMatch(/if \(outcome\.refresh\) router\.refresh\(\)/);
    const settled = transition.indexOf("settleMove(attempt)");
    const refreshed = transition.indexOf("router.refresh()");
    expect(settled).toBeGreaterThan(-1);
    expect(refreshed).toBeGreaterThan(settled);
    // and nowhere else: a refresh outside the transition would land on its own
    expect(src.match(/router\.refresh\(\)/g) ?? []).toHaveLength(1);
  });

  it("a lost request is reported to Sentry, tagged lost_request, the way the upload forms do (#158)", () => {
    expect(transition).toMatch(/if \(outcome\.report\) reportRejection\(reportLostMove, outcome\.report\.error\)/);
    expect(src).toMatch(
      /const reportLostMove = \(error: unknown\) =>\s*Sentry\.captureException\(error, \{ tags: \{ lost_request: "pipeline_move" \} \}\)/,
    );
  });
});

describe("a role deals_update never admits cannot pick a card up", () => {
  it("the page derives the gate from the signed-in profile's role and hands it to the board", () => {
    const src = code(...PAGE);
    expect(src).toMatch(/getCurrentProfile\(supabase\)/);
    expect(src).toMatch(/const canMove = mayMoveDeals\(profile\.role\)/);
    expect(src).toMatch(/<KanbanBoard\b[^>]*\bcanMove=\{canMove\}/);
  });

  const stages = [
    { id: "s-1", name: "Qualified", sort_order: 1, is_won: false, is_lost: false },
    { id: "s-2", name: "Viewing", sort_order: 2, is_won: false, is_lost: false },
  ];
  const deals = [
    {
      id: "d-1",
      title: "Villa in Peyia",
      stage_id: "s-1",
      displayValue: 450000,
      health_score: 80,
      healthFactors: null,
      agentInitials: "AA",
      status: "open" as const,
      daysInStage: 3,
      propertyRef: "PAF0001",
    },
  ];
  const render = (canMove: boolean) =>
    renderToStaticMarkup(createElement(KanbanBoard, { stages, deals, canMove }))
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");

  it("canMove: the open card is a draggable, and nothing says view only", () => {
    const html = render(true);
    expect(html).toMatch(/aria-roledescription="draggable"/);
    expect(html).not.toContain(MOVE_READ_ONLY_TEXT);
  });

  it("view only: the open card is not draggable, still links to its deal, and the board says why", () => {
    const html = render(false);
    expect(html).not.toMatch(/aria-roledescription="draggable"/);
    expect(html).toContain('href="/deals/d-1"');
    // said on the board, and tied to the stage group for a screen reader
    expect(html).toContain(MOVE_READ_ONLY_TEXT);
    expect(html).toMatch(/<p[^>]*id="kanban-read-only"[^>]*>/);
    expect(html).toMatch(/role="group"[^>]*aria-describedby="kanban-read-only"/);
  });
});
