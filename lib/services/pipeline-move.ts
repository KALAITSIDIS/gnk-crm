/**
 * The pipeline board's drop, decided (T-kanban-drop-settle).
 *
 * The board (components/features/pipeline/kanban.tsx) moves a card with
 * `useOptimistic` and awaits `moveDealToStage` inside a transition. Two gaps
 * sat around that await (BACKLOG "External audit — 2026-10-14"):
 *
 * - A CALL THAT REJECTED — a dropped connection, a deploy that no longer knows
 *   the action, a platform 5xx or timeout — was rethrown by React 19 into
 *   app/(app)/error.tsx ("Something went wrong.") instead of being said on
 *   the board. The action's own try/catch only covers throws on the server.
 * - AN ANSWERED REFUSAL only toasted. The action refuses before it
 *   revalidates, so the card snapped back to the column the board last knew —
 *   and some refusals mean the BOARD is stale (the deal was closed, reassigned
 *   or deleted elsewhere), so the card stayed draggable until a reload.
 *
 * This module says what to do with each answer; the board does exactly that,
 * and does it inside the same transition, so the optimistic revert and the
 * fresh props land together (the house idiom of
 * components/features/deals/outcome-actions.tsx). Pure of React and of any
 * browser API, so every branch is unit-tested (pipeline-move.test.ts); the
 * board's use of it is pinned by tests/unit/kanban-drop-guard.test.ts.
 *
 * NOT here, on purpose (DECISIONS T-external-audit-2026-10-14, item 5): a
 * snapshot of the board, a deep comparison, or a copy of the stage-transition
 * rules. `useOptimistic` with a pure reducer already reverts to the server's
 * props; what the client cannot know, only fresh server state decides.
 */
import type { Database } from "@/lib/supabase/database.types";

type Role = Database["public"]["Enums"]["user_role"];

/**
 * What `moveDealToStage` answers. `unconfirmed`: it answered, but cannot say
 * whether the move committed (its `error` then says what to check) — shown
 * as an UNKNOWN outcome, kept until dismissed, not as a plain refusal.
 */
export type MoveDealResult = { error: string | null; unconfirmed?: boolean };

/**
 * Said when the outcome is unknown. The move may have committed before the
 * answer was lost, so it never says nothing changed; the board has been
 * re-read by the time it is shown.
 */
export const MOVE_UNCONFIRMED_TEXT =
  "Could not confirm the move — it may have been saved. The board has been reloaded: check the deal's stage before moving it again.";

/** Said on a board the viewer's role may read but not change. */
export const MOVE_READ_ONLY_TEXT =
  "View only — your role can see every deal on the board but cannot move one between stages.";

/** One drop's answer, or what its call threw instead. */
export type MoveAttempt = { answer: MoveDealResult } | { thrown: unknown };

export interface MoveOutcome {
  kind: "moved" | "refused" | "unconfirmed";
  /** what the board says; null for a move that landed */
  toast: string | null;
  /** keep the toast until it is dismissed: the outcome is unknown */
  sticky: boolean;
  /**
   * Re-read the board (router.refresh(), inside the transition). Not after a
   * move that landed: the action revalidated /pipeline, and its answer
   * carried the fresh board.
   */
  refresh: boolean;
  /** a request that never came back: the rejection, for Sentry */
  report: { error: unknown } | null;
}

const lost = (report: MoveOutcome["report"]): MoveOutcome => ({
  kind: "unconfirmed",
  toast: MOVE_UNCONFIRMED_TEXT,
  sticky: true,
  refresh: true,
  report,
});

/** What the board does with one drop's answer. Never throws. */
export function settleMove(attempt: MoveAttempt): MoveOutcome {
  if ("thrown" in attempt) return lost({ error: attempt.thrown });

  const answer: unknown = attempt.answer;
  const error =
    typeof answer === "object" && answer !== null ? (answer as { error?: unknown }).error : undefined;
  if (error === null) {
    return { kind: "moved", toast: null, sticky: false, refresh: false, report: null };
  }
  if (typeof error === "string" && error !== "") {
    // the server's own "could not confirm": an unknown outcome, in its words
    if ((answer as MoveDealResult).unconfirmed === true) {
      return { kind: "unconfirmed", toast: error, sticky: true, refresh: true, report: null };
    }
    return { kind: "refused", toast: error, sticky: false, refresh: true, report: null };
  }
  // an answer that claims neither a move nor a refusal: not a success the
  // user should trust — but it was answered, so there is nothing to report
  return lost(null);
}

/**
 * The roles `deals_update` (0100) has an arm for: an admin of the
 * organisation, and an agent on a deal they hold or created. Every other role
 * may read the board — a listing manager SELECTs every deal of the
 * organisation (`deals_select`, 0032) — and update no deal, so a drag of
 * theirs could only show the move and revert.
 *
 * ROLE only, never a per-deal ownership rule: an agent's `deals_select` and
 * `deals_update` arms admit the same rows, and a client copy of RLS would
 * drift from it. The server's refusal stays the single source of truth for
 * everything else.
 */
export const DEAL_MOVER_ROLES: readonly Role[] = ["admin", "agent"];

export function mayMoveDeals(role: Role): boolean {
  return DEAL_MOVER_ROLES.includes(role);
}
