import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

/**
 * WHICH task or document an event is about, read back from the record itself.
 *
 * Since T-event-typed-text-shape a task's `completed` / `reopened` event and a
 * document's `document_uploaded` event carry ids, never the title: a title is
 * typed text that names people ("Call Maria about the deposit"), or the
 * uploaded file's name ("passport_AB123456.pdf"), and the hash chain is beyond
 * erasure and correction (audit SEC-03). This attaches the row's CURRENT title
 * as `current_title`, so a timeline can still say which one — on three rules:
 *
 * 1. THE VIEWER'S CLIENT, NEVER THE SYSTEM'S. `documents_select` hides an
 *    admin_only document (a passport scan) from agents and listing managers,
 *    and `tasks_select` hides tasks that are not theirs. Asking as the viewer
 *    lets RLS decide, exactly as it does for the documents tab and the task
 *    list; a row the viewer may not read simply does not come back, and the line
 *    stays neutral. `readEntityTimeline` reads EVENTS as the system — that is
 *    about which events exist, not what the records say — so it must hand this
 *    function the caller's own client, not its admin one.
 * 2. NO FALLBACK TO THE PAYLOAD. An older event's copy of a title is never
 *    consulted, whether its row is gone, hidden or present. A deleted document
 *    has no row, so its line is "Document deleted" and nothing more; it is not
 *    even looked up.
 * 3. CURRENT, AND SAID TO BE. The value is what the row says now, and the
 *    renderer labels it "current title" (`describeEventContext`) rather than
 *    folding it into the line, because a row can change after the event.
 *
 * At most one query per table, whatever the number of events, and none at all
 * when nothing on the page needs one. `org_id` is filtered explicitly on top of
 * RLS, as entity-timeline.ts does, and an id that is not a uuid is never sent —
 * one malformed payload must not fail the lookup for the whole page.
 */

type Client = SupabaseClient<Database>;

export interface ContextEvent {
  entity_type: string;
  entity_id: string | null;
  event_type: string;
  payload: Json;
  current_title?: string | null;
}

/** Event types whose TASK row names them (entity_type 'task'). */
const TASK_EVENTS = new Set(["completed", "reopened"]);

/**
 * Event types whose DOCUMENT row names them, through `payload.document_id`.
 * `document_deleted` is absent on purpose: the row is deleted before the event
 * is written, so there is nothing to read — and nothing to fall back to.
 */
const DOCUMENT_EVENTS = new Set(["document_uploaded"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Source = { table: "tasks" | "documents"; id: string };

function sourceOf(e: ContextEvent): Source | null {
  if (e.entity_type === "task" && TASK_EVENTS.has(e.event_type)) {
    return e.entity_id && UUID.test(e.entity_id) ? { table: "tasks", id: e.entity_id } : null;
  }
  if (DOCUMENT_EVENTS.has(e.event_type)) {
    const p = e.payload;
    const id =
      p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>).document_id : null;
    return typeof id === "string" && UUID.test(id) ? { table: "documents", id } : null;
  }
  return null;
}

async function readTitles(
  viewer: Client,
  table: Source["table"],
  orgId: string,
  ids: Set<string>,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (ids.size === 0) return titles;
  const query =
    table === "tasks"
      ? viewer.from("tasks").select("id, title")
      : viewer.from("documents").select("id, title");
  const { data, error } = await query.eq("org_id", orgId).in("id", [...ids]);
  // A failed read leaves the lines neutral — the same thing an unreadable row
  // shows — and says so in the log rather than failing the page.
  if (error) {
    console.error("timeline title read failed:", { table, count: ids.size, error: error.message });
    return titles;
  }
  for (const row of data ?? []) {
    if (typeof row.title === "string" && row.title.trim()) titles.set(row.id, row.title);
  }
  return titles;
}

export async function attachCurrentTitles<E extends ContextEvent>(
  /** the VIEWER's client — RLS decides what they may read. Never the admin client. */
  viewer: Client,
  /** the viewer's org, from their own profile */
  orgId: string,
  events: E[],
): Promise<(E & Pick<ContextEvent, "current_title">)[]> {
  const wanted: Record<Source["table"], Set<string>> = { tasks: new Set(), documents: new Set() };
  for (const e of events) {
    const s = sourceOf(e);
    if (s) wanted[s.table].add(s.id);
  }
  if (wanted.tasks.size === 0 && wanted.documents.size === 0) return events;
  // Loudly nothing, never an unbounded read (the entity-timeline.ts rule).
  if (!orgId) {
    console.error("timeline title read refused: no org");
    return events;
  }

  const [tasks, documents] = await Promise.all([
    readTitles(viewer, "tasks", orgId, wanted.tasks),
    readTitles(viewer, "documents", orgId, wanted.documents),
  ]);
  const found = { tasks, documents };

  return events.map((e) => {
    const s = sourceOf(e);
    const title = s ? found[s.table].get(s.id) : undefined;
    return title ? { ...e, current_title: title } : e;
  });
}
