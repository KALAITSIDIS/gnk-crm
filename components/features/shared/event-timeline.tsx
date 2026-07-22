import { getTranslations } from "next-intl/server";
import { describeEvent, type EventTranslator, type TimelineEvent } from "@/lib/services/events";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Org-scoped activity feed (T3.5). Server component — the parent fetches the
 * rows (RLS scopes them); lines come from the event_type registry in
 * lib/services/events.ts, translated into the request locale. `emptyText`
 * is already-localized text supplied by the caller.
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
