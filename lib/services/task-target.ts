/**
 * Where a task row, or a lead row, points (A01).
 *
 * A reminder the desk cannot act on in one click is a reminder it learns to
 * ignore. Until A01 the dashboard linked every task to `/tasks` and every lead
 * to `/leads` — a list page, one tap further from the work than the row
 * itself — and `/tasks` linked only viewing, deal and contact tasks. Lead,
 * reservation, instalment and mandate reminders had no link at all.
 *
 * ONE pure function decides, so the dashboard and `/tasks` can never send the
 * same row to two different places.
 *
 * THE RULE: a known task kind goes to the page where the thing it asks for is
 * DONE (feedback is logged on the viewing; a hold, an instalment, a mandate and
 * the keys are handled on the property, on their own tab; a matched buyer list
 * is the property's Matching buyers tab; an unanswered enquiry is answered in
 * the lead inbox, because there is no lead page yet — BACKLOG "/leads/[id]").
 * A task with no kind (typed by a person) or a kind this file does not know
 * falls back to its link columns in a fixed order. With no link at all it
 * stays on `/tasks`.
 *
 * Every href is built from a uuid column the caller read under its own RLS —
 * no user text reaches a URL.
 */

/**
 * Every `task_kinds` row the migrations seed (0049 and later). A kind added by
 * a migration must be added here AND given a label in `dashboard.myDay.kind.*`
 * — `task-target.test.ts` reads the migrations and fails until both are done.
 */
export const TASK_KINDS = [
  "mandate_renewal",
  "deal_no_contact",
  "viewing_feedback",
  "price_drop_match",
  "new_listing_match",
  "reservation_expiring",
  "bulk_price_drop_match",
  "installment_due",
  "key_recall",
  "viewing_no_show",
  "listing_status_check",
  "retention_expired",
  "reservation_still_live",
  "lead_unanswered",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export function isTaskKind(kind: string | null | undefined): kind is TaskKind {
  return typeof kind === "string" && (TASK_KINDS as readonly string[]).includes(kind);
}

/**
 * The columns `taskTarget` reads. Select them with this constant (it is a
 * literal type, so postgrest-js still types the row): a select that forgot one
 * would silently send its tasks somewhere else.
 */
export const TASK_LINK_COLUMNS =
  "kind, viewing_id, deal_id, contact_id, lead_id, property_id, reservation_id, installment_id, mandate_id" as const;

export interface TaskLinks {
  kind: string | null;
  viewing_id: string | null;
  deal_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  property_id: string | null;
  reservation_id: string | null;
  installment_id: string | null;
  mandate_id: string | null;
}

export type TaskTargetType = "viewing" | "deal" | "contact" | "property" | "leads" | "tasks";

export interface TaskTarget {
  type: TaskTargetType;
  href: string;
}

/**
 * The property page's tabs a task can open on (`?tab=`, app/(app)/properties/
 * [id]/page.tsx PROPERTY_TABS). An unknown tab opens Overview there, so a
 * renamed tab degrades to the right page, never to a 404.
 */
type PropertyTab = "mandate" | "reservation" | "buyers";

type Subject =
  | { type: "viewing" }
  | { type: "deal" }
  | { type: "contact" }
  | { type: "leads" }
  | { type: "property"; tab?: PropertyTab };

/** Each kind's subject: the page where the thing the task asks for is done. */
const KIND_SUBJECT: Record<TaskKind, Subject> = {
  // log the feedback / rebook the buyer: both are actions on the viewing
  viewing_feedback: { type: "viewing" },
  viewing_no_show: { type: "viewing" },
  // log contact on the deal — that is what clears the nudge (0025)
  deal_no_contact: { type: "deal" },
  // the erased contact's record carries the retention review
  retention_expired: { type: "contact" },
  // the response is logged in the inbox, which stops the clock
  lead_unanswered: { type: "leads" },
  // renew the mandate / return the keys: the Mandate & Keys tab
  mandate_renewal: { type: "property", tab: "mandate" },
  key_recall: { type: "property", tab: "mandate" },
  // extend, convert or release the hold; mark the instalment paid
  reservation_expiring: { type: "property", tab: "reservation" },
  installment_due: { type: "property", tab: "reservation" },
  reservation_still_live: { type: "property", tab: "reservation" },
  // the listing's own status, edited on the property — not the deal the win
  // came from, although these rows carry its id too
  listing_status_check: { type: "property" },
  // the buyers the price change brought into range
  price_drop_match: { type: "property", tab: "buyers" },
  new_listing_match: { type: "property", tab: "buyers" },
  bulk_price_drop_match: { type: "property", tab: "buyers" },
};

function propertyHref(id: string, tab?: PropertyTab): string {
  return tab ? `/properties/${id}?tab=${tab}` : `/properties/${id}`;
}

/** The subject's page, or null when the row lacks the id that page needs. */
function hrefFor(subject: Subject, t: TaskLinks): string | null {
  switch (subject.type) {
    case "viewing":
      return t.viewing_id ? `/viewings/${t.viewing_id}` : null;
    case "deal":
      return t.deal_id ? `/deals/${t.deal_id}` : null;
    case "contact":
      return t.contact_id ? `/contacts/${t.contact_id}` : null;
    case "leads":
      return t.lead_id ? "/leads" : null;
    case "property":
      return t.property_id ? propertyHref(t.property_id, subject.tab) : null;
  }
}

/**
 * The record a task opens.
 *
 * Fallback order for a task with no (known) kind, or whose kind's subject id
 * is gone: viewing → deal → contact → lead → property → `/tasks`. A person can
 * link a task to exactly one of property, contact or deal (add-task-dialog), so
 * for typed tasks the order never has to choose.
 */
export function taskTarget(t: TaskLinks): TaskTarget {
  if (isTaskKind(t.kind)) {
    const subject = KIND_SUBJECT[t.kind];
    const href = hrefFor(subject, t);
    if (href) return { type: subject.type, href };
  }
  if (t.viewing_id) return { type: "viewing", href: `/viewings/${t.viewing_id}` };
  if (t.deal_id) return { type: "deal", href: `/deals/${t.deal_id}` };
  if (t.contact_id) return { type: "contact", href: `/contacts/${t.contact_id}` };
  if (t.lead_id) return { type: "leads", href: "/leads" };
  if (t.property_id) {
    const tab: PropertyTab | undefined = t.mandate_id
      ? "mandate"
      : t.reservation_id || t.installment_id
        ? "reservation"
        : undefined;
    return { type: "property", href: propertyHref(t.property_id, tab) };
  }
  return { type: "tasks", href: "/tasks" };
}

/**
 * Where a lead row on the dashboard opens.
 *
 * An UNANSWERED lead opens the inbox: that is where the first response is
 * logged and its clock stops (lib/actions/leads.ts), and the contact page has
 * no lead actions. Once answered, the person's record is the more useful page
 * — when the lead has one. There is no `/leads/[id]` (BACKLOG), so everything
 * else is the inbox.
 */
export function leadTarget(lead: {
  contact_id: string | null;
  first_response_at: string | null;
}): { type: "contact" | "leads"; href: string } {
  if (lead.first_response_at && lead.contact_id) {
    return { type: "contact", href: `/contacts/${lead.contact_id}` };
  }
  return { type: "leads", href: "/leads" };
}
