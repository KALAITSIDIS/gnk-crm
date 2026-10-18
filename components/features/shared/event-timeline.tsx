import { getTranslations } from "next-intl/server";
import {
  ActivityFeedList,
  type ActivityFeedItem,
  type ActivityFeedLabels,
} from "@/components/features/shared/activity-feed-list";
import { activityKind } from "@/lib/services/activity-kinds";
import {
  describeEvent,
  describeEventContext,
  type EventTranslator,
  type TimelineEvent,
} from "@/lib/services/events";
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
 *
 * The muted annotation is the source row's CURRENT title, or a viewing's
 * CURRENT feedback, labelled as such (lib/services/event-context.ts reads it
 * with the viewer's permissions), and then the caller's note.
 *
 * This plain list is the admin dashboard's "Latest events" (unfiltered, the
 * author already in its note) and the deal and property Activity tabs until
 * they adopt `ActivityFeed` below.
 */
export async function EventTimeline({
  events,
  emptyText,
}: {
  events: TimelineEvent[];
  emptyText?: string;
}) {
  const t = await eventsTranslator();
  if (events.length === 0) {
    return <p className="text-sm text-text-3">{emptyText ?? t("noActivity")}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {events.map((e) => {
        const context = describeEventContext(e, t);
        return (
          <li key={e.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
            <span className="text-text-1">
              {describeEvent(e, t)}
              {context ? (
                <span className="ml-2 text-xs font-normal text-text-3">({context})</span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-text-3">{formatDateTime(e.occurred_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}

async function eventsTranslator(): Promise<EventTranslator> {
  const tEvents = await getTranslations("events");
  return ((key, values) => tEvents(key as never, values as never)) as EventTranslator;
}

/** A row of a combined feed (`readEntityTimelines`). */
export type ActivityFeedRow = TimelineEvent & {
  entity_id?: string | null;
  /** null = the system wrote it; undefined = the reader did not say */
  actor_id?: string | null;
  actor_name?: string | null;
};

/**
 * The chip naming the record an event is on, when that is not the page's own
 * record — "Lead" on a contact's call logged from the inbox. An offer has none:
 * its line already starts "Offer:" (ENTITY_PREFIX_KEY in events.ts).
 */
function sourceLabel(entityType: string, pageEntityType: string, t: EventTranslator): string | null {
  if (entityType === pageEntityType) return null;
  switch (entityType) {
    case "contact":
      return t("sourceContact");
    case "lead":
      return t("sourceLead");
    case "deal":
      return t("sourceDeal");
    case "viewing":
      return t("sourceViewing");
    case "property":
      return t("sourceProperty");
    case "key":
      return t("sourceKey");
    default:
      return null;
  }
}

/**
 * A record's Activity tab (A06): its events and its related records' events
 * as one feed, each line with the record it came from, its author and a kind
 * the reader can filter on — All · Communication · Viewings · Deals · Changes
 * · System.
 *
 * Everything is rendered HERE, on the server: the line, its context, the kind,
 * the author. The client list (activity-feed-list.tsx) receives text and
 * filters it; no payload crosses to the browser.
 *
 * `timeline` is what `readEntityTimelines` returns. A source whose read failed
 * is SAID ("Part of this history could not be loaded") rather than rendered as
 * a shorter history, and a feed cut at its cap says so too.
 *
 * Adopting it on another page (deal, property) is the reader call with that
 * page's sources and this component with that page's own entity type.
 */
export async function ActivityFeed({
  timeline,
  pageEntityType,
  emptyText,
}: {
  timeline: { rows: ActivityFeedRow[]; incomplete: boolean; truncated: boolean };
  /** the page's own record type — rows on any other record get a source chip */
  pageEntityType: string;
  emptyText?: string;
}) {
  const t = await eventsTranslator();
  const items: ActivityFeedItem[] = timeline.rows.map((e) => ({
    id: String(e.id),
    at: e.occurred_at,
    when: formatDateTime(e.occurred_at),
    line: describeEvent(e, t),
    context: describeEventContext(e, t),
    kind: activityKind({
      entity_type: e.entity_type,
      event_type: e.event_type,
      actor_id: e.actor_id,
      payload: e.payload,
    }),
    source: sourceLabel(e.entity_type, pageEntityType, t),
    // null is the system; a person whose profile could not be read stays unnamed, never "System"
    actor: e.actor_id === null ? t("system") : (e.actor_name ?? null),
    linkClick: e.event_type === "chat_link_opened",
  }));

  const labels: ActivityFeedLabels = {
    group: t("feedFilter"),
    filters: {
      all: t("feedAll"),
      communication: t("feedCommunication"),
      viewings: t("feedViewings"),
      deals: t("feedDeals"),
      changes: t("feedChanges"),
      system: t("feedSystem"),
    },
    empty: {
      all: emptyText ?? t("noActivity"),
      communication: t("feedEmptyCommunication"),
      viewings: t("feedEmptyViewings"),
      deals: t("feedEmptyDeals"),
      changes: t("feedEmptyChanges"),
      system: t("feedEmptySystem"),
    },
    linkClickHint: t("feedLinkClickHint"),
  };

  return (
    <div className="flex flex-col gap-3">
      {timeline.incomplete ? (
        <p role="status" className="rounded-[8px] border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-1">
          {t("feedIncomplete")}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm text-text-3">{labels.empty.all}</p>
      ) : (
        <ActivityFeedList items={items} labels={labels} />
      )}
      {timeline.truncated && items.length > 0 ? (
        <p className="text-xs text-text-3">{t("feedTruncated", { count: items.length })}</p>
      ) : null}
    </div>
  );
}
