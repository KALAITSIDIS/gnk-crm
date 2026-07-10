/**
 * Lead Speed Monitor (doc 02 §C4): colour-coded first-response clock.
 * green < 5 min · amber < 60 min · red ≥ 60 min unanswered · grey answered.
 */

export type ClockState = "answered" | "green" | "amber" | "red";

export const GREEN_LIMIT_MS = 5 * 60 * 1000;
export const AMBER_LIMIT_MS = 60 * 60 * 1000;

export function clockState(
  receivedAt: string | Date,
  firstResponseAt: string | Date | null,
  now: Date = new Date(),
): ClockState {
  if (firstResponseAt) return "answered";
  const received = typeof receivedAt === "string" ? new Date(receivedAt) : receivedAt;
  const elapsed = now.getTime() - received.getTime();
  if (elapsed < GREEN_LIMIT_MS) return "green";
  if (elapsed < AMBER_LIMIT_MS) return "amber";
  return "red";
}

/** "3m", "47m", "2h 15m" — elapsed unanswered time for the chip label. */
export function elapsedLabel(receivedAt: string | Date, now: Date = new Date()): string {
  const received = typeof receivedAt === "string" ? new Date(receivedAt) : receivedAt;
  const mins = Math.max(0, Math.floor((now.getTime() - received.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}
