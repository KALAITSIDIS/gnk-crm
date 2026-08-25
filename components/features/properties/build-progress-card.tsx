import { AlertTriangle, HardHat } from "lucide-react";
import {
  CONSTRUCTION_MILESTONES,
  buildProgress,
  hasBuildInfo,
} from "@/lib/services/construction";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Where the build has got to, and when it hands over.
 *
 * Server component — everything is derived, nothing interactive.
 *
 * THE BAR IS LABELLED AS A SEQUENCE, NOT A MEASUREMENT. The weighting behind it
 * is a defensible ordering of milestones, not a quantity surveyor's report, and
 * the caption says so. A percentage on a screen reads as measured unless it is
 * told not to.
 *
 * A status the standard list does not contain still SHOWS — `construction_status`
 * is free text and finding 10 deliberately preserves whatever a row holds — but
 * it gets no bar and no position, because inventing one would undo exactly that.
 */

function timeToDelivery(months: number): string {
  if (months === 0) return "this month";
  const n = Math.abs(months);
  const unit =
    n >= 12
      ? `${Math.floor(n / 12)} year${Math.floor(n / 12) === 1 ? "" : "s"}${n % 12 ? ` ${n % 12}m` : ""}`
      : `${n} month${n === 1 ? "" : "s"}`;
  return months > 0 ? `in ${unit}` : `${unit} ago`;
}

export function BuildProgressCard({
  constructionStatus,
  deliveryDate,
}: {
  constructionStatus: string | null;
  deliveryDate: string | null;
}) {
  const b = buildProgress(constructionStatus, deliveryDate);
  if (!hasBuildInfo(b)) return null;

  return (
    <section className="rounded-[10px] border border-border bg-surface p-5">
      <div className="flex items-center gap-1.5">
        <HardHat className="size-3.5 text-text-3" />
        <h2 className="text-sm font-semibold text-text-1">Build &amp; handover</h2>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <span className="text-lg font-semibold text-text-1">{b.label ?? "—"}</span>
        {b.stage !== null ? (
          <span className="text-xs tabular-nums text-text-3">
            stage {b.stage} of {b.totalStages}
          </span>
        ) : b.status !== null ? (
          <span className="text-xs text-text-3">not a standard stage</span>
        ) : null}
      </div>

      {b.pct !== null ? (
        <>
          <div
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-border"
            role="img"
            aria-label={`${b.label}: stage ${b.stage} of ${b.totalStages}`}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width]",
                b.pct === 100 ? "bg-success" : "bg-brand-500",
              )}
              style={{ width: `${Math.max(b.pct, 2)}%` }}
            />
          </div>
          {/* Say what the bar is, so nobody quotes it to a buyer as measured. */}
          <p className="mt-1.5 text-xs text-text-3">
            Position along the eight build stages — the paperwork stages sit low on purpose. Not a
            surveyed percentage.
          </p>
        </>
      ) : null}

      {b.deliveryDate !== null ? (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-2 border-t border-border/60 pt-3">
          <span className="text-xs uppercase tracking-wide text-text-3">Expected delivery</span>
          <span className="text-sm font-medium text-text-1">{formatDate(b.deliveryDate)}</span>
          {b.monthsToDelivery !== null ? (
            <span
              className={cn(
                "text-sm tabular-nums",
                b.overdue ? "font-medium text-danger" : "text-text-2",
              )}
            >
              {timeToDelivery(b.monthsToDelivery)}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Worth a look, never an error: handing over early is legitimate. */}
      {b.mismatch ? (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>{b.mismatch}</span>
        </p>
      ) : null}

      {b.status === null ? (
        <p className="mt-3 text-xs text-text-3">
          No build stage recorded — set it on the Details tab so the bar and the handover
          countdown agree with each other.
        </p>
      ) : null}
    </section>
  );
}

/** The milestone list, exported for anywhere that wants to show the whole path. */
export const BUILD_STAGES = CONSTRUCTION_MILESTONES;
