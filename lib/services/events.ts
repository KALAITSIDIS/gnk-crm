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

const fromTo = (verb: string, p: P): string => {
  const from = asText(p.from);
  const to = asText(p.to);
  return from && to ? `${verb} ${from} → ${to}` : verb;
};

const EVENT_LINES: Record<string, (p: P) => string> = {
  created: (p) => {
    const amount = asMoney(p.amount);
    return amount ? `Created — ${amount}` : "Created";
  },
  updated: (p) => {
    const section = asText(p.section);
    return section ? `Updated — ${section.replace(/_/g, " ")}` : "Updated";
  },
  stage_changed: (p) => fromTo("Stage", p),
  status_changed: (p) => {
    const line = fromTo("Status", p);
    const amount = asMoney(p.amount);
    return amount ? `${line} (${amount})` : line;
  },
  won: (p) => (p.override === true ? "Marked won — admin override" : "Marked won"),
  won_override: () => "Admin override authorized — no accepted offer",
  lost: (p) => {
    const reason = asText(p.reason);
    return reason ? `Marked lost — ${reason}` : "Marked lost";
  },
  spam: () => "Marked spam",
  claimed: () => "Claimed",
  contacted: () => "Marked contacted",
  called: () => "Marked called",
  conversation_logged: (p) => {
    const channel = asText(p.channel);
    return channel ? `Conversation logged (${channel})` : "Conversation logged";
  },
  chat_link_opened: (p) => {
    const channel = asText(p.channel);
    return channel ? `Chat opened (${channel})` : "Chat opened";
  },
  converted: () => "Converted to deal",
  viewing_slip_signed: (p) => {
    const name = asText(p.signer_name);
    return name ? `Viewing slip signed by ${name}` : "Viewing slip signed";
  },
  key_checkout: (p) => {
    const code = asText(p.key_code);
    const holder = asText(p.holder);
    return `Key${code ? ` ${code}` : ""} checked out${holder ? ` to ${holder}` : ""}`;
  },
  key_return: (p) => {
    const code = asText(p.key_code);
    return `Key${code ? ` ${code}` : ""} returned to office`;
  },
  document_uploaded: (p) => {
    const title = asText(p.title);
    return title ? `Signed document uploaded — ${title}` : "Signed document uploaded";
  },
  renewal_task_created: () => "Renewal reminder task created",
  route_updated: (p) => {
    const stops = Number(p.stops) || 0;
    const date = asText(p.route_date);
    return `Day route updated — ${stops} stop${stops === 1 ? "" : "s"}${date ? ` (${date})` : ""}`;
  },
  viewing_feedback: (p) => {
    const rating = Number(p.rating);
    const stars = Number.isFinite(rating) && rating > 0 ? ` ${"★".repeat(rating)}` : "";
    const note = asText(p.comment) ?? asText(p.liked);
    return `Viewing feedback${stars}${note ? ` — ${note}` : ""}`;
  },
  merged: (p) => {
    const name = asText(p.merged_contact_name);
    return name ? `Merged in ${name}` : "Merged in a duplicate";
  },
  archived: () => "Archived",
  media_uploaded: (p) => {
    const file = asText(p.file);
    return file ? `Photo uploaded — ${file}` : "Photo uploaded";
  },
  media_deleted: () => "Photo deleted",
  // written by the price_history DB trigger (T1.7); from/to are numeric
  price_changed: (p) => {
    const from = asMoney(p.from);
    const to = asMoney(p.to);
    return from && to ? `Price ${from} → ${to}` : "Price changed";
  },
  media_reordered: () => "Photos reordered",
  media_cover_set: () => "Cover photo set",
  publish_override: (p) =>
    `Publish gate overridden (score ${Number(p.score) || 0} < ${Number(p.threshold) || 0})`,
  payment_plan_created: () => "Payment plan created",
  price_list_created: () => "Price list created",
};

/** Entity prefixes for feeds that mix entities (deal page merges offer events). */
const ENTITY_PREFIX: Partial<Record<string, string>> = {
  offer: "Offer",
};

export function describeEvent(
  e: Pick<TimelineEvent, "entity_type" | "event_type" | "payload">,
): string {
  const p = asObject(e.payload);
  const line = EVENT_LINES[e.event_type]?.(p) ?? e.event_type.replace(/_/g, " ");
  const prefix = ENTITY_PREFIX[e.entity_type];
  return prefix ? `${prefix}: ${line}` : line;
}
