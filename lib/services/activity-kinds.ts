import type { Json } from "@/lib/supabase/database.types";

/**
 * Which filter of an Activity feed a timeline event belongs to (A06).
 *
 * A pure function of the event, so the feed can be filtered in the browser
 * without asking anything again and the rule is testable on its own. Five
 * kinds, checked in this order — the first that fits wins:
 *
 * - `communication`: what was done WITH the person — a logged conversation, a
 *   call, a "contacted" stamp, and a chat-link click. The click is here
 *   because it is the desk reaching for the person, but it is never a logged
 *   contact (`isLoggedContact`): its line says "link click only", and it
 *   stamps no response clock, closes no SLA task and moves no deal's
 *   last_contact_at.
 * - `viewings`: anything on a viewing, and the viewing lines filed elsewhere
 *   (the feedback and its follow-ups on a property, a slip, a confirmation).
 * - `deals`: anything on a deal or an offer, and the money lines filed on a
 *   property or a lead (a won close, a conversion, reservations, instalments).
 * - `system`: what no person did — written with no actor (a cron, a sweep,
 *   the website's enquiry door) and not one of the above.
 * - `changes`: the rest — edits, assignments, documents, requirements.
 */
export const ACTIVITY_KINDS = ["communication", "viewings", "deals", "changes", "system"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Contact the desk RECORDED having with the person — the summary's "Last contact". */
export const LOGGED_CONTACT_TYPES = ["conversation_logged", "called", "contacted"] as const;

/** Every communication type, the logged ones and the chat-link click. */
export const COMMUNICATION_TYPES = [...LOGGED_CONTACT_TYPES, "chat_link_opened"] as const;

/**
 * True for a contact the desk logged: a conversation, a call, a "contacted"
 * stamp. NOT a chat-link click — opening WhatsApp says nothing about whether a
 * message was sent, let alone read (no messaging API: Do-Not-Build).
 */
export function isLoggedContact(eventType: string): boolean {
  return (LOGGED_CONTACT_TYPES as readonly string[]).includes(eventType);
}

const VIEWING_TYPES = new Set([
  "viewing_feedback",
  "viewing_slip_signed",
  "viewing_confirmation_generated",
  "rescheduled",
]);
/** follow-up kinds that are about a viewing, wherever they were filed */
const VIEWING_FOLLOWUPS = new Set(["viewing_feedback", "viewing_no_show"]);

const DEAL_TYPES = new Set([
  "won",
  "won_override",
  "stage_changed",
  "converted",
  "reservation_created",
  "reservation_extended",
  "reservation_status_changed",
  "reservation_expired",
  "reservation_expiring_soon",
  "reservation_schedule_applied",
  "reservation_schedule_cleared",
  "installment_paid",
  "installment_unpaid",
  "installment_due_changed",
  "installment_due_soon",
]);

const kindOf = (payload: Json | null | undefined): string | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const k = (payload as Record<string, unknown>).kind;
  return typeof k === "string" ? k : null;
};

export function activityKind(e: {
  entity_type: string;
  event_type: string;
  actor_id?: string | null;
  payload?: Json | null;
}): ActivityKind {
  if ((COMMUNICATION_TYPES as readonly string[]).includes(e.event_type)) return "communication";
  if (e.entity_type === "viewing" || VIEWING_TYPES.has(e.event_type)) return "viewings";
  if (e.event_type === "followup_task_created" || e.event_type === "superseded") {
    const k = kindOf(e.payload);
    if (k && VIEWING_FOLLOWUPS.has(k)) return "viewings";
  }
  if (e.entity_type === "deal" || e.entity_type === "offer" || DEAL_TYPES.has(e.event_type)) return "deals";
  if (e.actor_id === null) return "system";
  return "changes";
}
