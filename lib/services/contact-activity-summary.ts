import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { LOGGED_CONTACT_TYPES } from "@/lib/services/activity-kinds";
import { compareNewestFirst, idSlices } from "@/lib/services/entity-timeline";

/**
 * The strip under a contact's name (A06): when the desk last RECORDED contact
 * with the person, when someone last only opened a chat link, and what is
 * next. A colleague about to ring a buyer sees at the top of the page that
 * the buyer was rung yesterday — even when that call was logged on the
 * buyer's lead from the inbox or on the deal.
 *
 * WHAT COUNTS AS CONTACT. A logged conversation, a call, a "contacted" stamp
 * (`LOGGED_CONTACT_TYPES`) — on the contact, its leads or its deals. A
 * chat-link click is NOT contact: it opens WhatsApp and says nothing about a
 * message being sent. It gets its own line, "Last chat opened", and moves no
 * clock anywhere — this module only reads.
 *
 * TWO CLIENTS, ON PURPOSE.
 * - The events are read as the SYSTEM (`events_select` shows a non-admin only
 *   their own rows — entity-timeline.ts), org-bound, for ids the CALLER read
 *   through RLS: the contact, its leads (org-readable), the deals the caller
 *   may read. Same contract as `readEntityTimeline`.
 * - The next task and the next viewing are read as the VIEWER: `tasks_select`
 *   admits an admin, the assignee or the creator, and a task's title is typed
 *   text ("Call Maria about the deposit") — read as the system it would put a
 *   colleague's task on every agent's screen. So a non-admin's "next step" is
 *   a task THEY may read: theirs, or one they set a colleague (tasks_select
 *   admits the creator too), and the strip names whose it is
 *   (`nextTaskLabel`) rather than calling every one "your task".
 *
 * NOTHING IS A ZERO. Each part is `{ ok: true, value }` — `value: null` is a
 * true "none" — or `{ ok: false }` when its read did not answer, which the
 * strip renders as "could not load", never as "no contact yet". "None" is
 * only true of EVERY id it was given, so the caller hands over every lead and
 * deal (lib/queries/contact-history.ts), never a display list's newest 50;
 * the ids go out in slices under the gateway's 414 (IDS_PER_READ).
 */

export type SummaryPart<T> = { ok: true; value: T | null } | { ok: false };

export interface LastEvent {
  id: string | number;
  occurred_at: string;
  event_type: string;
  entity_type: string;
  actor_id: string | null;
  /** only what the line reads: the channel, a conversation's outcome (0155) and the first-response / first-call flags */
  payload: Json;
}

export interface NextTask {
  id: string;
  title: string;
  due_at: string | null;
  /**
   * Whose task it is. A non-admin reads their own tasks AND the ones they set
   * a colleague (tasks_select: admin, assignee or creator), so "Your task" is
   * said only when this is the viewer (`nextTaskLabel`).
   */
  assignee_id: string | null;
}

export interface NextViewing {
  id: string;
  scheduled_at: string;
  reference: string | null;
}

export interface ContactActivitySummary {
  lastContact: SummaryPart<LastEvent>;
  lastChatOpened: SummaryPart<LastEvent>;
  nextTask: SummaryPart<NextTask>;
  nextViewing: SummaryPart<NextViewing>;
}

type Client = SupabaseClient<Database>;

/**
 * The payload keys a summary line reads — nothing else leaves this module.
 * `outcome` (0155): "Message sent (WhatsApp)" and "Client replied (WhatsApp)"
 * are different news at the top of a buyer's page.
 */
const LINE_KEYS = ["channel", "outcome", "first_response", "first_call"] as const;

function lineOnly(payload: unknown): Json {
  const out: Record<string, Json> = {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return out;
  const p = payload as Record<string, unknown>;
  for (const k of LINE_KEYS) {
    const v = p[k];
    if (typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

type Source = { entityType: "contact" | "lead" | "deal"; ids: readonly string[] };

/** The newest event of `types` across the sources, as the system, org-bound. */
async function newestOf(orgId: string, sources: readonly Source[], types: readonly string[]): Promise<SummaryPart<LastEvent>> {
  const live = sources.filter((s) => s.ids.length > 0);
  if (live.length === 0) return { ok: true, value: null };
  const admin = createAdminClient();
  // every source's ids in slices under the 414 — a developer's deals run to hundreds
  const asks = live.flatMap((s) => idSlices(s.ids).map((ids) => ({ entityType: s.entityType, ids })));
  const answers = await Promise.all(
    asks.map((a) =>
      admin
        .from("events")
        .select("id, occurred_at, event_type, entity_type, actor_id, payload")
        // EXPLICIT — the admin client bypasses RLS, so this is the only org boundary
        .eq("org_id", orgId)
        .eq("entity_type", a.entityType)
        .in("entity_id", a.ids)
        .in("event_type", types as string[])
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
    ),
  );
  let best: LastEvent | null = null;
  for (const [i, res] of answers.entries()) {
    if (res.error || !Array.isArray(res.data)) {
      console.error("contact summary read failed:", {
        entityType: asks[i].entityType,
        error: res.error ? res.error.message : "the answer held no rows",
      });
      return { ok: false };
    }
    const row = res.data[0];
    if (!row) continue;
    const candidate: LastEvent = {
      id: row.id,
      occurred_at: row.occurred_at,
      event_type: row.event_type,
      entity_type: row.entity_type,
      actor_id: row.actor_id,
      payload: lineOnly(row.payload),
    };
    if (!best || compareNewestFirst(candidate, best) < 0) best = candidate;
  }
  return { ok: true, value: best };
}

/** The viewer's earliest open task on the contact, its leads or its deals: due first, undated last. */
async function nextTaskOf(
  viewer: Client,
  orgId: string,
  sources: { column: "contact_id" | "lead_id" | "deal_id"; ids: readonly string[] }[],
): Promise<SummaryPart<NextTask>> {
  const live = sources.filter((s) => s.ids.length > 0);
  if (live.length === 0) return { ok: true, value: null };
  // one query per link column and slice, each with a short id list — never
  // one `.or()` that grows with the deals and leads (the ~197-id 414)
  const asks = live.flatMap((s) => idSlices(s.ids).map((ids) => ({ column: s.column, ids })));
  const answers = await Promise.all(
    asks.map((a) =>
      viewer
        .from("tasks")
        .select("id, title, due_at, assignee_id")
        .eq("org_id", orgId)
        .eq("is_done", false)
        .in(a.column, a.ids)
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true })
        .limit(1),
    ),
  );
  let best: NextTask | null = null;
  for (const res of answers) {
    if (res.error || !Array.isArray(res.data)) {
      console.error("contact summary task read failed:", { error: res.error ? res.error.message : "no rows" });
      return { ok: false };
    }
    const row = res.data[0];
    if (!row) continue;
    const candidate: NextTask = { id: row.id, title: row.title, due_at: row.due_at, assignee_id: row.assignee_id ?? null };
    if (!best || earlierTask(candidate, best)) best = candidate;
  }
  return { ok: true, value: best };
}

/**
 * What the strip calls the next task: "Your task" only when it is assigned to
 * the viewer. A non-admin's read also returns a task they CREATED for a
 * colleague (tasks_select), and calling that "your task" misleads the one
 * decision the strip exists for — who is on this person (A06 review).
 */
export function nextTaskLabel(
  task: Pick<NextTask, "assignee_id">,
  viewerId: string,
  names: ReadonlyMap<string, string>,
): string {
  if (task.assignee_id === viewerId) return "Your task";
  if (!task.assignee_id) return "Unassigned task";
  return `Task for ${names.get(task.assignee_id) ?? "a colleague"}`;
}

function earlierTask(a: NextTask, b: NextTask): boolean {
  if (a.due_at && b.due_at) {
    const ta = Date.parse(a.due_at);
    const tb = Date.parse(b.due_at);
    if (ta !== tb) return ta < tb;
    return a.id < b.id;
  }
  if (a.due_at && !b.due_at) return true;
  if (!a.due_at && b.due_at) return false;
  return a.id < b.id;
}

async function nextViewingOf(viewer: Client, orgId: string, contactId: string, now: Date): Promise<SummaryPart<NextViewing>> {
  const res = await viewer
    .from("viewings")
    .select("id, scheduled_at, properties(reference)")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("status", "scheduled")
    .gte("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);
  if (res.error || !Array.isArray(res.data)) {
    console.error("contact summary viewing read failed:", { error: res.error ? res.error.message : "no rows" });
    return { ok: false };
  }
  const row = res.data[0];
  if (!row) return { ok: true, value: null };
  const prop = row.properties as { reference?: string | null } | null;
  return { ok: true, value: { id: row.id, scheduled_at: row.scheduled_at, reference: prop?.reference ?? null } };
}

export async function readContactActivitySummary(opts: {
  /** the caller's org, from their own profile — never from user input */
  orgId: string;
  /** The VIEWER's own client — tasks and viewings are read with their permissions. Never the admin client. */
  viewer: Client;
  /** the contact the page read through RLS */
  contactId: string;
  /** the contact and every contact merged into it — ids the CALLER read through RLS */
  contactIds: readonly string[];
  /** EVERY lead of the contact, read through RLS — not a display list's newest few */
  leadIds: readonly string[];
  /** EVERY deal the caller may read with this contact as a party, read through RLS */
  dealIds: readonly string[];
  /** the request's clock: "next" viewing means from now on */
  now: Date;
}): Promise<ContactActivitySummary> {
  if (!opts.orgId) {
    // the admin client's only boundary — loudly nothing, never quietly everything
    console.error("contact summary refused: no org");
    return { lastContact: { ok: false }, lastChatOpened: { ok: false }, nextTask: { ok: false }, nextViewing: { ok: false } };
  }
  const sources: Source[] = [
    { entityType: "contact", ids: opts.contactIds },
    { entityType: "lead", ids: opts.leadIds },
    { entityType: "deal", ids: opts.dealIds },
  ];
  const [lastContact, lastChatOpened, nextTask, nextViewing] = await Promise.all([
    newestOf(opts.orgId, sources, LOGGED_CONTACT_TYPES),
    newestOf(opts.orgId, sources, ["chat_link_opened"]),
    nextTaskOf(opts.viewer, opts.orgId, [
      { column: "contact_id", ids: opts.contactIds },
      { column: "lead_id", ids: opts.leadIds },
      { column: "deal_id", ids: opts.dealIds },
    ]),
    nextViewingOf(opts.viewer, opts.orgId, opts.contactId, opts.now),
  ]);
  return { lastContact, lastChatOpened, nextTask, nextViewing };
}
