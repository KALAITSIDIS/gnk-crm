import { createAdminClient } from "@/lib/supabase/admin";
import type { TimelineEvent } from "@/lib/services/events";
import { contactDocVisibility, type DocType } from "@/lib/validators/documents";

/**
 * A record's timeline — what happened to it, not what YOU did to it.
 *
 * THE PROBLEM THIS EXISTS FOR. `events_select` (0063) is
 * `org_id = current_org_id() AND (role = 'admin' OR actor_id = auth.uid())`.
 * On the caller's client that answers a different question from the one a
 * timeline asks: not "what happened to this contact" but "what did I do to this
 * contact". Measured against the local database on 2026-09-07 — three events
 * seeded on one contact, one by the agent, one by a colleague, one by a cron —
 * the agent saw ONE of three. A colleague's edit is invisible, and every
 * system event is invisible to every non-admin, because `null = auth.uid()` is
 * NULL and never true. Sweeps, nudges, price-drop alerts, reservation expiries:
 * none of them appear on any agent's timeline.
 *
 * WHY THE POLICY IS NOT WIDENED INSTEAD. docs/04_RLS_POLICY_MATRIX.md has said
 * from the start what the rule should be — "`actor_id = uid` OR entity is a
 * record they can read — implement pragmatically: A + AG/LM where
 * `actor_id = uid`; timeline pages assemble via server actions with service
 * role for cross-entity reads, still org-scoped". The narrow policy is the
 * deliberate half of that design and 0071 hardened its INSERT side so a session
 * cannot append rows naming another user; this file is the half that was never
 * built.
 *
 * And widening it would leak. `lib/actions/mandates.ts` builds its `updated`
 * payload from `Object.entries(updates)`, which includes `commission_pct` and
 * `commission_notes` — the two fields doc 04 masks from listing managers behind
 * the `mandates_safe` view. An org-wide `events_select` would hand them back
 * through the event log. Reading per entity type, for the types a page actually
 * renders, does not: no screen renders a mandate timeline.
 *
 * AUTHORISATION IS THE CALLER'S OWN READ. Every caller loads its parent row
 * through RLS first and `notFound()`s when RLS withholds it — contacts page:100,
 * properties page:96, deals page:43. So an id reaching `entityIds` is proof the
 * caller was allowed to see the row it names. This function must therefore only
 * ever be given ids that came back from a query on the CALLER's client; passing
 * an id from anywhere else would be asserting an authorisation nobody checked.
 *
 * `orgId` is filtered explicitly because the admin client has no RLS to do it.
 */

/**
 * The row shape is `TimelineEvent` from lib/services/events.ts — the type the
 * renderer already reads — plus `entity_id`, which the contact page needs to
 * label an event that came from a merged-away contact. Defining a second
 * timeline type here is the "one fact, two definitions" failure this repo keeps
 * catching itself in.
 */
export type TimelineRow = TimelineEvent & { entity_id: string | null };

/**
 * The entity types a screen actually renders a timeline for. A UNION, not a
 * string, and that is load-bearing: `mandate` events carry `commission_pct` and
 * `commission_notes` in their `changed` payload (lib/actions/mandates.ts), which
 * doc 04 masks from listing managers behind `mandates_safe`. Nothing renders a
 * mandate timeline today, and adding one must be a compile error here rather
 * than a silent leak through a reader that answers as the system.
 */
export type TimelineEntityType = "contact" | "property" | "deal" | "offer" | "key";

export async function readEntityTimeline(opts: {
  /** the caller's org, from their own profile — never from user input */
  orgId: string;
  entityType: TimelineEntityType;
  /** ids the CALLER already read through RLS. See the note above. */
  entityIds: readonly string[];
  limit: number;
  /** the VIEWER's role — decides whether a document's title may be shown */
  viewerRole: string;
}): Promise<TimelineRow[]> {
  if (opts.entityIds.length === 0) return [];
  /*
   * An org is REQUIRED, and refusing here rather than trusting callers is the
   * point: on a service-role client `org_id` is the only boundary there is, and
   * a caller that derived it from an empty array would pass "" without
   * noticing. Loudly nothing, never quietly everything.
   */
  if (!opts.orgId) {
    console.error("timeline read refused: no org", { entityType: opts.entityType });
    return [];
  }

  const { data, error } = await createAdminClient()
    .from("events")
    .select("id, occurred_at, event_type, entity_type, entity_id, payload")
    // EXPLICIT — the admin client bypasses RLS, so this is the only org boundary
    .eq("org_id", opts.orgId)
    .eq("entity_type", opts.entityType)
    .in("entity_id", opts.entityIds as string[])
    .order("occurred_at", { ascending: false })
    .limit(opts.limit);

  // A timeline that silently shows nothing is indistinguishable from a record
  // nothing has happened to — the failure this whole day's work was about. A
  // read that failed says so in the log rather than rendering as an empty
  // history; the caller keeps its page.
  if (error) {
    console.error("timeline read failed:", {
      entityType: opts.entityType,
      count: opts.entityIds.length,
      error: error.message,
    });
    return [];
  }
  const rows = (data ?? []) as unknown as TimelineRow[];
  return redactWonDealKinds(redactDocumentTitles(rows, opts.viewerRole), opts.viewerRole);
}

/** The two event types whose payload carries a document's title. */
const DOCUMENT_EVENTS = new Set(["document_uploaded", "document_deleted"]);

/**
 * THE ONE THING THIS READER MUST NOT HAND OVER.
 *
 * `documents_select` is `org_id = current_org_id() AND (role = 'admin' OR
 * visibility = 'internal')`, so an agent or listing manager cannot read an
 * `admin_only` document row at all. Those are the CDD records — passport scans,
 * proof of address, source of funds — which `lib/validators/documents.ts` calls
 * "the most sensitive PII the desk holds", admin-only by need-to-know (SEC-02),
 * "enforced three deep".
 *
 * But the upload files an event on the CONTACT — a type this reader returns
 * org-wide — whose payload carries the title, and `describeEvent` prints that
 * title verbatim. The title defaults to the uploaded FILE NAME. So showing the
 * whole history without this step would put "Document uploaded —
 * passport_AB123456.pdf" on every agent's and listing manager's screen, and
 * undo three layers of enforcement with a line of prose.
 *
 * `doc_type` decides it, not a lookup: `contactDocVisibility` maps exactly the
 * KYC types to `admin_only` and the 0072 CHECK enforces that mapping in the
 * database from every path. A lookup would also fail for `document_deleted`,
 * where the row is gone.
 *
 * UNKNOWN FAILS CLOSED. A payload with no readable `doc_type` loses its title
 * too — the renderer already has an untitled branch ("Document uploaded"), so
 * the event still appears and only the name is withheld.
 */
function redactDocumentTitles(rows: TimelineRow[], viewerRole: string): TimelineRow[] {
  if (viewerRole === "admin") return rows;
  return rows.map((r) => {
    if (!DOCUMENT_EVENTS.has(r.event_type)) return r;
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    if (payload.title === undefined) return r;
    const docType = typeof payload.doc_type === "string" ? payload.doc_type : null;
    const visible = docType !== null && contactDocVisibility(docType as DocType) === "internal";
    if (visible) return r;
    // rebuilt without `title`, rather than destructured — the eslint config has
    // no ignore pattern for a discarded binding, and a lint warning parked in
    // the redaction path is the last place to leave noise
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) if (k !== "title") rest[k] = v;
    return { ...r, payload: rest as TimelineRow["payload"] };
  });
}


/**
 * When each of these records was last touched by ANYONE.
 *
 * A separate function from `readEntityTimeline`, not a flag on it, because it
 * is a different question and wants a different shape: two columns over up to
 * several hundred rows, where a timeline wants whole events over a few dozen.
 * Pulling `payload` for 500 rows to compute a max(occurred_at) would be a
 * needless read of every jsonb blob on the page an agent opens most.
 *
 * WHY IT MATTERS THAT IT ASKS THE SYSTEM. The agent dashboard's "idle" list is
 * "no event, or the last one is older than three days". On the caller's client
 * that became "no event OF MINE" — so a contact a colleague called yesterday
 * still read as untouched, and the desk's own tool told an agent to ring a
 * buyer who had just been rung. For a CRM that is the failure the product
 * exists to prevent.
 *
 * Same contract as its neighbour: `entityIds` must be ids the CALLER already
 * read through RLS, and `orgId` is filtered explicitly.
 */
export async function readLastTouched(opts: {
  orgId: string;
  entityType: string;
  entityIds: readonly string[];
  /** how many recent rows to sample; the caller reduces them to a max per id */
  limit: number;
}): Promise<{ entity_id: string | null; occurred_at: string }[]> {
  if (opts.entityIds.length === 0) return [];
  /*
   * An org is REQUIRED, and refusing here rather than trusting callers is the
   * point: on a service-role client `org_id` is the only boundary there is, and
   * a caller that derived it from an empty array would pass "" without
   * noticing. Loudly nothing, never quietly everything.
   */
  if (!opts.orgId) {
    console.error("timeline read refused: no org", { entityType: opts.entityType });
    return [];
  }

  const { data, error } = await createAdminClient()
    .from("events")
    .select("entity_id, occurred_at")
    .eq("org_id", opts.orgId)
    .eq("entity_type", opts.entityType)
    .in("entity_id", opts.entityIds as string[])
    .order("occurred_at", { ascending: false })
    .limit(opts.limit);

  if (error) {
    console.error("last-touched read failed:", {
      entityType: opts.entityType,
      count: opts.entityIds.length,
      error: error.message,
    });
    return [];
  }
  return (data ?? []) as { entity_id: string | null; occurred_at: string }[];
}

/**
 * Follow-up kinds that say, on a PROPERTY, that a deal on it was won.
 *
 * `listing_status_check` is raised only while the property still reads
 * available/reserved/under_offer — that is its whole trigger — so the property
 * row itself does NOT betray the sale, and `reservation_still_live` says the
 * same thing about the same win.
 */
const WON_DEAL_KINDS = new Set(["listing_status_check", "reservation_still_live"]);

/**
 * A property is readable by everyone in the org; a deal is not.
 *
 * `properties_select` is plain `org_id = current_org_id()`, so any staff member
 * can open any listing. `deals_select` admits an admin, a listing manager, or
 * the deal's own agent/creator — and `tasks_select` keeps the prompt's title
 * ("Deal won — update listing status: PAF0001") hidden from everyone else too.
 *
 * Before timelines were read as the system, `events_select` hid these events
 * from a non-owning agent as a side effect. Reading the whole history brought
 * them back, rendered as "the deal was won but the listing still reads
 * on-market" — telling an agent that a colleague's deal closed, on a property
 * whose status still says available, which is precisely the fact deals_select
 * withholds. Existence, outcome and timing; not amounts, and not counterparties
 * — but on a small desk that is enough to infer a colleague's closed sale.
 *
 * So the KIND is withheld and `describeEvent` falls back to its neutral
 * "Follow-up task created" line: the event stays on the timeline, because a
 * follow-up was genuinely raised, and only the sentence that names a won deal
 * goes. Listing managers keep it, because they may read every deal anyway.
 *
 * The owning agent loses the specific line here too — resolving per-row deal
 * ownership would mean a second query per event, and they already see the whole
 * prompt on their own task list and deal page.
 */
function redactWonDealKinds(rows: TimelineRow[], viewerRole: string): TimelineRow[] {
  if (viewerRole === "admin" || viewerRole === "listing_manager") return rows;
  return rows.map((r) => {
    if (r.event_type !== "followup_task_created") return r;
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.kind !== "string" || !WON_DEAL_KINDS.has(payload.kind)) return r;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k !== "kind" && k !== "deal_id") rest[k] = v;
    }
    return { ...r, payload: rest as TimelineRow["payload"] };
  });
}
