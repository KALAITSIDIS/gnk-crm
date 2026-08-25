import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { fixLocation, type Worklist } from "@/lib/services/quality-worklist";
import { PUBLISH_THRESHOLD } from "@/lib/services/quality-score";
import { cn } from "@/lib/utils";

/**
 * The quality-score worklist.
 *
 * Server component — everything shown is derived, nothing is interactive.
 *
 * Ordered by POINTS RECOVERABLE rather than by how common a gap is, because the
 * question is "where does an afternoon buy the most", not "what is most
 * frequent". The count is shown beside it so the reader can disagree.
 */

/** At most this many references inline before the row just states the rest. */
const SHOWN_PER_CATEGORY = 12;

function ScorePill({ score }: { score: number }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
        score >= PUBLISH_THRESHOLD
          ? "bg-success/10 text-success"
          : score >= 40
            ? "bg-warning/10 text-warning"
            : "bg-danger/10 text-danger",
      )}
    >
      {score}
    </span>
  );
}

export function QualityWorklist({ worklist }: { worklist: Worklist }) {
  const w = worklist;

  if (w.total === 0) {
    return (
      <section className="rounded-[10px] border border-border bg-surface p-5">
        <p className="text-sm text-text-2">
          No live listings to check. Draft, available, reserved and under-offer properties appear
          here; sold, rented, withdrawn and archived ones do not.
        </p>
      </section>
    );
  }

  if (w.categories.length === 0) {
    return (
      <section className="flex items-start gap-2 rounded-[10px] border border-success/30 bg-success/5 p-5">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
        <p className="text-sm text-text-2">
          All {w.total} live {w.total === 1 ? "listing scores" : "listings score"} full marks.
          Nothing to chase.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-4 rounded-[10px] border border-border bg-surface p-5 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-text-3">Live listings</span>
          <span className="text-xl font-semibold tabular-nums text-text-1">{w.total}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-text-3">Complete</span>
          <span className="text-xl font-semibold tabular-nums text-success">{w.complete}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-text-3">Average score</span>
          <span className="text-xl font-semibold tabular-nums text-text-1">
            {w.averageScore ?? "—"}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-text-3">Points to recover</span>
          <span className="text-xl font-semibold tabular-nums text-text-1">{w.recoverable}</span>
        </div>
      </section>

      <div className="flex flex-col gap-3">
        {w.categories.map((c) => {
          const tab = fixLocation(c.key);
          const shown = c.properties.slice(0, SHOWN_PER_CATEGORY);
          const rest = c.properties.length - shown.length;
          return (
            <section key={c.key} className="rounded-[10px] border border-border bg-surface p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-text-1">
                  {c.count} {c.count === 1 ? "listing is" : "listings are"} missing:{" "}
                  <span className="font-normal text-text-2">{c.label}</span>
                </h2>
                <span className="text-xs tabular-nums text-text-3">
                  {c.points} points each · {c.recoverable} recoverable
                </span>
              </div>

              {/* Tabs are Radix state with no href, so a category cannot
                  deep-link. Naming the tab is what turns a count into an
                  instruction. */}
              {tab ? (
                <p className="mt-1 text-xs text-text-3">
                  Fixed on the <span className="font-medium text-text-2">{tab}</span> tab.
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-1.5">
                {shown.map((p) => (
                  <Link
                    key={p.id}
                    href={`/properties/${p.id}`}
                    title={p.title ?? p.reference}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1"
                  >
                    <span className="font-medium">{p.reference}</span>
                    <ScorePill score={p.score} />
                  </Link>
                ))}
                {rest > 0 ? (
                  <span className="self-center text-xs text-text-3">and {rest} more</span>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
