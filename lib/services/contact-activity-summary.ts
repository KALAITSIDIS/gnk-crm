import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { LOGGED_CONTACT_TYPES } from "@/lib/services/activity-kinds";
import { compareNewestFirst, idSlices } from "@/lib/services/entity-timeline";
import { fetchAll } from "@/lib/supabase/fetch-all";

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

/** When each of several people was last LOGGED as contacted — or `{ ok: false }` when that could not be read. */
export type LastLoggedContacts = { ok: true; last: Map<string, string> } | { ok: false };

type LinkKind = "contact" | "lead" | "deal";

/**
 * THE AGENT DASHBOARD'S "Hot buyers — no logged contact in 3+ days" (A06 step
 * 7): for each contact, the instant of the newest LOGGED contact — a logged
 * conversation, a call, a "contacted" stamp (`LOGGED_CONTACT_TYPES`) — on the
 * contact, on a contact merged into it, on its leads, or on the deals the
 * viewer may read with it as buyer or seller. A contact with none is absent
 * from the map.
 *
 * The strip's rule (`readContactActivitySummary`), asked of many people at
 * once. The card used to ask "any event on the contact" (readLastTouched,
 * removed): a WhatsApp-link click or a profile edit cleared "idle", while a
 * call logged on the buyer's lead from the inbox, or on their deal, did not
 * count. A chat-link click is never contact here either — it opens WhatsApp
 * and says nothing about a message being sent.
 *
 * SAME CONTRACT AS THE STRIP. The person's other records are read on the
 * VIEWER's client, so every id the system read is asked about is one RLS let
 * them see — leads and contacts are org-readable, deals are what
 * `deals_select` admits (an agent's own, or every deal for an admin or a
 * listing manager): a call a colleague logged on a deal this agent cannot
 * read does not count on THIS agent's card, as it does not on their strip.
 * The events are read as the SYSTEM, org-bound (`events_select` shows a
 * non-admin only their own rows — entity-timeline.ts), and only three
 * columns of them.
 *
 * BOUNDED READS: every id list goes out in slices of IDS_PER_READ (the
 * gateway's 414 at ~197 ids), and every read is paged (fetchAll — PostgREST
 * cuts a read at 1,000 rows silently): a "no logged contact" must be true of
 * every record the person has, not of the first thousand rows.
 *
 * NOTHING IS A ZERO. A read that did not answer makes the whole answer
 * `{ ok: false }`: a card that then listed everyone as idle — or no one —
 * would be a guess standing in for data that was not read.
 */
export async function readLastLoggedContacts(opts: {
  /** the caller's org, from rows they read through RLS — never from user input */
  orgId: string;
  /** The VIEWER's own client — the person's leads and deals are read with their permissions. Never the admin client. */
  viewer: Client;
  /** contacts the CALLER read through RLS */
  contactIds: readonly string[];
}): Promise<LastLoggedContacts> {
  const contacts = [...new Set(opts.contactIds)];
  if (contacts.length === 0) return { ok: true, last: new Map() };
  if (!opts.orgId) {
    // the admin client's only boundary — loudly nothing, never quietly everything
    console.error("last logged contact read refused: no org");
    return { ok: false };
  }
  try {
    // record id → the people (in `contacts`) it belongs to, per entity type
    const owners: Record<LinkKind, Map<string, Set<string>>> = { contact: new Map(), lead: new Map(), deal: new Map() };
    const own = (kind: LinkKind, recordId: string, contactId: string | null) => {
      if (!contactId) return;
      const set = owners[kind].get(recordId) ?? new Set<string>();
      set.add(contactId);
      owners[kind].set(recordId, set);
    };
    for (const c of contacts) own("contact", c, c);

    // 1. as the VIEWER: each person's merged duplicates, leads and deals
    const v = opts.viewer;
    await Promise.all(
      idSlices(contacts).flatMap((ids) => [
        fetchAll(
          (from, to) => v.from("contacts").select("id, merged_into_id").in("merged_into_id", ids).order("id").range(from, to),
          "merged contacts",
        ).then((rows) => rows.forEach((r) => own("contact", r.id, r.merged_into_id))),
        fetchAll(
          (from, to) => v.from("leads").select("id, contact_id").in("contact_id", ids).order("id").range(from, to),
          "buyers' leads",
        ).then((rows) => rows.forEach((r) => own("lead", r.id, r.contact_id))),
        fetchAll(
          (from, to) => v.from("deals").select("id, buyer_contact_id").in("buyer_contact_id", ids).order("id").range(from, to),
          "buyers' deals",
        ).then((rows) => rows.forEach((r) => own("deal", r.id, r.buyer_contact_id))),
        fetchAll(
          (from, to) => v.from("deals").select("id, seller_contact_id").in("seller_contact_id", ids).order("id").range(from, to),
          "sellers' deals",
        ).then((rows) => rows.forEach((r) => own("deal", r.id, r.seller_contact_id))),
      ]),
    );

    // 2. as the SYSTEM, org-bound: every logged contact on those records
    const admin = createAdminClient();
    const asks = (["contact", "lead", "deal"] as const).flatMap((kind) =>
      idSlices([...owners[kind].keys()]).map((ids) => ({ kind, ids })),
    );
    const answers = await Promise.all(
      asks.map((a) =>
        fetchAll(
          (from, to) =>
            admin
              .from("events")
              .select("id, entity_id, occurred_at")
              // EXPLICIT — the admin client bypasses RLS, so this is the only org boundary
              .eq("org_id", opts.orgId)
              .eq("entity_type", a.kind)
              .in("entity_id", a.ids)
              .in("event_type", [...LOGGED_CONTACT_TYPES])
              .order("id")
              .range(from, to),
          `logged contacts (${a.kind})`,
        ).then((rows) => ({ kind: a.kind, rows })),
      ),
    );

    const last = new Map<string, string>();
    for (const { kind, rows } of answers) {
      for (const r of rows) {
        const people = r.entity_id ? owners[kind].get(r.entity_id) : undefined;
        if (!people) continue;
        const at = Date.parse(r.occurred_at);
        if (!Number.isFinite(at)) continue;
        for (const c of people) {
          const prev = last.get(c);
          if (prev === undefined || at > Date.parse(prev)) last.set(c, r.occurred_at);
        }
      }
    }
    return { ok: true, last };
  } catch (e) {
    console.error("last logged contact read failed:", {
      count: contacts.length,
      error: e instanceof Error ? e.message : String(e),
    });
    return { ok: false };
  }
}
