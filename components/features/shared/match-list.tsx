import Link from "next/link";
import { cn } from "@/lib/utils";
import { describeMatchHit, describeMatchReason } from "@/lib/services/match-reasons";
import type { MatchVerdict } from "@/lib/services/matching";

/**
 * Shared presentation for a scored match, used by both directions (0043).
 *
 * ONE COMPONENT, TWO SIDES. The buyer→property and property→buyer lists differ
 * only in what the title links to; keeping the score, the chips and the
 * truncation notice here is what stops the two drifting into different stories
 * about the same verdict.
 */

/** Bands, not a gradient: a reader should be able to say "that's a strong one". */
function scoreTone(score: number): string {
  if (score >= 80) return "bg-success/10 text-success border-success/30";
  if (score >= 55) return "bg-warning/10 text-warning border-warning/30";
  return "bg-surface-2 text-text-2 border-border";
}

export function ScoreBadge({ score }: { score: number }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums",
        scoreTone(score),
      )}
      // The number alone is meaningless to a screen reader out of context.
      aria-label={`Match score ${score} out of 100`}
    >
      {score}
    </span>
  );
}

function Chip({ text, tone }: { text: string; tone: "miss" | "hit" }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs",
        tone === "miss" ? "bg-danger/8 text-danger" : "bg-success/8 text-success",
      )}
    >
      {text}
    </span>
  );
}

/**
 * The misses, in words. This is the feature — a score with no reasons is a
 * number nobody acts on. Hits are shown only when there is nothing missing,
 * so a perfect match still says WHY it is one rather than going silent.
 */
export function MatchReasons({ verdict }: { verdict: MatchVerdict }) {
  if (verdict.misses.length === 0) {
    const hits = verdict.hits.slice(0, 4);
    if (hits.length === 0) return null;
    return (
      <div className="mt-1.5 flex flex-wrap gap-1">
        {hits.map((h, i) => (
          <Chip key={`${h.code}-${i}`} text={describeMatchHit(h)} tone="hit" />
        ))}
      </div>
    );
  }
  // Cap the chips so one badly-specified search cannot produce a wall of text,
  // and say how many were hidden rather than trimming silently.
  const shown = verdict.misses.slice(0, 5);
  const hidden = verdict.misses.length - shown.length;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {shown.map((m, i) => (
        <Chip key={`${m.code}-${i}`} text={describeMatchReason(m)} tone="miss" />
      ))}
      {hidden > 0 ? <span className="text-xs text-text-3">+{hidden} more</span> : null}
    </div>
  );
}

/**
 * "Showing N of M" plus the cap warning.
 *
 * B1's lesson: a silently truncated list is indistinguishable from a complete
 * one. If the candidate cap was hit, say so — the desk must not read the top 20
 * as "everything that matches".
 */
export function MatchFooter({
  shown,
  considered,
  capped,
}: {
  shown: number;
  considered: number;
  capped: boolean;
}) {
  if (shown === 0) return null;
  return (
    <p className="mt-3 text-xs text-text-3">
      Showing {shown} of {considered} match{considered === 1 ? "" : "es"}
      {capped
        ? " — more listings were available than could be scored at once, so this is not the complete set."
        : "."}
    </p>
  );
}

export function MatchEmpty({ text, href, action }: { text: string; href?: string; action?: string }) {
  return (
    <p className="text-sm text-text-2">
      {text}
      {href && action ? (
        <>
          {" "}
          <Link href={href} className="text-brand-700 underline underline-offset-2">
            {action}
          </Link>
        </>
      ) : null}
    </p>
  );
}
