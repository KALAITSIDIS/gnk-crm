"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  PUBLISH_THRESHOLD,
  type QualityScoreItem,
  type QualityScoreWarning,
} from "@/lib/services/quality-score";
import { cn } from "@/lib/utils";

/**
 * QualityScoreRing (doc 06): 40px ring; <50 danger, 50–69 warning, ≥70
 * (PUBLISH_THRESHOLD) success; tooltip lists the missing items from the score
 * service.
 *
 * F03: the trigger is a BUTTON. It was a div, which takes no focus, so the
 * tooltip — at the time the only account of what was missing — opened for a
 * mouse and for nobody else. A button is reached by Tab, opens the tooltip on
 * focus, and its aria-label says the score and how much is missing. The same
 * facts are also in visible text on the property page (ListingReadiness), so
 * a touch screen, which never hovers, is not left without them.
 */
export function QualityScoreRing({
  score,
  missing,
  warnings = [],
  size = 40,
}: {
  score: number;
  missing: Pick<QualityScoreItem, "key" | "label" | "points">[];
  /** 0088: things to know that move no points (a shared photograph) */
  warnings?: Pick<QualityScoreWarning, "key" | "label">[];
  size?: number;
}) {
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  const tone =
    score >= PUBLISH_THRESHOLD ? "text-success" : score >= 50 ? "text-warning" : "text-danger";
  const label = [
    `Quality score ${score} of 100`,
    missing.length === 0
      ? "all criteria met"
      : `${missing.length} ${missing.length === 1 ? "criterion" : "criteria"} missing`,
    ...(warnings.length > 0
      ? [`${warnings.length} data ${warnings.length === 1 ? "warning" : "warnings"}`]
      : []),
  ].join(", ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="relative inline-flex shrink-0 cursor-default items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          style={{ width: size, height: size }}
          aria-label={label}
        >
          <svg width={size} height={size} className="-rotate-90" aria-hidden>
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
          <span className={cn("absolute text-[11px] font-semibold tabular-nums", tone)} aria-hidden>
            {score}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        {warnings.length > 0 ? (
          <ul className="mb-2 space-y-0.5 text-warning">
            {warnings.map((w) => (
              <li key={w.key}>{w.label}</li>
            ))}
          </ul>
        ) : null}
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
