import { getTranslations } from "next-intl/server";
import { describeEvent, type EventTranslator, type TimelineEvent } from "@/lib/services/events";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Org-scoped activity feed (T3.5). Server component — the parent fetches the
 * rows; lines come from the event_type registry in lib/services/events.ts,
 * translated into the request locale. `emptyText` is already-localized text
 * supplied by the caller.
 *
 * THE ROWS ARE NOT RLS-SCOPED, and this used to say they were. Timelines are
 * read through `lib/services/entity-timeline.ts`, which runs as the system
 * because `events_select` shows a non-admin only the rows they authored —
 * on the caller's client this component rendered "what I did to this record"
 * under the heading "what happened to it". The reader carries the org filter
 * and the document-title redaction that RLS would otherwise have applied; if
 * you add a caller, read its notes first.
 */
export async function EventTimeline({
  events,
  emptyText,
}: {
  events: TimelineEvent[];
  emptyText?: string;
}) {
  const tEvents = await getTranslations("events");
  const t = ((key, values) => tEvents(key as never, values as never)) as EventTranslator;
  if (events.length === 0) {
    return <p className="text-sm text-text-3">{emptyText ?? t("noActivity")}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {events.map((e) => (
        <li key={e.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
          <span className="text-text-1">
            {describeEvent(e, t)}
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
