"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { HealthFactor } from "@/lib/services/health-score";
import { cn } from "@/lib/utils";

/**
 * HealthDot (doc 06): ≥70 green, 40–69 amber, <40 red; tooltip shows the
 * factor breakdown its reader passes — liveHealth's (A09): an open deal's
 * activity re-scored at the request, every other factor from the deal's
 * stored snapshot (health.factors) — and `note`, the line that says when that
 * snapshot was assessed (healthAssessedLine).
 *
 * The activity factor also shows its detail ("20d since last activity"): it
 * is the one that changes with nothing but the clock, so its points alone do
 * not say why. The others are categorical and their points say it.
 */
export function HealthDot({
  score,
  factors,
  note,
  className,
}: {
  score: number;
  factors?: HealthFactor[] | null;
  note?: string | null;
  className?: string;
}) {
  const tone = score >= 70 ? "bg-success" : score >= 40 ? "bg-warning" : "bg-danger";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-label={`Health ${score}/100`}
            className={cn("inline-block size-2 shrink-0 rounded-full", tone, className)}
          />
        </TooltipTrigger>
        <TooltipContent>
          <div className="flex flex-col gap-0.5 py-0.5">
            <span className="font-semibold">Health {score}/100</span>
            {factors && factors.length > 0 ? (
              factors.map((f) => (
                <span key={f.key} className="flex items-baseline justify-between gap-3">
                  <span>
                    {f.label}
                    {f.key === "activity" ? (
                      <span className="opacity-75"> · {f.detail}</span>
                    ) : null}
                  </span>
                  <span className="tabular-nums">
                    {f.points}/{f.max}
                  </span>
                </span>
              ))
            ) : (
              <span>Breakdown appears after the next update.</span>
            )}
            {note ? <span className="mt-1 opacity-75">{note}</span> : null}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
