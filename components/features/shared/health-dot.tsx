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
 * factor breakdown from the deal's stored snapshot (health.factors).
 */
export function HealthDot({
  score,
  factors,
  className,
}: {
  score: number;
  factors?: HealthFactor[] | null;
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
                  <span>{f.label}</span>
                  <span className="tabular-nums">
                    {f.points}/{f.max}
                  </span>
                </span>
              ))
            ) : (
              <span>Breakdown appears after the next update.</span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
