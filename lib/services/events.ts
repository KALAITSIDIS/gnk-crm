import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

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

/** Write one event row. Throws on failure — mutations must not silently lose their event. */
export async function logEvent(supabase: Client, params: LogEventParams): Promise<void> {
  const { error } = await supabase.from("events").insert({
    org_id: params.orgId,
    actor_id: params.actorId ?? null,
    entity_type: params.entityType,
    entity_id: params.entityId ?? null,
    event_type: params.eventType,
    payload: params.payload ?? {},
  });
  if (error) {
    throw new Error(`logEvent failed (${params.entityType}.${params.eventType}): ${error.message}`);
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
  document_uploaded: (p, t) => {
    const title = asText(p.title);
    return title ? t("documentUploadedTitle", { title }) : t("documentUploaded");
  },
  document_deleted: (p, t) => {
    const title = asText(p.title);
    return title ? t("documentDeletedTitle", { title }) : t("documentDeleted");
  },
  renewal_task_created: (_p, t) => t("renewalTaskCreated"),
  route_updated: (p, t) => {
    const count = Number(p.stops) || 0;
    const date = asText(p.route_date);
    return date ? t("routeUpdatedDate", { count, date }) : t("routeUpdated", { count });
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
