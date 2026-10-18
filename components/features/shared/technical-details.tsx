import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one place a screen keeps the system's own words (A08, review
 * 2026-10-18): result codes, job names, attempt counters, an error's raw
 * message. The business sentence comes first, on the screen; this native
 * <details> holds the rest for whoever chases it — closed by default, opened
 * by keyboard or tap, no JavaScript, so it works the same in a server
 * component, a client chip and an error boundary.
 *
 * Plain markup, no hooks: it renders wherever it is imported. Not inside a
 * <p> — a <details> there is invalid HTML and the parser would split the
 * paragraph.
 */
export function TechnicalDetails({
  children,
  summary = "Technical details",
  className,
  testId,
}: {
  children: ReactNode;
  summary?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <details data-testid={testId} className={cn("min-w-0 text-xs text-text-3", className)}>
      <summary className="cursor-pointer select-none hover:text-text-2">{summary}</summary>
      <div className="mt-1 break-words font-mono text-[11px] leading-relaxed text-text-2">{children}</div>
    </details>
  );
}
