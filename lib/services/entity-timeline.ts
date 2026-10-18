import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { attachCurrentTitles } from "@/lib/services/event-context";
import type { TimelineEvent } from "@/lib/services/events";
import { NOTE_ERASED_LABEL } from "@/lib/services/notes";

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
 * through RLS first and `notFound()`s when RLS withholds it — the guard at the
 * top of each of the three detail pages. So an id reaching `entityIds` is proof the
 * caller was allowed to see the row it names. This function must therefore only
 * ever be given ids that came back from a query on the CALLER's client; passing
 * an id from anywhere else would be asserting an authorisation nobody checked.
 *
 * `orgId` is filtered explicitly because the admin client has no RLS to do it.
 */

/**
 * The row shape is `TimelineEvent` from lib/services/events.ts — the type the
 * renderer already reads — plus `entity_id`, which the contact page needs to
 * label an event that came from a merged-away contact, and `actor_id`, which a
 * combined feed needs to name the author. Defining a second
 * timeline type here is the "one fact, two definitions" failure this repo keeps
 * catching itself in.
 */
export type TimelineRow = TimelineEvent & {
  entity_id: string | null;
  /**
   * Who wrote the event: a profile id, or null for the system (a cron, a
   * definer, the website's enquiry door). A combined feed names the author
   * from `profiles`, read as the viewer (`readEntityTimelines`).
   */
  actor_id: string | null;
};

/**
 * The entity types a screen actually renders a timeline for. A UNION, not a
 * string, and that is load-bearing: `mandate` events carry `commission_pct` and
 * `commission_notes` in their `changed` payload (lib/actions/mandates.ts), which
 * doc 04 masks from listing managers behind `mandates_safe`. Nothing renders a
 * mandate timeline today, and adding one must be a compile error here rather
 * than a silent leak through a reader that answers as the system.
 *
 * `lead` and `viewing` joined for a customer's combined history (A06): the
 * inbox's Contacted / Called / Log / WhatsApp buttons file their events on the
 * LEAD, and a viewing's on the VIEWING, so a contact page that read only
 * `contact` missed most of the work done with the person. Both rows are
 * org-readable (`leads_select`, `viewings_select`: `org_id =
 * current_org_id()`), and their payloads are ids, flags and times — with ONE
 * exception, `viewing_slip_signed`, which carries the signer's and the second
 * attendee's names while `viewing_slips_select` admits only an admin or the
 * viewing's agent. `redactSlipSigners` below withholds them.
 */
export type TimelineEntityType = "contact" | "property" | "deal" | "offer" | "key" | "lead" | "viewing";

export async function readEntityTimeline(opts: {
  /** the caller's org, from their own profile — never from user input */
  orgId: string;
  entityType: TimelineEntityType;
  /** ids the CALLER already read through RLS. See the note above. */
  entityIds: readonly string[];
  limit: number;
  /**
   * the VIEWER's role — decides whether an older payload keeps its document
   * title (redactDocumentTitles), whether a won-deal follow-up keeps its kind,
   * and whether a signed slip's line keeps its names (redactSlipSigners)
   */
  viewerRole: string;
  /**
   * The VIEWER's own client. The events come from the system; what a task or
   * document is CALLED, and what a viewing's buyer says now, come from their
   * rows, read as the viewer, so RLS decides whether they may see it
   * (lib/services/event-context.ts). Never pass the admin client here —
   * tests/unit/timeline-viewer-client.test.ts checks every caller.
   */
  viewer: SupabaseClient<Database>;
}): Promise<TimelineRow[]> {
  const { rows } = await readSource(opts.orgId, opts.viewerRole, {
    entityType: opts.entityType,
    entityIds: opts.entityIds,
    limit: opts.limit,
  });
  return attachCurrentTitles(opts.viewer, opts.orgId, rows);
}

/**
 * One entity type's events, as the system, with every redaction applied — the
 * part `readEntityTimeline` and `readEntityTimelines` share. `ok` is false when
 * the read did not answer (an error, or an answer with no rows array, which is
 * not "nothing happened": T-null-answer-guard); the rows are then empty.
 */
async function readSource(
  orgId: string,
  viewerRole: string,
  source: {
    entityType: TimelineEntityType;
    entityIds: readonly string[];
    limit: number;
    excludeEventTypes?: readonly string[];
  },
): Promise<{ rows: TimelineRow[]; ok: boolean }> {
  if (source.entityIds.length === 0) return { rows: [], ok: true };
  /*
   * An org is REQUIRED, and refusing here rather than trusting callers is the
   * point: on a service-role client `org_id` is the only boundary there is, and
   * a caller that derived it from an empty array would pass "" without
   * noticing. Loudly nothing, never quietly everything.
   */
  if (!orgId) {
    console.error("timeline read refused: no org", { entityType: source.entityType });
    return { rows: [], ok: false };
  }

  let query = createAdminClient()
    .from("events")
    .select("id, occurred_at, event_type, entity_type, entity_id, actor_id, payload")
    // EXPLICIT — the admin client bypasses RLS, so this is the only org boundary
    .eq("org_id", orgId)
    .eq("entity_type", source.entityType)
    .in("entity_id", source.entityIds as string[]);
  // In the QUERY, not after it: a lead's delivery telemetry (an alert retried
  // through its backoff, an escalation chain) would otherwise fill the limit
  // with rows the feed then drops.
  if (source.excludeEventTypes && source.excludeEventTypes.length > 0) {
    query = query.not("event_type", "in", `(${source.excludeEventTypes.join(",")})`);
  }
  const { data, error } = await query
    .order("occurred_at", { ascending: false })
    // events of one transaction share occurred_at (a close writes won_override
    // and won together, 0117); within an org, id order is chain order (0109)
    .order("id", { ascending: false })
    .limit(source.limit);

  // A timeline that silently shows nothing is indistinguishable from a record
  // nothing has happened to — the failure this whole day's work was about. A
  // read that failed says so in the log rather than rendering as an empty
  // history; the caller keeps its page (and `readEntityTimelines` reports it).
  if (error || !Array.isArray(data)) {
    console.error("timeline read failed:", {
      entityType: source.entityType,
      count: source.entityIds.length,
      error: error ? error.message : "the answer held no rows",
    });
    return { rows: [], ok: false };
  }
  const rows = await attachNotes(data as unknown as TimelineRow[], orgId);
  const redacted = redactSlipSigners(
    redactWonDealKinds(redactDocumentTitles(rows, viewerRole), viewerRole),
    viewerRole,
  );
  return { rows: redacted, ok: true };
}

/**
 * Newest first; events at the same instant in chain order (newest id first).
 * Negative when `a` is the newer. The order the reader asks Postgres for, so a
 * merge of several sources reads exactly like one source would.
 *
 * Compared as instants first — PostgREST prints a timestamptz with as many
 * fractional digits as it has, so two strings of different length are not
 * always in text order — then as text (the sub-millisecond digits), then by id.
 */
export function compareNewestFirst(
  a: { occurred_at: string; id: string | number },
  b: { occurred_at: string; id: string | number },
): number {
  const ta = Date.parse(a.occurred_at);
  const tb = Date.parse(b.occurred_at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? 1 : -1;
  const ia = Number(a.id);
  const ib = Number(b.id);
  if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ib - ia;
  const sa = String(a.id);
  const sb = String(b.id);
  return sa === sb ? 0 : sa < sb ? 1 : -1;
}

/** A row of a combined feed: the author's name, when the viewer may read it. */
export type TimelineFeedRow = TimelineRow & {
  /** `profiles.full_name` of `actor_id`, read as the viewer; null for the system or an unreadable profile */
  actor_name: string | null;
};

export interface EntityTimelines {
  /** newest first, at most `limit` */
  rows: TimelineFeedRow[];
  /**
   * A source's read did not answer, so some of this history is missing. The
   * page must SAY so: the rows alone would read as a record with less history
   * than it has — a zero standing in for unavailable data.
   */
  incomplete: boolean;
  /** older events exist than the ones returned (a source reached its cap, or the merge was cut to `limit`) */
  truncated: boolean;
}

/**
 * Lead delivery telemetry: the enquiry alert's sends and retries and the
 * escalation's mails (0101–0112). Facts about the OFFICE's mailbox, already on
 * the inbox's chips, with no timeline line of their own — on a customer's
 * history they are noise between the calls, and a retry chain would fill a
 * source's cap.
 */
export const CUSTOMER_FEED_SKIPPED_TYPES = ["enquiry_alert", "lead_escalation"] as const;

/**
 * Several records' histories as ONE feed: a contact with its leads, deals and
 * viewings; a deal with its offers; a property with its keys and viewings.
 *
 * Each source is read exactly as `readEntityTimeline` reads one — as the
 * system, org-bound, with the notes join and every redaction — so the same
 * contract holds: every id in every source must have come back from a query
 * on the CALLER's client. A source with no ids asks nothing.
 *
 * THE MERGE IS HONEST ABOUT ITS EDGES. Each source is capped at `perSource`,
 * and a capped source may hold older rows the merge never saw. So rows older
 * than the newest "oldest row" among the capped sources are dropped rather
 * than shown out of context — otherwise a quiet source's year-old line would
 * sit where a busy source's missing lines belong. Then the newest `limit`
 * remain, and `truncated` says older events exist.
 *
 * Then, once for the whole page and as the VIEWER: the current task / document
 * titles and a viewing's current feedback (`attachCurrentTitles`), and the
 * authors' names from `profiles` (org-readable, `profiles_select`).
 */
export async function readEntityTimelines(opts: {
  /** the caller's org, from their own profile — never from user input */
  orgId: string;
  /** the VIEWER's role — decides the redactions (document titles, won deals, slip signers) */
  viewerRole: string;
  /** The VIEWER's own client — as readEntityTimeline's. Never the admin client. */
  viewer: SupabaseClient<Database>;
  /** ids the CALLER already read through RLS, by entity type */
  sources: readonly { entityType: TimelineEntityType; entityIds: readonly string[] }[];
  /** cap per source */
  perSource: number;
  /** cap on the merged feed */
  limit: number;
  /** event types left out of every source, in the query */
  excludeEventTypes?: readonly string[];
}): Promise<EntityTimelines> {
  const reads = await Promise.all(
    opts.sources
      .filter((s) => s.entityIds.length > 0)
      .map((s) =>
        readSource(opts.orgId, opts.viewerRole, {
          entityType: s.entityType,
          entityIds: s.entityIds,
          limit: opts.perSource,
          excludeEventTypes: opts.excludeEventTypes,
        }),
      ),
  );
  const incomplete = reads.some((r) => !r.ok);

  // the newest of the capped sources' oldest rows: below it, a capped source
  // may be missing lines
  let floor: TimelineRow | null = null;
  for (const r of reads) {
    if (!r.ok || r.rows.length < opts.perSource || r.rows.length === 0) continue;
    const oldest = r.rows[r.rows.length - 1];
    if (!floor || compareNewestFirst(oldest, floor) < 0) floor = oldest;
  }

  const seen = new Set<string>();
  const merged = reads
    .flatMap((r) => r.rows)
    .filter((r) => {
      const key = String(r.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareNewestFirst);
  const edge = floor;
  const kept = edge ? merged.filter((r) => compareNewestFirst(r, edge) <= 0) : merged;
  const truncated = edge !== null || kept.length > opts.limit;
  const page = kept.slice(0, opts.limit);

  const [titled, names] = await Promise.all([
    attachCurrentTitles(opts.viewer, opts.orgId, page),
    readActorNames(opts.viewer, opts.orgId, page),
  ]);
  return {
    rows: titled.map((r) => ({ ...r, actor_name: r.actor_id ? (names.get(r.actor_id) ?? null) : null })),
    incomplete,
    truncated,
  };
}

/**
 * The authors' names, read as the VIEWER (`profiles_select` is org-wide, so
 * this discloses nothing a staff member cannot already read). A failed read
 * leaves the names off — the line still reads, and a person is never shown
 * as "system".
 */
async function readActorNames(
  viewer: SupabaseClient<Database>,
  orgId: string,
  rows: readonly TimelineRow[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [
    ...new Set(rows.map((r) => r.actor_id).filter((v): v is string => typeof v === "string" && v !== "")),
  ];
  if (ids.length === 0 || !orgId) return names;
  const { data, error } = await viewer.from("profiles").select("id, full_name").eq("org_id", orgId).in("id", ids);
  if (error || !Array.isArray(data)) {
    console.error("timeline author read failed:", { count: ids.length, error: error ? error.message : "no rows" });
    return names;
  }
  for (const p of data) {
    if (typeof p.full_name === "string" && p.full_name.trim()) names.set(p.id, p.full_name);
  }
  return names;
}

/**
 * A logged conversation's words come from `interaction_notes`, not the event
 * (0094, audit SEC-03).
 *
 * Until 2026-09-13 the note went into the hash-chained, never-updated event
 * payload verbatim — so an Article 17 erasure left every word the desk had
 * written about the person readable for ever — and nothing rendered it: the
 * line said "Conversation logged (phone)" and the text sat in the chain unseen.
 * The event now carries `note_id` and a digest; this joins the row, org-bound
 * because the admin client has no other boundary, and attaches the body as the
 * line's `note`. A blanked row says so rather than showing nothing, and an
 * event written before 0094 still carries its note inline and renders as it
 * did. No lookup at all when nothing on the page references a note.
 */
const NOTE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The payload's `note_id` as a LOWERCASED uuid, or null — event-context.ts's
 * `payloadId` rule. A session may write any payload (events_insert checks only
 * the organisation and the actor), and Postgres refuses a whole `.in()` read
 * for ONE malformed uuid (22P02): every note body on the timeline vanished
 * while that event was in the latest 50. Lowercased, because Postgres returns
 * a row's id in lower case and the lookup below matches on it.
 */
function noteIdOf(p: Record<string, unknown>): string | null {
  return typeof p.note_id === "string" && NOTE_UUID.test(p.note_id) ? p.note_id.toLowerCase() : null;
}

async function attachNotes(rows: TimelineRow[], orgId: string): Promise<TimelineRow[]> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.event_type !== "conversation_logged") continue;
    const id = noteIdOf((r.payload ?? {}) as Record<string, unknown>);
    if (id) ids.add(id);
  }
  const bodies = new Map<string, string | null>();
  if (ids.size > 0) {
    const { data, error } = await createAdminClient()
      .from("interaction_notes")
      .select("id, body, redacted_at")
      // EXPLICIT — the admin client bypasses RLS, so this is the only org boundary
      .eq("org_id", orgId)
      .in("id", [...ids]);
    if (error) {
      console.error("timeline notes read failed:", { count: ids.size, error: error.message });
    }
    for (const n of data ?? []) {
      bodies.set(n.id, n.body ?? (n.redacted_at ? NOTE_ERASED_LABEL : null));
    }
  }
  return rows.map((r) => {
    if (r.event_type !== "conversation_logged") return r;
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const noteId = noteIdOf(p);
    // a note_id that is not a uuid shows no note — and costs no other line its own
    const note =
      typeof p.note_id === "string"
        ? noteId
          ? (bodies.get(noteId) ?? null)
          : null
        : typeof p.note === "string"
          ? p.note
          : null;
    return note ? { ...r, note } : r;
  });
}

/** The two event types whose OLDER payloads carry a document's title. */
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
 * But the upload filed an event on the CONTACT — a type this reader returns
 * org-wide — whose payload carried the title, and `describeEvent` printed that
 * title verbatim (until T-event-typed-text-shape, below). The title defaults to
 * the uploaded FILE NAME. So showing the
 * whole history without this step would put "Document uploaded —
 * passport_AB123456.pdf" on every agent's and listing manager's screen, and
 * undo three layers of enforcement with a line of prose.
 *
 * `visibility` decides it — the column the POLICY itself tests — carried in the
 * payload, because a lookup would fail for `document_deleted` where the row is
 * already gone.
 *
 * IT USED TO INFER THIS FROM `doc_type`, AND THAT WAS WRONG. The argument was
 * that `contactDocVisibility` maps exactly the KYC types to `admin_only` and the
 * 0072 CHECK enforces it in the database, so a doc_type outside that list could
 * not be an admin-only row. The CHECK does not say that. It forbids a KYC
 * contact row from being anything BUT admin_only; it says nothing about other
 * types. And one writer produces exactly the excluded case:
 * `lib/actions/reports.ts` inserts a commission evidence report with
 * `doc_type: 'evidence_report'` and `visibility: profile.role === 'admin' ?
 * 'admin_only' : 'internal'`. `contactDocVisibility('evidence_report')` returns
 * 'internal', so the redactor waved through the title of a document
 * `documents_select` forbids the reader from opening — and that title is
 * "Commission evidence — <contact name> — <date>".
 *
 * The general lesson, since this is the second time on this function: infer a
 * permission from the column the policy tests, not from a second column that
 * usually correlates with it.
 *
 * ANYTHING BUT AN EXPLICIT 'internal' FAILS CLOSED, including a payload with no
 * `visibility` at all — every document event written before 2026-09-08. The
 * renderer has an untitled branch ("Document uploaded"), so those events still
 * appear and only the name is withheld, permanently and correctly: the row is
 * gone and nothing left can say what it was allowed to be. Measured before
 * choosing this: production holds three `document_deleted` events, all predating
 * the field, and zero `document_uploaded` — so failing closed costs three lines
 * that were already anonymous.
 *
 * SINCE T-event-typed-text-shape (2026-09-24) NO NEW EVENT CARRIES A TITLE, and
 * `describeEvent` prints none from any payload, old or new: a live document's
 * name comes from its row, read as the viewer (`attachCurrentTitles`, which
 * `documents_select` gates exactly as this function tries to). This step stays
 * as a second lock on the older payloads that still hold one, so that nothing
 * downstream of this reader can print what the viewer may not read.
 */
function redactDocumentTitles(rows: TimelineRow[], viewerRole: string): TimelineRow[] {
  if (viewerRole === "admin") return rows;
  return rows.map((r) => {
    if (!DOCUMENT_EVENTS.has(r.event_type)) return r;
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    if (payload.title === undefined) return r;
    // Only an explicit 'internal' proves the reader may see it. Anything else —
    // 'admin_only', a shape we do not recognise, or an older payload that
    // carries no visibility at all — withholds the title.
    if (payload.visibility === "internal") return r;
    // rebuilt without `title`, rather than destructured — the eslint config has
    // no ignore pattern for a discarded binding, and a lint warning parked in
    // the redaction path is the last place to leave noise
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) if (k !== "title") rest[k] = v;
    return { ...r, payload: rest as TimelineRow["payload"] };
  });
}

/** The two names a signed viewing slip's event carries (viewing-slips.ts, 0082). */
const SLIP_NAME_KEYS = new Set(["signer_name", "second_attendee"]);

/**
 * A SIGNED SLIP'S NAMES ARE THE SLIP'S, NOT THE VIEWING'S.
 *
 * `signViewingSlip` writes `viewing_slip_signed` on the VIEWING with
 * `signer_name` and, when one attended, `second_attendee` — the hash-chained
 * copy is the integrity claim (0082), so it stays in the chain. The line
 * prints the signer ("Viewing slip signed by …").
 *
 * `viewings_select` is org-wide, so a viewing's events reach every staff
 * member's contact feed; `viewing_slips_select` is not — it admits an admin or
 * the viewing's own agent (0100). Read as the system and rendered as stored,
 * the feed would hand a colleague's buyer's signature name to every agent and
 * listing manager who opens the contact.
 *
 * So for anyone but an admin both names go, and the line falls back to its
 * neutral "Viewing slip signed". The viewing's own agent loses the name here
 * too — resolving per-row agency would be a second query per event, and they
 * read the slip itself on the viewing page. Keyed by event TYPE, not entity:
 * any org member may insert any payload (0071), and a crafted event on a
 * contact must not print a name either.
 */
function redactSlipSigners(rows: TimelineRow[], viewerRole: string): TimelineRow[] {
  if (viewerRole === "admin") return rows;
  return rows.map((r) => {
    if (r.event_type !== "viewing_slip_signed") return r;
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    if (typeof payload !== "object" || Array.isArray(payload)) return r;
    if (!Object.keys(payload).some((k) => SLIP_NAME_KEYS.has(k))) return r;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) if (!SLIP_NAME_KEYS.has(k)) rest[k] = v;
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
 * ...but `listing_status_check` has TWO raisers and only one of them names a deal.
 *
 * `markDealWon` writes `{kind, task_id, deal_id}` and renders "the deal was won
 * but the listing still reads on-market" — a `deals_select` fact, withheld.
 * Converting a hold writes `{kind, task_id, reservation_id}` and renders "the
 * reservation converted to a sale but the listing still reads on-market" — a
 * `reservations_select` fact, and that policy is plain `org_id =
 * current_org_id()` with no role arm, so every staff member may already read it.
 * The SAME action also writes an unredacted `reservation_status_changed` event
 * that prints "Reservation held → converted" one line above it. Withholding the
 * second sentence therefore protects nothing and costs the desk the only line
 * that says why the follow-up exists.
 *
 * `deal_id` is the discriminator, not `reservation_id`: `raiseLiveHoldCheck`
 * carries BOTH, and `reservation_still_live` always names a won deal, so it stays
 * withheld unconditionally. `describeEvent` splits the same two sentences on
 * `p.reservation_id`; this splits on the field whose presence is what actually
 * makes the line a disclosure.
 */
function namesAWonDeal(kind: string, payload: Record<string, unknown>): boolean {
  if (!WON_DEAL_KINDS.has(kind)) return false;
  if (kind === "listing_status_check") return payload.deal_id != null;
  return true;
}

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
    if (typeof payload.kind !== "string" || !namesAWonDeal(payload.kind, payload)) return r;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k !== "kind" && k !== "deal_id") rest[k] = v;
    }
    return { ...r, payload: rest as TimelineRow["payload"] };
  });
}
