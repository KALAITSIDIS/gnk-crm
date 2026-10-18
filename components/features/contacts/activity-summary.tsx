import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { nextTaskLabel, type ContactActivitySummary, type LastEvent } from "@/lib/services/contact-activity-summary";
import { channelLabel, describeEvent, type EventTranslator } from "@/lib/services/events";
import { formatDate, formatDateTime } from "@/lib/utils/format";

/**
 * Last logged contact · Last chat opened · Next step — the strip under a
 * contact's name (A06). Read by lib/services/contact-activity-summary.ts; this
 * only renders it.
 *
 * The two "last" lines are kept apart on purpose. A WhatsApp button opens the
 * app and nothing more is known — no message, no reply — so a click is never
 * shown as contact: "Last logged contact" counts only a logged conversation, a
 * call or a "contacted" stamp, and the click has its own line that says it is
 * not one. A part whose read failed says so; it never reads as "none".
 *
 * The next task says whose it is: "Your task" only when it is assigned to the
 * viewer. A non-admin also reads the tasks they set a colleague (tasks_select
 * admits the creator), and those read "Task for <name>".
 *
 * The contact page's chrome is English by convention (only the timeline's
 * lines are translated), so the labels are here and the lines come from
 * `events.*`.
 */
export async function ContactActivityStrip({
  summary,
  actorNames,
  viewerId,
  viewerIsAdmin,
  canAddTask,
  now,
}: {
  summary: ContactActivitySummary;
  /** profile id → name, from the page's own profiles read */
  actorNames: ReadonlyMap<string, string>;
  /** the viewer's profile id — "Your task" only for a task assigned to them */
  viewerId: string;
  viewerIsAdmin: boolean;
  /** the header shows Add task (not archived, not erased) */
  canAddTask: boolean;
  now: Date;
}) {
  const tEvents = await getTranslations("events");
  const t = ((key, values) => tEvents(key as never, values as never)) as EventTranslator;

  const byline = (e: LastEvent): string =>
    [
      e.actor_id ? (actorNames.get(e.actor_id) ?? null) : t("system"),
      e.entity_type === "lead" ? "on a lead" : e.entity_type === "deal" ? "on a deal" : null,
    ]
      .filter(Boolean)
      .map((s) => ` · ${s}`)
      .join("");
  const unavailable = <span className="text-warning">Could not load — refresh to try again</span>;

  const { lastContact, lastChatOpened, nextTask, nextViewing } = summary;
  const overdue = (iso: string | null) => Boolean(iso && new Date(iso).getTime() < now.getTime());

  return (
    <dl
      aria-label="Contact summary"
      className="mt-3 grid gap-x-6 gap-y-3 rounded-[8px] border border-border bg-surface px-4 py-3 text-sm sm:grid-cols-3"
    >
      <div className="min-w-0">
        <dt className="text-xs text-text-3">Last logged contact</dt>
        <dd className="break-words text-text-1">
          {!lastContact.ok ? (
            unavailable
          ) : lastContact.value ? (
            <>
              {describeEvent(lastContact.value, t)}
              <span className="block text-xs text-text-3">
                <time dateTime={lastContact.value.occurred_at}>{formatDateTime(lastContact.value.occurred_at)}</time>
                {byline(lastContact.value)}
              </span>
            </>
          ) : (
            <span className="text-text-3">None logged yet</span>
          )}
        </dd>
      </div>

      <div className="min-w-0">
        <dt className="text-xs text-text-3">Last chat opened</dt>
        <dd className="break-words text-text-1">
          {!lastChatOpened.ok ? (
            unavailable
          ) : lastChatOpened.value ? (
            <>
              {channelOf(lastChatOpened.value, t) ?? "Chat"} ·{" "}
              <time dateTime={lastChatOpened.value.occurred_at}>{formatDateTime(lastChatOpened.value.occurred_at)}</time>
              <span className="block text-xs text-text-3">
                Link click only — not a logged contact{byline(lastChatOpened.value)}
              </span>
            </>
          ) : (
            <span className="text-text-3">None</span>
          )}
        </dd>
      </div>

      <div className="min-w-0">
        <dt className="text-xs text-text-3">Next step</dt>
        <dd className="flex flex-col gap-1 break-words text-text-1">
          {!nextTask.ok ? (
            unavailable
          ) : nextTask.value ? (
            <span>
              <Link href="/tasks" className="text-brand-700 hover:underline">
                {nextTaskLabel(nextTask.value, viewerId, actorNames)}: {nextTask.value.title}
              </Link>
              <span className={`block text-xs ${overdue(nextTask.value.due_at) ? "text-danger" : "text-text-3"}`}>
                {nextTask.value.due_at
                  ? `${overdue(nextTask.value.due_at) ? "Overdue — was due" : "Due"} ${formatDate(nextTask.value.due_at)}`
                  : "No due date"}
              </span>
            </span>
          ) : null}
          {!nextViewing.ok ? (
            // one "could not load" is enough when both reads failed
            nextTask.ok ? unavailable : null
          ) : nextViewing.value ? (
            <span>
              <Link href={`/viewings/${nextViewing.value.id}`} className="text-brand-700 hover:underline">
                Viewing {formatDateTime(nextViewing.value.scheduled_at)}
              </Link>
              {nextViewing.value.reference ? (
                <span className="ml-1 font-mono text-xs text-text-2">{nextViewing.value.reference}</span>
              ) : null}
            </span>
          ) : null}
          {nextTask.ok && nextViewing.ok && !nextTask.value && !nextViewing.value ? (
            <span className="text-text-3">
              {/* a non-admin reads only the tasks they hold or set */}
              {viewerIsAdmin ? "Nothing scheduled" : "Nothing scheduled by or for you"}
              {canAddTask ? " — use Add task above" : ""}
            </span>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

function channelOf(e: LastEvent, t: EventTranslator): string | null {
  const p = e.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  return channelLabel((p as Record<string, unknown>).channel, t);
}
