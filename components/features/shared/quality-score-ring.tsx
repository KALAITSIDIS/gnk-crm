"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { QualityScoreItem } from "@/lib/services/quality-score";
import { cn } from "@/lib/utils";

/**
 * QualityScoreRing (doc 06): 40px ring; <50 danger, 50–69 warning, ≥70
 * success; tooltip lists the missing items from the score service.
 */
export function QualityScoreRing({
  score,
  missing,
  size = 40,
}: {
  score: number;
  missing: Pick<QualityScoreItem, "key" | "label" | "points">[];
  size?: number;
}) {
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  const tone = score >= 70 ? "text-success" : score >= 50 ? "text-warning" : "text-danger";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="relative inline-flex shrink-0 items-center justify-center"
          style={{ width: size, height: size }}
          aria-label={`Quality score ${score} of 100`}
        >
          <svg width={size} height={size} className="-rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={4}
              className="stroke-border"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={4}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              className={cn("stroke-current transition-all", tone)}
            />
          </svg>
          <span className={cn("absolute text-[11px] font-semibold tabular-nums", tone)}>
            {score}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        {missing.length === 0 ? (
          <p>All quality criteria met.</p>
        ) : (
          <div>
            <p className="mb-1 font-medium">Missing ({missing.length}):</p>
            <ul className="space-y-0.5">
              {missing.map((m) => (
                <li key={m.key} className="flex justify-between gap-3">
                  <span>{m.label}</span>
                  <span className="tabular-nums text-white/60">+{m.points}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
