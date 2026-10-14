import { describe, expect, it } from "vitest";
import {
  DEAL_MOVER_ROLES,
  MOVE_UNCONFIRMED_TEXT,
  mayMoveDeals,
  settleMove,
} from "@/lib/services/pipeline-move";

/**
 * What the pipeline board does with a drop's answer (T-kanban-drop-settle).
 *
 * The board awaits `moveDealToStage` inside a transition. Before this, a call
 * that REJECTED — a dropped connection, a deploy that no longer knows the
 * action, a platform 5xx — was rethrown into app/(app)/error.tsx, and an
 * answered refusal only toasted: the card snapped back to a column the
 * server may no longer agree with and stayed draggable until a reload. The
 * board now asks this one pure function what to say, whether to keep it on
 * screen, whether to re-read its props, and whether a lost request goes to
 * Sentry — and does exactly that (pinned in tests/unit/kanban-drop-guard.test.ts).
 */
describe("settleMove", () => {
  it("a move that landed: nothing to say, no refresh (the action revalidated the board), nothing to report", () => {
    expect(settleMove({ answer: { error: null } })).toEqual({
      kind: "moved",
      toast: null,
      sticky: false,
      refresh: false,
      report: null,
    });
  });

  it("an answered refusal: the action's own words, and the board re-read — it may be the board that is stale", () => {
    // "Deal is already won — closed deals do not move stages": the card's
    // column is stale, and only fresh props put it where it really is
    const words = "Deal is already won — closed deals do not move stages";
    expect(settleMove({ answer: { error: words } })).toEqual({
      kind: "refused",
      toast: words,
      sticky: false,
      refresh: true,
      report: null,
    });
  });

  it("the server's own 'could not confirm' (flagged unconfirmed): kept until dismissed, re-read, not reported", () => {
    // the server answered, so there is no lost request to report — but it
    // cannot say whether the move committed, so the words stay on screen
    expect(settleMove({ answer: { error: "SERVER-UNKNOWN", unconfirmed: true } })).toEqual({
      kind: "unconfirmed",
      toast: "SERVER-UNKNOWN",
      sticky: true,
      refresh: true,
      report: null,
    });
  });

  it("a call that rejected: an UNKNOWN outcome — never 'nothing changed' — re-read, and reported as a lost request", () => {
    const lost = new Error("An unexpected response was received from the server.");
    const outcome = settleMove({ thrown: lost });
    expect(outcome).toEqual({
      kind: "unconfirmed",
      toast: MOVE_UNCONFIRMED_TEXT,
      sticky: true,
      refresh: true,
      report: { error: lost },
    });
    // the move may have committed before the answer was lost
    expect(MOVE_UNCONFIRMED_TEXT).toMatch(/could not confirm/i);
    expect(MOVE_UNCONFIRMED_TEXT).toMatch(/may have been saved/i);
    expect(MOVE_UNCONFIRMED_TEXT).not.toMatch(/nothing (was )?changed|not (been )?(saved|moved)/i);
  });

  it("whatever was thrown is what is reported — a non-Error rejection included", () => {
    expect(settleMove({ thrown: "boom" }).report).toEqual({ error: "boom" });
    expect(settleMove({ thrown: undefined }).report).toEqual({ error: undefined });
  });

  it("an answer that claims neither a move nor a refusal is not a success the user should trust", () => {
    // a deploy whose action answers in another shape, or a blank refusal
    for (const answer of [undefined, null, {}, { error: "" }, { error: 42 }, "ok"] as unknown[]) {
      const outcome = settleMove({ answer } as Parameters<typeof settleMove>[0]);
      expect(outcome.kind, JSON.stringify(answer)).toBe("unconfirmed");
      expect(outcome.toast).toBe(MOVE_UNCONFIRMED_TEXT);
      expect(outcome.refresh).toBe(true);
      expect(outcome.sticky).toBe(true);
      // answered, not lost: nothing for Sentry
      expect(outcome.report).toBeNull();
    }
  });

  it("only an explicit `unconfirmed: true` makes an answered error sticky", () => {
    expect(settleMove({ answer: { error: "x", unconfirmed: false } }).kind).toBe("refused");
  });
});

/**
 * Who may drag a card at all — by ROLE, from the one policy that decides it:
 * `deals_update` (0100) admits an admin of the organisation and an agent on a
 * deal they hold or created. A listing manager SELECTs every deal of the
 * organisation (`deals_select`, 0032) and may update none, so every drag of
 * theirs showed the move and reverted. Per-deal ownership is NOT copied here:
 * an agent's `deals_select` and `deals_update` arms are the same rows, and a
 * copy of RLS would drift; the server's refusal stays the truth for the rest.
 */
describe("mayMoveDeals", () => {
  it("admits exactly the roles deals_update has an arm for", () => {
    expect([...DEAL_MOVER_ROLES].sort()).toEqual(["admin", "agent"]);
    expect(mayMoveDeals("admin")).toBe(true);
    expect(mayMoveDeals("agent")).toBe(true);
  });

  it("refuses every role deals_update never admits", () => {
    for (const role of ["listing_manager", "owner_portal", "developer_portal", "partner_portal"] as const) {
      expect(mayMoveDeals(role), role).toBe(false);
    }
  });
});
