"use client";

import { useEffect, useState } from "react";
import { clockState, elapsedLabel, type ClockState } from "@/lib/services/response-clock";
import { cn } from "@/lib/utils";

/** ResponseClock (doc 06): green <5m, amber <60m, red ≥60m, grey answered; live. */

const STYLES: Record<ClockState, string> = {
  green: "bg-success/10 text-success",
  amber: "bg-warning/10 text-warning",
  red: "bg-danger/10 text-danger",
  answered: "bg-surface-2 text-text-3",
};

export function ResponseClock({
  receivedAt,
  firstResponseAt,
  active = true,
}: {
  receivedAt: string;
  firstResponseAt: string | null;
  /**
   * False once the lead leaves the inbox (converted/lost/spam): the SLA clock
   * is meaningless then, so it must not keep ticking red forever (audit fix).
   */
  active?: boolean;
}) {
  const running = active && !firstResponseAt;
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [running]);

  if (!firstResponseAt && !active) {
    return (
      <span
        title="Closed without a logged first response"
        className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums text-text-3"
      >
        —
      </span>
    );
  }

  const state = clockState(receivedAt, firstResponseAt, now);
  const label = state === "answered" ? "answered" : elapsedLabel(receivedAt, now);

  // The elapsed label (and, at a minute boundary, the colour) are wall-clock
  // relative: the server renders it at request time and the client re-renders
  // it moments later at hydration, so the two never match exactly. That is the
  // one case React's suppressHydrationWarning is for — the SSR value still
  // paints, hydration accepts the fresher client value, and the 30s interval
  // keeps it live. (Answered clocks are static and unaffected.)
  return (
    <span
      suppressHydrationWarning
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        STYLES[state],
      )}
    >
      {label}
    </span>
  );
}
