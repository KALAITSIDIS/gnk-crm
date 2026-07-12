import { describeEvent, type TimelineEvent } from "@/lib/services/events";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Org-scoped activity feed (T3.5). Pure render — the parent server component
 * fetches the rows (RLS scopes them); lines come from the event_type registry
 * in lib/services/events.ts.
 */
export function EventTimeline({
  events,
  emptyText = "No activity yet.",
}: {
  events: TimelineEvent[];
  emptyText?: string;
}) {
  if (events.length === 0) {
    return <p className="text-sm text-text-3">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {events.map((e) => (
        <li key={e.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
          <span className="text-text-1">
            {describeEvent(e)}
            {e.note ? (
              <span className="ml-2 text-xs font-normal text-text-3">({e.note})</span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs text-text-3">{formatDateTime(e.occurred_at)}</span>
        </li>
      ))}
    </ul>
  );
}
