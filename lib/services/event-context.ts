import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

/**
 * WHICH task or document an event is about, and what a viewing's buyer says,
 * read back from the record itself.
 *
 * Since T-event-typed-text-shape a task's `completed` / `reopened` event and a
 * document's `document_uploaded` event carry ids, never the title: a title is
 * typed text that names people ("Call Maria about the deposit"), or the
 * uploaded file's name ("passport_AB123456.pdf"), and the hash chain is beyond
 * erasure and correction (audit SEC-03). This attaches the row's CURRENT title
 * as `current_title`, so a timeline can still say which one. Since
 * T-viewing-feedback-shape a `viewing_feedback` event carries
 * `{ viewing_id, reference, rating }`, never the buyer's words; the viewing's
 * current comment (else what was liked) arrives as `current_feedback` — the
 * C7 acceptance that feedback shows on the property's timeline. Four rules:
 *
 * 1. THE VIEWER'S CLIENT, NEVER THE SYSTEM'S. `documents_select` hides an
 *    admin_only document (a passport scan) from agents and listing managers,
 *    and `tasks_select` hides tasks that are not theirs. Asking as the viewer
 *    lets RLS decide, exactly as it does for the documents tab and the task
 *    list; a row the viewer may not read simply does not come back, and the line
 *    stays neutral. `viewings_select` is org-wide today (0030) — the same
 *    audience as the property timeline — but the rule does not depend on that.
 *    `readEntityTimeline` reads EVENTS as the system — that is about which
 *    events exist, not what the records say — so it must hand this function
 *    the caller's own client, not its admin one.
 * 2. NO FALLBACK TO THE PAYLOAD. An older event's copy of a title or of the
 *    buyer's words is never consulted, whether its row is gone, hidden or
 *    present. A deleted document has no row, so its line is "Document deleted"
 *    and nothing more; it is not even looked up.
 * 3. CURRENT, AND SAID TO BE. The value is what the row says now, and the
 *    renderer labels it "current title" / "current feedback"
 *    (`describeEventContext`) rather than folding it into the line, because a
 *    row can change after the event. Feedback is overwritten by every save and
 *    each save logs an event, so only the NEWEST `viewing_feedback` event per
 *    viewing on the page carries it — an older save never shows today's
 *    wording beside it.
 * 4. THE EVENT'S OWN PROPERTY. A viewing's feedback is attached only when the
 *    viewing belongs to the property the event is on: any org member may
 *    insert any payload, and a crafted event must not pull one property's
 *    feedback onto another's timeline.
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
  /** used to find the newest `viewing_feedback` event per viewing */
  occurred_at?: string;
  current_title?: string | null;
  current_feedback?: string | null;
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

/**
 * A uuid from the payload, LOWERCASED: Postgres returns a row's id in
 * lowercase whatever case it was asked in, and `z.guid()` lets an uppercase
 * one through to a payload. Without this one key, a viewing named in two cases
 * is two "newest" events, and an older save could carry today's words.
 */
function payloadId(e: ContextEvent, key: string): string | null {
  const p = e.payload;
  const id = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>)[key] : null;
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
}

function sourceOf(e: ContextEvent): Source | null {
  if (e.entity_type === "task" && TASK_EVENTS.has(e.event_type)) {
    return e.entity_id && UUID.test(e.entity_id) ? { table: "tasks", id: e.entity_id } : null;
  }
  if (DOCUMENT_EVENTS.has(e.event_type)) {
    const id = payloadId(e, "document_id");
    return id ? { table: "documents", id } : null;
  }
  return null;
}

/** The viewing a property's `viewing_feedback` event names, or null. */
function viewingOf(e: ContextEvent): string | null {
  if (e.event_type !== "viewing_feedback" || e.entity_type !== "property") return null;
  return payloadId(e, "viewing_id");
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

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** viewing id → { its property, the comment else what was liked } */
async function readFeedback(
  viewer: Client,
  orgId: string,
  ids: Set<string>,
): Promise<Map<string, { property_id: string; feedback: string }>> {
  const found = new Map<string, { property_id: string; feedback: string }>();
  if (ids.size === 0) return found;
  const { data, error } = await viewer
    .from("viewings")
    .select("id, property_id, feedback")
    .eq("org_id", orgId)
    .in("id", [...ids]);
  // as readTitles — and never the words themselves in the log
  if (error) {
    console.error("timeline feedback read failed:", { count: ids.size, error: error.message });
    return found;
  }
  for (const row of data ?? []) {
    const f = row.feedback;
    if (!f || typeof f !== "object" || Array.isArray(f)) continue;
    const words = text((f as Record<string, unknown>).comment) ?? text((f as Record<string, unknown>).liked);
    if (words) found.set(row.id, { property_id: row.property_id, feedback: words });
  }
  return found;
}

export async function attachCurrentTitles<E extends ContextEvent>(
  /** the VIEWER's client — RLS decides what they may read. Never the admin client. */
  viewer: Client,
  /** the viewer's org, from their own profile */
  orgId: string,
  events: E[],
): Promise<(E & Pick<ContextEvent, "current_title" | "current_feedback">)[]> {
  const wanted: Record<Source["table"], Set<string>> = { tasks: new Set(), documents: new Set() };
  // viewing id → index of its NEWEST event on the page (ties: the first seen)
  const newest = new Map<string, number>();
  events.forEach((e, i) => {
    const s = sourceOf(e);
    if (s) wanted[s.table].add(s.id);
    const v = viewingOf(e);
    if (v) {
      const at = newest.get(v);
      if (at === undefined || (e.occurred_at ?? "") > (events[at].occurred_at ?? "")) newest.set(v, i);
    }
  });
  if (wanted.tasks.size === 0 && wanted.documents.size === 0 && newest.size === 0) return events;
  // Loudly nothing, never an unbounded read (the entity-timeline.ts rule).
  if (!orgId) {
    console.error("timeline title read refused: no org");
    return events;
  }

  const [tasks, documents, feedback] = await Promise.all([
    readTitles(viewer, "tasks", orgId, wanted.tasks),
    readTitles(viewer, "documents", orgId, wanted.documents),
    readFeedback(viewer, orgId, new Set(newest.keys())),
  ]);
  const found = { tasks, documents };

  return events.map((e, i) => {
    const s = sourceOf(e);
    const title = s ? found[s.table].get(s.id) : undefined;
    if (title) return { ...e, current_title: title };
    const v = viewingOf(e);
    const row = v && newest.get(v) === i ? feedback.get(v) : undefined;
    return row && row.property_id === e.entity_id ? { ...e, current_feedback: row.feedback } : e;
  });
}
