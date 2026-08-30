import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Append-only event log — the architectural spine (doc 01 §6.2).
 * EVERY mutation in the app calls logEvent(). A feature without its events is
 * not done (CLAUDE.md guardrail 1). Inserts only; the table has no UPDATE or
 * DELETE for any app role, and rows are hash-chained by a DB trigger.
 */

export const ENTITY_TYPES = [
  "organization",
  "user",
  "property",
  "contact",
  "lead",
  "deal",
  "viewing",
  "offer",
  "mandate",
  "key",
  "document",
  "task",
  "config",
  "share_link",
  // org-level, not tied to one row: a bulk CSV export of a list (audit trail)
  "export",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface LogEventParams {
  orgId: string;
  /** profiles.id of the acting user; null/undefined = system action */
  actorId?: string | null;
  entityType: EntityType;
  entityId?: string | null;
  /** e.g. 'created', 'updated', 'stage_changed', 'price_changed', 'viewing_slip_signed' */
  eventType: string;
  payload?: Json;
}

type Client = SupabaseClient<Database>;

const eventRow = (params: LogEventParams) => ({
  org_id: params.orgId,
  actor_id: params.actorId ?? null,
  entity_type: params.entityType,
  entity_id: params.entityId ?? null,
  event_type: params.eventType,
  payload: params.payload ?? {},
});

/** Write one event row. Throws on failure — mutations must not silently lose their event. */
export async function logEvent(supabase: Client, params: LogEventParams): Promise<void> {
  const { error } = await supabase.from("events").insert(eventRow(params));
  if (error) {
    throw new Error(`logEvent failed (${params.entityType}.${params.eventType}): ${error.message}`);
  }
}

/**
 * Write many event rows in ONE statement, for a bulk mutation that creates many
 * entities at once (unit generation). Sixty sequential logEvent calls is sixty
 * round trips, and a failure halfway leaves entities without their events.
 *
 * THE HASH CHAIN SURVIVES A MULTI-ROW INSERT, and that is not obvious enough to
 * assume — `trg_events_hash` reads the latest row to build `prev_hash`, so it
 * only works if each row is visible to the next row's trigger. Postgres fires
 * BEFORE ROW triggers per tuple as the executor walks them, so it is. Measured
 * on the local stack before this function was written: a 3-row insert produced
 * prev_hash[n] = hash[n-1] throughout and `verify_events_chain` stayed true.
 *
 * Order is preserved, so the events read in the order the entities were made.
 */
export async function logEvents(supabase: Client, events: LogEventParams[]): Promise<void> {
  if (events.length === 0) return;
  const { error } = await supabase.from("events").insert(events.map(eventRow));
  if (error) {
    throw new Error(`logEvents failed (${events.length} rows): ${error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Human-readable timeline lines (T3.5). One entry per event_type;    */
/* unknown types fall back to the raw type with underscores spaced,   */
/* so a new event never breaks a timeline — it just reads plainly     */
/* until its line is registered here.                                 */
/* ------------------------------------------------------------------ */

export interface TimelineEvent {
  id: string | number;
  occurred_at: string;
  entity_type: string;
  event_type: string;
  payload: Json;
  /** caller-supplied annotation, e.g. the merged-contact source name */
  note?: string | null;
}

type P = Record<string, unknown>;

/**
 * A translator scoped to the `events` namespace. Structurally the next-intl
 * `t` you get from `getTranslations("events")` / `useTranslations("events")`;
 * kept as a minimal type so this module stays free of next-intl and unit-
 * testable with a plain function.
 */
export type EventTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

const asObject = (payload: Json | null | undefined): P =>
  payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as P) : {};

const asText = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

const asMoney = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(n);
};

/*
 * Each entry chooses a message key (and its interpolation values) from the
 * payload; the fixed text lives in messages/*.json under `events.*`. Only the
 * template is translated — interpolated data (names, channels, stage names,
 * user-typed reasons, file names, formatted money) stays as stored.
 */
const EVENT_LINES: Record<string, (p: P, t: EventTranslator) => string> = {
  created: (p, t) => {
    const amount = asMoney(p.amount);
    return amount ? t("createdAmount", { amount }) : t("created");
  },
  updated: (p, t) => {
    const section = asText(p.section);
    return section ? t("updatedSection", { section: section.replace(/_/g, " ") }) : t("updated");
  },
  stage_changed: (p, t) => {
    const from = asText(p.from);
    const to = asText(p.to);
    return from && to ? t("stageChange", { from, to }) : t("stage");
  },
  status_changed: (p, t) => {
    const from = asText(p.from);
    const to = asText(p.to);
    const amount = asMoney(p.amount);
    if (from && to) return amount ? t("statusChangeAmount", { from, to, amount }) : t("statusChange", { from, to });
    return amount ? t("statusAmount", { amount }) : t("status");
  },
  won: (p, t) => (p.override === true ? t("wonOverride") : t("won")),
  won_override: (_p, t) => t("wonOverrideAuthorized"),
  lost: (p, t) => {
    const reason = asText(p.reason);
    return reason ? t("lostReason", { reason }) : t("lost");
  },
  spam: (_p, t) => t("spam"),
  claimed: (_p, t) => t("claimed"),
  assigned: (p, t) => {
    const name = asText(p.to_name);
    return name ? t("reassignedTo", { name }) : t("reassigned");
  },
  contact_linked: (p, t) => {
    const name = asText(p.contact_name);
    return name ? t("contactLinkedName", { name }) : t("contactLinked");
  },
  corrected: (p, t) => {
    const reopened = p.reopened === true;
    const reset = p.reset_response === true;
    if (reopened && reset) return t("correctedBoth");
    if (reopened) return t("correctedReopened");
    if (reset) return t("correctedResetResponse");
    return t("corrected");
  },
  contacted: (_p, t) => t("contacted"),
  called: (_p, t) => t("called"),
  conversation_logged: (p, t) => {
    const channel = asText(p.channel);
    return channel ? t("conversationLoggedChannel", { channel }) : t("conversationLogged");
  },
  chat_link_opened: (p, t) => {
    const channel = asText(p.channel);
    return channel ? t("chatOpenedChannel", { channel }) : t("chatOpened");
  },
  converted: (_p, t) => t("converted"),
  viewing_slip_signed: (p, t) => {
    const name = asText(p.signer_name);
    return name ? t("slipSignedBy", { name }) : t("slipSigned");
  },
  key_checkout: (p, t) => {
    const code = asText(p.key_code);
    const holder = asText(p.holder);
    if (code && holder) return t("keyCheckoutCodeHolder", { code, holder });
    if (code) return t("keyCheckoutCode", { code });
    if (holder) return t("keyCheckoutHolder", { holder });
    return t("keyCheckout");
  },
  key_return: (p, t) => {
    const code = asText(p.key_code);
    return code ? t("keyReturnCode", { code }) : t("keyReturn");
  },
  key_transfer: (p, t) => {
    const code = asText(p.key_code);
    const holder = asText(p.holder);
    if (code && holder) return t("keyTransferCodeHolder", { code, holder });
    if (code) return t("keyTransferCode", { code });
    if (holder) return t("keyTransferHolder", { holder });
    return t("keyTransfer");
  },
  key_lost: (p, t) => {
    const code = asText(p.key_code);
    const holder = asText(p.holder);
    if (code && holder) return t("keyLostCodeHolder", { code, holder });
    if (code) return t("keyLostCode", { code });
    if (holder) return t("keyLostHolder", { holder });
    return t("keyLost");
  },
  completed: (p, t) => {
    const title = asText(p.title);
    return title ? t("completedTitle", { title }) : t("completed");
  },
  reopened: (p, t) => {
    const title = asText(p.title);
    return title ? t("reopenedTitle", { title }) : t("reopened");
  },
  invited: (p, t) => {
    const email = asText(p.email);
    const role = asText(p.role);
    const roleClean = role ? role.replace(/_/g, " ") : null;
    if (email && roleClean) return t("invitedEmailRole", { email, role: roleClean });
    if (email) return t("invitedEmail", { email });
    if (roleClean) return t("invitedRole", { role: roleClean });
    return t("invited");
  },
  role_changed: (p, t) => {
    const from = asText(p.from);
    const to = asText(p.to);
    return from && to ? t("roleChange", { from, to }) : t("roleChanged");
  },
  deactivated: (_p, t) => t("deactivated"),
  reactivated: (_p, t) => t("reactivated"),
  // 2FA (C2). Turning a second factor OFF is exactly what an audit needs to see.
  mfa_enrolled: (_p, t) => t("mfaEnrolled"),
  mfa_unenrolled: (_p, t) => t("mfaUnenrolled"),
  stages_updated: (p, t) => {
    const action = asText(p.action) ?? "updated";
    if (action === "rename")
      return t("stageRenamed", { from: asText(p.from) ?? "", to: asText(p.to) ?? "" });
    if (action === "add") return t("stageAdded", { name: asText(p.name) ?? "" });
    if (action === "delete") return t("stageDeleted", { name: asText(p.name) ?? "" });
    if (action === "reorder")
      return t("stageMoved", { stage: asText(p.stage) ?? "", direction: asText(p.direction) ?? "" });
    return t("stagesUpdated");
  },
  locations_updated: (p, t) => {
    const action = asText(p.action);
    if (action === "add_area") return t("areaAdded", { name: asText(p.name) ?? "" });
    if (action === "rename_area")
      return t("areaRenamed", { from: asText(p.from) ?? "", to: asText(p.to) ?? "" });
    return t("locationsUpdated");
  },
  evidence_report_generated: (p, t) =>
    t("evidenceGenerated", { count: Number(p.rows) || 0, ok: p.chain_ok === true ? "yes" : "no" }),
  viewing_confirmation_generated: (_p, t) => t("viewingConfirmationGenerated"),
  document_uploaded: (p, t) => {
    const title = asText(p.title);
    return title ? t("documentUploadedTitle", { title }) : t("documentUploaded");
  },
  document_deleted: (p, t) => {
    const title = asText(p.title);
    return title ? t("documentDeletedTitle", { title }) : t("documentDeleted");
  },
  renewal_task_created: (_p, t) => t("renewalTaskCreated"),
  // 0053: the mandate ended and the agency still holds keys. Written against
  // the MANDATE, like renewal_task_created — it is a fact about the contract
  // ending, and that is the timeline a dispute reads.
  key_recall_task_created: (p, t) =>
    t("keyRecallTaskCreated", { count: Number(p.keys) || 0 }),
  // Price-drop alert: the first push use of the matching engine. Fired by the
  // property save, not by a cron, because the rules live in TypeScript.
  price_drop_matched: (p, t) =>
    t("priceDropMatched", { count: Number(p.buyers) || 0 }),
  // The mirror: the property came onto the market rather than changing price.
  new_listing_matched: (p, t) =>
    t("newListingMatched", { count: Number(p.buyers) || 0 }),
  // 0047's nightly warning, actor-null: written by warn_expiring_reservations()
  reservation_expiring_soon: (p, t) =>
    t("reservationExpiringSoon", { days: Number(p.days) || 2 }),
  // 0048: a block reprice, aggregated into one alert against the project
  bulk_price_drop_matched: (p, t) =>
    t("bulkPriceDropMatched", { count: Number(p.buyers) || 0 }),
  // 0050 payment schedules. Amounts are frozen at apply time, so the event
  // records what was quoted rather than what a later price would say.
  reservation_schedule_applied: (p, t) => {
    const plan = asText(p.plan);
    // `amount`, not `total`: `total` is already the availability-link UNIT COUNT
    // in this namespace, and one placeholder name cannot mean a number in one
    // string and money in another — SAMPLE_PARAMS can only hold one value for it.
    const amount = asMoney(p.total);
    return plan && amount
      ? t("scheduleAppliedPlan", { plan, amount })
      : t("scheduleApplied", { count: Number(p.lines) || 0 });
  },
  reservation_schedule_cleared: (_p, t) => t("scheduleCleared"),
  installment_paid: (p, t) => {
    const label = asText(p.label);
    const amount = asMoney(p.amount);
    if (label && amount) return t("installmentPaidLabelAmount", { label, amount });
    return label ? t("installmentPaidLabel", { label }) : t("installmentPaid");
  },
  installment_unpaid: (p, t) => {
    const label = asText(p.label);
    return label ? t("installmentUnpaidLabel", { label }) : t("installmentUnpaid");
  },
  // 0051's nightly chase, actor-null: written by remind_due_installments().
  // `days` is SIGNED — negative means the line is already overdue — so the sign
  // picks the string and the message always states a positive number of days.
  installment_due_soon: (p, t) => {
    const label = asText(p.label) ?? "";
    const days = Number(p.days);
    if (!Number.isFinite(days)) return t("installmentDueSoon", { days: 0, label });
    return days < 0
      ? t("installmentOverdue", { days: Math.abs(days), label })
      : t("installmentDueSoon", { days, label });
  },
  // 0044 reservations. Written against the PROPERTY, like the nightly sweep:
  // a hold is a fact about the property, which is where a dispute looks.
  reservation_created: (p, t) => {
    const amount = asMoney(p.amount);
    return amount ? t("reservationCreatedAmount", { amount }) : t("reservationCreated");
  },
  reservation_extended: (_p, t) => t("reservationExtended"),
  reservation_status_changed: (p, t) => {
    const from = asText(p.from);
    const to = asText(p.to);
    const reason = asText(p.reason);
    if (from && to) {
      return reason
        ? t("reservationStatusReason", { from, to, reason })
        : t("reservationStatus", { from, to });
    }
    return t("reservationUpdated");
  },
  // actor-null: written by the nightly expire_reservations() sweep, not a user
  reservation_expired: (_p, t) => t("reservationExpired"),
  // 0043 buyer requirements. Written against the CONTACT, not the requirement:
  // ENTITY_TYPES has no `buyer_requirement` member, and the buyer's timeline is
  // where "they started looking for a bigger plot" actually belongs.
  requirement_added: (p, t) => {
    const label = asText(p.label);
    return label ? t("requirementAddedLabel", { label }) : t("requirementAdded");
  },
  requirement_updated: (p, t) => {
    const label = asText(p.label);
    return label ? t("requirementUpdatedLabel", { label }) : t("requirementUpdated");
  },
  requirement_archived: (p, t) => {
    const label = asText(p.label);
    return label ? t("requirementArchivedLabel", { label }) : t("requirementArchived");
  },
  requirement_restored: (p, t) => {
    const label = asText(p.label);
    return label ? t("requirementRestoredLabel", { label }) : t("requirementRestored");
  },
  requirement_deleted: (p, t) => {
    const label = asText(p.label);
    return label ? t("requirementDeletedLabel", { label }) : t("requirementDeleted");
  },
  // B3 buyer proposal links. `opened` is actor-null — the opener is a buyer,
  // not a user — and is throttled to one per link per Cyprus day (0023), so a
  // timeline shows the days a proposal was read, not every refresh.
  //
  // TWO KINDS SHARE THIS EVENT TYPE. 0041's availability branch writes
  // `kind: 'availability'` with unit_count/available_count and deliberately no
  // property_count; a proposal (0023) writes property_count and no kind.
  // Reading property_count unconditionally made a WORKING availability link log
  // "Proposal link opened — 0 properties" — a correct feature reported as
  // broken, which is exactly how an outside review read it. Branch on `kind`,
  // the way followup_task_created below already does.
  opened: (p, t) => {
    if (asText(p.kind) === "availability") {
      return t("shareLinkAvailabilityOpened", {
        available: Number(p.available_count) || 0,
        total: Number(p.unit_count) || 0,
      });
    }
    const count = Number(p.property_count) || 0;
    return t("shareLinkOpened", { count });
  },
  // Shared by BOTH kinds: revokeShareLink always writes views_at_revocation,
  // so this one needs no branch.
  revoked: (p, t) => {
    const views = Number(p.views_at_revocation) || 0;
    return t("shareLinkRevoked", { count: views });
  },
  // B7 follow-up nudges (0020). One event type for both rules; the line is
  // chosen from payload.kind, like stages_updated / locations_updated.
  followup_task_created: (p, t) => {
    const kind = asText(p.kind);
    if (kind === "deal_no_contact") return t("followupNoContact", { days: Number(p.days) || 14 });
    if (kind === "viewing_feedback")
      return t("followupViewingFeedback", { hours: Number(p.hours) || 48 });
    // 0075: the buyer who no-showed is the one most in need of a call
    if (kind === "viewing_no_show") return t("followupViewingNoShow");
    // 0076: a won deal whose listing still reads on-market — a prompt, never
    // an automatic flip (the declined reservation↔status coupling's boundary)
    if (kind === "listing_status_check") return t("followupListingStatusCheck");
    // 0078: the AML retention window closed — surfaced, never auto-purged
    if (kind === "retention_expired") return t("followupRetentionExpired");
    return t("followupTaskCreated");
  },
  // A system task whose condition stopped holding: completed, never deleted, so
  // history keeps its shape. Emitted by expire_mandates since 0012 (and never
  // registered here until 0020 doubled the number of places that write it).
  superseded: (p, t) => {
    const reason = asText(p.reason);
    if (reason === "deal_contacted_or_closed") return t("supersededDealContacted");
    if (reason === "feedback_logged_or_viewing_reopened") return t("supersededFeedbackLogged");
    // 0075: a later viewing for the same buyer+property closes the no-show nag
    if (reason === "viewing_rebooked") return t("supersededViewingRebooked");
    // 0078: the records were destroyed, or the duty was re-dated
    if (reason === "retention_purged_or_changed") return t("supersededRetentionResolved");
    // 0052: a no-contact nudge can now also close because an admin moved the
    // threshold. Before 0052 a moved boundary could only mean contact was
    // logged, so the sweep asserted that; it can no longer assume it.
    if (reason === "threshold_changed") return t("supersededThresholdChanged");
    // 0053: nothing is held any more — the last key went back to the owner, or
    // was marked lost, which also leaves nothing to recall
    if (reason === "keys_returned") return t("supersededKeysReturned");
    // 0047's two reasons: the hold moved, or it stopped being live at all
    if (reason === "reservation_extended") return t("supersededReservationExtended");
    // 0051's three reasons share `reservation_no_longer_live` with 0047, so the
    // KIND has to disambiguate: the same reason string closes a hold-expiry
    // warning and an instalment chase, and they read differently to an agent.
    if (reason === "installment_paid") return t("supersededInstallmentPaid");
    if (reason === "installment_rescheduled") return t("supersededInstallmentRescheduled");
    if (reason === "reservation_no_longer_live") {
      return asText(p.kind) === "installment_due"
        ? t("supersededInstallmentClosed")
        : t("supersededReservationClosed");
    }
    if (p.mandate_id) return t("supersededMandate");
    return t("superseded");
  },
  route_updated: (p, t) => {
    const count = Number(p.stops) || 0;
    const date = asText(p.route_date);
    return date ? t("routeUpdatedDate", { count, date }) : t("routeUpdated", { count });
  },
  // SEC-06: a consent flip is its own exhibit, not a diff key — Art. 7(1)
  consent_changed: (p, t) => (p.to === true ? t("consentGranted") : t("consentWithdrawn")),
  // DB-01: an admin put a sold/rented listing back on the market — its own
  // line (the publish_override idiom), because the flip is externally visible
  // and should never hide inside a generic section save
  status_regression_override: (p, t) => {
    const from = asText(p.from);
    const to = asText(p.to);
    return from && to
      ? t("statusRegressionOverride", { from: from.replace(/_/g, " "), to: to.replace(/_/g, " ") })
      : t("statusRegressionOverrideBare");
  },
  // WF-1: NOT folded into status_changed — that renderer prints raw from/to
  // strings and would show ISO timestamps; this one formats them
  rescheduled: (p, t) => {
    const from = asText(p.from);
    const to = asText(p.to);
    return from && to
      ? t("viewingRescheduled", { from: formatDateTime(from), to: formatDateTime(to) })
      : t("viewingRescheduledBare");
  },
  viewing_feedback: (p, t) => {
    const rating = Number(p.rating);
    const stars = Number.isFinite(rating) && rating > 0 ? "★".repeat(rating) : null;
    const note = asText(p.comment) ?? asText(p.liked);
    if (stars && note) return t("viewingFeedbackStarsNote", { stars, note });
    if (stars) return t("viewingFeedbackStars", { stars });
    if (note) return t("viewingFeedbackNote", { note });
    return t("viewingFeedback");
  },
  merged: (p, t) => {
    const name = asText(p.merged_contact_name);
    return name ? t("mergedName", { name }) : t("merged");
  },
  archived: (_p, t) => t("archived"),
  unarchived: (_p, t) => t("unarchived"),
  erased: (p, t) => {
    const retention = asText(p.retention_until);
    // the retention date is the operator's answer to "what did you keep?"
    return retention ? t("erasedRetention", { retention }) : t("erased");
  },
  // second stage of erasure: the AML retention duty ran out and the KYC
  // documents kept under it were destroyed (B11)
  retention_purged: (p, t) =>
    t("retentionPurged", { count: Number(p.documents_destroyed) || 0 }),
  imported: (p, t) => {
    const ref = asText(p.reference) ?? asText(p.name);
    return ref ? t("importedRef", { ref }) : t("imported");
  },
  media_uploaded: (p, t) => {
    const file = asText(p.file);
    return file ? t("mediaUploadedFile", { file }) : t("mediaUploaded");
  },
  media_deleted: (p, t) => {
    const file = asText(p.file);
    return file ? t("mediaDeletedFile", { file }) : t("mediaDeleted");
  },
  // written by the price_history DB trigger (T1.7); from/to are numeric
  price_changed: (p, t) => {
    const from = asMoney(p.from);
    const to = asMoney(p.to);
    return from && to ? t("priceChange", { from, to }) : t("priceChanged");
  },
  media_reordered: (_p, t) => t("mediaReordered"),
  media_cover_set: (_p, t) => t("mediaCoverSet"),
  publish_override: (p, t) =>
    t("publishOverride", { score: Number(p.score) || 0, threshold: Number(p.threshold) || 0 }),
  payment_plan_created: (_p, t) => t("paymentPlanCreated"),
  price_list_created: (_p, t) => t("priceListCreated"),
  // bulk CSV export of a list; `list` is the list slug (stays as stored, like
  // stage names/channels), `count` the rows written. Filters, if any, live in
  // the payload for the audit record but are not shown on the one-line timeline.
  exported: (p, t) =>
    t("exported", { count: Number(p.count) || 0, list: asText(p.list) ?? "records" }),
};

/** Entity prefixes for feeds that mix entities (deal page merges offer events). */
const ENTITY_PREFIX_KEY: Partial<Record<string, string>> = {
  offer: "offerPrefix",
};

/**
 * Human-readable timeline line for an event. `t` is a translator over the
 * `events` namespace — general-purpose timelines pass the request-locale
 * translator; the commission evidence record passes an English one so the
 * preview matches its deliberately-English PDF.
 */
export function describeEvent(
  e: Pick<TimelineEvent, "entity_type" | "event_type" | "payload">,
  t: EventTranslator,
): string {
  const p = asObject(e.payload);
  const line = EVENT_LINES[e.event_type]?.(p, t) ?? e.event_type.replace(/_/g, " ");
  const prefixKey = ENTITY_PREFIX_KEY[e.entity_type];
  return prefixKey ? `${t(prefixKey)}: ${line}` : line;
}
