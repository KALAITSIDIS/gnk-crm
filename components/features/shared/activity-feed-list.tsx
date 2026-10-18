"use client";

import { useMemo, useState } from "react";
import { ACTIVITY_KINDS, type ActivityKind } from "@/lib/services/activity-kinds";
import { cn } from "@/lib/utils";

/**
 * One line of an Activity feed, already rendered on the server: the line and
 * its muted context are translated there (lib/services/events.ts), the kind
 * is computed there (lib/services/activity-kinds.ts). Nothing here reads a
 * payload — the browser gets text, never the event.
 */
export interface ActivityFeedItem {
  id: string;
  /** the event's instant, for <time dateTime> */
  at: string;
  /** the instant formatted for Cyprus */
  when: string;
  line: string;
  context: string | null;
  kind: ActivityKind;
  /** "Lead", "Deal", … when the event is on another record than the page's own */
  source: string | null;
  /** the author's name, "System", or null when the profile is not readable */
  actor: string | null;
  /** a chat-link click — shown muted, with a note under the list that it is not a logged contact */
  linkClick: boolean;
}

export type ActivityFilter = "all" | ActivityKind;

export interface ActivityFeedLabels {
  /** the filter group's accessible name */
  group: string;
  filters: Record<ActivityFilter, string>;
  empty: Record<ActivityFilter, string>;
  linkClickHint: string;
}

/**
 * The filterable list (A06). LOCAL STATE, NO URL PARAMETER: the filter is a
 * way of reading this page, not a place to link to, and the property page
 * already owns `?tab=` — a second parameter on the same page would be a second
 * thing for the router to reconcile on every navigation.
 *
 * A segmented control of real buttons with `aria-pressed` inside a named
 * group, so a screen reader hears "Communication, toggle button, pressed" and
 * the keyboard reaches each one with Tab. Each filter says its own empty
 * text: "No viewing activity yet" is a fact about viewings, not about the
 * record.
 */
export function ActivityFeedList({ items, labels }: { items: ActivityFeedItem[]; labels: ActivityFeedLabels }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");

  const counts = useMemo(() => {
    const c = { all: items.length } as Record<ActivityFilter, number>;
    for (const k of ACTIVITY_KINDS) c[k] = 0;
    for (const i of items) c[i.kind] += 1;
    return c;
  }, [items]);

  const shown = filter === "all" ? items : items.filter((i) => i.kind === filter);
  const options: ActivityFilter[] = ["all", ...ACTIVITY_KINDS];

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={labels.group} className="flex flex-wrap gap-1">
        {options.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              filter === f
                ? "border-brand-100 bg-brand-100 text-brand-700"
                : "border-border text-text-2 hover:text-text-1",
            )}
          >
            {labels.filters[f]} <span className="tabular-nums opacity-70">{counts[f]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-text-3">{labels.empty[filter]}</p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((e) => (
            <li
              key={e.id}
              className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
            >
              <span className={cn("min-w-0 break-words", e.linkClick ? "text-text-2" : "text-text-1")}>
                {e.source ? (
                  <span className="mr-2 inline-block rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-2">
                    {e.source}
                  </span>
                ) : null}
                {e.line}
                {e.context ? <span className="ml-2 text-xs font-normal text-text-3">({e.context})</span> : null}
              </span>
              <span className="shrink-0 text-xs text-text-3">
                {e.actor ? <span>{e.actor} · </span> : null}
                <time dateTime={e.at}>{e.when}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
      {shown.some((e) => e.linkClick) ? <p className="text-xs text-text-3">{labels.linkClickHint}</p> : null}
    </div>
  );
}
