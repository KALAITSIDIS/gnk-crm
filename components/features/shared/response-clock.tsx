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
}: {
  receivedAt: string;
  firstResponseAt: string | null;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (firstResponseAt) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [firstResponseAt]);

  const state = clockState(receivedAt, firstResponseAt, now);
  const label = state === "answered" ? "answered" : elapsedLabel(receivedAt, now);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        STYLES[state],
      )}
    >
      {label}
    </span>
  );
}
