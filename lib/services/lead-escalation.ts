/**
 * Escalating a website enquiry nobody has answered (0107; audit 2026-09-22,
 * finding 3 — the e-mail half of the 2026-09-15 audit's trigger T1).
 *
 * WHAT IT IS. The desk alert (0101) says an enquiry ARRIVED; the
 * `lead_unanswered` task (0098) puts it on the assignee's list after an
 * hour. Nothing told anybody ELSE that it was still waiting. Now the
 * `lead-escalation` sweep mints a `lead_escalation` job on the same outbox
 * once a website lead has waited `after_minutes` of WORKING time, and the
 * alert worker sends it to the colleagues the policy names — never to the
 * lead's own assignee, who already has the alert and the task.
 *
 * THE POLICY lives in `cyprus_config.lead_escalation`, SEEDED OFF: the
 * audit proposed fifteen minutes and "the other principal", and neither is
 * an approved decision. Nothing leaves until an admin enables it on
 * Settings → Lead escalation and names at least one recipient.
 *
 * ============================================================================
 * `readLeadEscalation` IS A DELIBERATE SECOND READER of that row, beside
 * `public.lead_escalation_config()` in SQL (0107), and it mirrors that
 * function RULE FOR RULE — the 0052 nudge-thresholds discipline:
 *
 *   | key            | accepted                                   | otherwise      |
 *   |----------------|--------------------------------------------|----------------|
 *   | enabled        | a boolean                                  | false          |
 *   | after_minutes  | an integer 1..1440                          | 15             |
 *   | max_age_hours  | an integer 1..720                           | 48             |
 *   | recipients     | an array; uuid strings kept, de-duplicated | []             |
 *   | working_hours  | {days: ISO 1..7 list (≥1), start < end HH:MM} | null (24/7) |
 *   | timezone       | a zone the platform knows                  | Asia/Nicosia   |
 *
 * lead-escalation.test.ts and supabase/tests/lead-escalation.test.ts run the
 * same table against both. **Change one, change the other and both tables**,
 * or the settings page will show a policy the sweep does not apply.
 * ============================================================================
 */
import { ALERT_FROM, ALERT_TIMEOUT_MS, postProviderEmail, type AlertSendResult } from "@/lib/services/enquiry-alert";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";
import { parseWebsiteEnquiry, websiteEnquiryBody } from "@/lib/services/lead-contact";

export interface WorkingHours {
  /** ISO day numbers, 1 = Monday … 7 = Sunday, ascending, de-duplicated */
  days: number[];
  /** HH:MM, local to `timezone` */
  start: string;
  end: string;
}

export interface LeadEscalationConfig {
  enabled: boolean;
  after_minutes: number;
  /**
   * The activation guard: an enquiry whose working-time wait ENDED more than
   * this many hours ago is left to its task. Counted from the due time, not
   * from arrival (0110) — measured from arrival, the seeded Mon–Fri hours
   * cut off every Friday-evening and weekend enquiry, which were 59+ hours
   * old by the time they were five minutes overdue on Monday morning.
   */
  max_age_hours: number;
  /** profile ids; resolved to active admins/agents of the lead's org at send time */
  recipients: string[];
  /** null = around the clock */
  working_hours: WorkingHours | null;
  timezone: string;
}

export const LEAD_ESCALATION_DEFAULTS: LeadEscalationConfig = {
  enabled: false,
  after_minutes: 15,
  max_age_hours: 48,
  recipients: [],
  working_hours: null,
  timezone: "Asia/Nicosia",
};

/** What the migration seeds (0107): the desk hours the site and the acknowledgement already state. */
export const SEEDED_WORKING_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

/** The SQL guard's bounds; the settings form is deliberately narrower (FORM_BOUNDS). */
const SQL_BOUNDS = { after_minutes: { min: 1, max: 1440 }, max_age_hours: { min: 1, max: 720 } } as const;

/**
 * What the settings form accepts — the operational range, narrower than SQL:
 * SQL only refuses input that would break the sweep, the form refuses input
 * that would be silly. The reader below accepts anything SQL accepts, so a
 * value set through the raw JSON editor still displays as what the sweep
 * actually uses.
 */
export const ESCALATION_FORM_BOUNDS = {
  after_minutes: { min: 5, max: 480 },
  max_age_hours: { min: 1, max: 168 },
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const boundedInt = (v: unknown, b: { min: number; max: number }, fallback: number): number => {
  // the SQL reader reads the JSON value as text and requires plain digits:
  // a number that is an integer, or a string of digits, nothing else
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  if (!/^[0-9]{1,5}$/.test(s)) return fallback;
  const n = Number(s);
  return n >= b.min && n <= b.max ? n : fallback;
};

export function knownTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function readWorkingHours(v: unknown): WorkingHours | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.days) || typeof o.start !== "string" || typeof o.end !== "string") return null;
  if (!HHMM.test(o.start) || !HHMM.test(o.end) || o.start >= o.end) return null;
  const days = [...new Set(o.days.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7))].sort(
    (a, b) => a - b,
  );
  if (days.length === 0) return null;
  return { days, start: o.start, end: o.end };
}

/** Mirrors `public.lead_escalation_config()` — see the header table. */
export function readLeadEscalation(value: unknown): LeadEscalationConfig {
  const d = LEAD_ESCALATION_DEFAULTS;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...d, recipients: [] };
  const v = value as Record<string, unknown>;
  const recipients = Array.isArray(v.recipients)
    ? [...new Set(v.recipients.filter((r): r is string => typeof r === "string" && UUID.test(r)))]
    : [];
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    after_minutes: boundedInt(v.after_minutes, SQL_BOUNDS.after_minutes, d.after_minutes),
    max_age_hours: boundedInt(v.max_age_hours, SQL_BOUNDS.max_age_hours, d.max_age_hours),
    recipients,
    working_hours: readWorkingHours(v.working_hours),
    timezone: knownTimezone(v.timezone) ? v.timezone : d.timezone,
  };
}

/** Is a value inside the form's range? The page flags one that is not, rather than hiding it. */
export function isOutsideEscalationFormBounds(key: keyof typeof ESCALATION_FORM_BOUNDS, n: number): boolean {
  const b = ESCALATION_FORM_BOUNDS[key];
  return n < b.min || n > b.max;
}

/* ------------------------------------------------------------------------- */
/* eligibility at send time                                                  */
/* ------------------------------------------------------------------------- */

export const LEAD_OPEN = new Set(["new", "contacted", "qualified"]);

export type EscalationIneligibility = "lead_answered" | "lead_closed" | "lead_redacted" | "lead_unreadable";

/**
 * Why a lead must NOT be escalated any more, or null when it still should be.
 * The sweep's WHERE decided this once; the worker asks again at the moment of
 * sending, because minutes pass between the two and an answered enquiry
 * escalated is a colleague chased for nothing.
 */
export function escalationIneligibility(lead: {
  status: string;
  first_response_at: string | null;
  message: string | null;
}): EscalationIneligibility | null {
  if (lead.message === LEAD_MESSAGE_REDACTED) return "lead_redacted";
  if (lead.first_response_at) return "lead_answered";
  if (!LEAD_OPEN.has(lead.status)) return "lead_closed";
  if (!parseWebsiteEnquiry(lead.message)) return "lead_unreadable";
  return null;
}

/**
 * The colleagues to tell, from the policy's ids and the profiles read for
 * them NOW: active, an admin or an agent, of the lead's own organisation,
 * and never the lead's assignee. The query already scopes org and ids; the
 * rule is applied again here so the decision is one function a test can
 * read, whatever the client returned.
 *
 * SORTED, because the list is part of the provider payload and the payload
 * must be byte-identical on every attempt under one idempotency key (audit
 * 2026-09-22, finding 2): the profiles query carries no ORDER BY, and the
 * same set in another order is "a different payload" to the provider.
 */
export function escalationRecipients(
  cfg: Pick<LeadEscalationConfig, "recipients">,
  profiles: ReadonlyArray<{ id: string; org_id: string; email: string | null; role: string; is_active: boolean }>,
  lead: { org_id: string; assigned_agent_id: string | null },
): string[] {
  const wanted = new Set(cfg.recipients);
  const out = new Set<string>();
  for (const p of profiles) {
    if (!wanted.has(p.id)) continue;
    if (p.org_id !== lead.org_id) continue;
    if (!p.is_active) continue;
    if (p.role !== "admin" && p.role !== "agent") continue;
    if (lead.assigned_agent_id && p.id === lead.assigned_agent_id) continue;
    const email = p.email?.trim();
    if (email) out.add(email);
  }
  return [...out].sort();
}

/* ------------------------------------------------------------------------- */
/* the message                                                               */
/* ------------------------------------------------------------------------- */

export interface LeadEscalation {
  name: string;
  email: string | null;
  phone: string | null;
  propertyReference: string | null;
  message: string | null;
  /** who the lead is assigned to, or null for unassigned — a colleague reading this should know whom to nudge */
  assigneeName: string | null;
  /**
   * Whole minutes between the enquiry's arrival and the FIRST attempt under
   * the job's provider key — never the clock at the moment of sending. The
   * number is in the subject and the body, and the provider deduplicates a
   * retry on the key AND the payload: measured at send time it moved with
   * every retry, and a retry after an accepted-but-lost answer was refused
   * for good (409 invalid_idempotent_request; audit 2026-09-22, finding 2).
   * The first attempt's instant is the key's own clock (0102/0104: cleared
   * with the key on rotation, and only then), so every attempt under one key
   * says the same minutes.
   */
  waitingMinutes: number;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://gnk-crm.vercel.app";

export function escalationSubjectFor(e: LeadEscalation): string {
  const about = e.propertyReference ? ` — ${e.propertyReference}` : "";
  return `Unanswered website enquiry${about} — waiting ${e.waitingMinutes} min`;
}

/**
 * Plain text, for a colleague on a phone: who is waiting, for how long, who
 * was meant to answer, how to reach the enquirer, one link. This goes to
 * STAFF of the same organisation, so the enquirer's details belong in it —
 * exactly as they do in the desk alert; they never enter a log or an event.
 */
export function escalationBodyFor(e: LeadEscalation): string {
  const lines = [
    `${e.name} enquired through the website ${e.waitingMinutes} minutes ago and nobody has responded yet.`,
    "",
    e.assigneeName ? `Assigned to:  ${e.assigneeName}` : "Assigned to:  nobody — the enquiry is unclaimed",
    e.email ? `Email:        ${e.email}` : null,
    e.phone ? `Phone:        ${e.phone}` : null,
    e.propertyReference ? `About:        ${e.propertyReference}` : null,
    "",
    e.message ? e.message : "(no message)",
    "",
    "—",
    `Open the lead inbox: ${APP_URL}/leads`,
    "",
    "You are receiving this because Settings → Lead escalation names you. It is sent once per enquiry.",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

/**
 * The escalation, rebuilt from the lead row at send time — the same header
 * block the desk alert is rebuilt from (lib/services/lead-contact.ts), plus
 * the assignee and the wait. Null when the row is not a website enquiry.
 *
 * `waitMeasuredAt` is the instant the wait is counted to: the job's first
 * attempt under its current key (see LeadEscalation.waitingMinutes), which
 * the worker reads off the claimed row. It is deliberately not "now".
 */
export function escalationFromLead(
  lead: { message: string | null; received_at: string; properties?: { reference: string | null } | null },
  ctx: { assigneeName: string | null; waitMeasuredAt: Date },
): LeadEscalation | null {
  const person = parseWebsiteEnquiry(lead.message);
  if (!person) return null;
  const received = new Date(lead.received_at).getTime();
  const waitingMinutes = Number.isNaN(received) ? 0 : Math.max(0, Math.floor((ctx.waitMeasuredAt.getTime() - received) / 60_000));
  return {
    name: person.name,
    email: person.email,
    phone: person.phone,
    propertyReference: lead.properties?.reference ?? person.about,
    message: websiteEnquiryBody(lead.message),
    assigneeName: ctx.assigneeName,
    waitingMinutes,
  };
}

/** Armed by the same provider key as the desk alert; the recipients come from profiles, not the environment. */
export function leadEscalationConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RESEND_API_KEY);
}

/**
 * One provider attempt for an escalation. NEVER throws; answers in the
 * outbox's vocabulary through the same call the desk alert makes, so a
 * provider's answer is classified identically. Replies go to the enquirer.
 */
export async function sendLeadEscalation(
  e: LeadEscalation,
  opts: { to: string[]; timeoutMs?: number; idempotencyKey?: string },
): Promise<AlertSendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("[lead-escalation] SKIPPED — RESEND_API_KEY is not set; the escalation row waits.");
    return { outcome: "skipped" };
  }
  if (opts.to.length === 0) {
    // the worker cancels before it gets here; this is the last line of defence
    return { outcome: "failed", category: "permanent", result: "no_recipient", retryAfterSeconds: null };
  }
  return postProviderEmail(
    {
      from: ALERT_FROM,
      to: opts.to,
      replyTo: e.email,
      subject: escalationSubjectFor(e),
      text: escalationBodyFor(e),
    },
    { apiKey: key, timeoutMs: opts.timeoutMs ?? ALERT_TIMEOUT_MS, idempotencyKey: opts.idempotencyKey, log: "lead-escalation" },
  );
}
