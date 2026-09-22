/**
 * The activation preview of the lead escalation (0112) — the client's half.
 *
 * `preview_lead_escalation(p_policy, p_limit, p_now)` evaluates the values
 * on Settings → Lead escalation AS IF they were switched on, for an aal2
 * admin of their own organisation, and returns one document: the policy as
 * the sweep's reader validates it, every proposed recipient with a reason,
 * counts that keep the SWEEP's jobs (`due`) apart from the WORKER's e-mails
 * (`would_send`), and a bounded page of enquiries with a verdict each. The
 * database owns every rule (`lead_escalation_candidates` is the sweep's own
 * eligibility; the recipient rule is the worker's); this file only READS
 * the document — strictly, so the card never renders a shape it does not
 * understand — and holds the words the card uses for each value.
 *
 * Never the enquirer: the document carries ids, times, a colleague's name,
 * a property reference. The names of staff already appear on the panel.
 */
import { readLeadEscalation, type LeadEscalationConfig } from "@/lib/services/lead-escalation";

/** The page the panel asks for; the function's own ceiling is 200. */
export const PREVIEW_LIMIT = 50;

export const PREVIEW_VERDICTS = ["due", "not_yet_due", "past_cutoff", "already_escalated"] as const;
export type PreviewVerdict = (typeof PREVIEW_VERDICTS)[number];

export const RECIPIENT_REASONS = ["ok", "not_in_organisation", "inactive", "not_admin_or_agent", "no_email"] as const;
export type RecipientReason = (typeof RECIPIENT_REASONS)[number];

export interface PreviewRecipient {
  id: string;
  /** null when the id is not a member of the caller's organisation — nothing about them is shown */
  full_name: string | null;
  role: string | null;
  is_active: boolean | null;
  has_email: boolean | null;
  eligible: boolean;
  reason: RecipientReason;
}

export interface PreviewLead {
  lead_id: string;
  received_at: string;
  due_at: string;
  verdict: PreviewVerdict;
  status: string;
  assignee_id: string | null;
  assignee_name: string | null;
  property_ref: string | null;
  /** eligible recipients once this lead's own assignee is removed */
  recipients_eligible: number;
  /** the case to point at: the ONLY eligible recipient is the assignee, whom the worker never tells */
  only_recipient_is_assignee: boolean;
  /** for already_escalated: the existing job's state */
  job_state: string | null;
}

export interface PreviewCounts {
  /** open, unanswered, unredacted website enquiries inside the sweep's bound */
  considered: number;
  /** jobs the sweep would create */
  due: number;
  /** of those, e-mails the worker could send (somebody eligible to receive them) */
  would_send: number;
  no_recipient: number;
  only_recipient_is_assignee: number;
  not_yet_due: number;
  past_cutoff: number;
  already_escalated: number;
}

export interface LeadEscalationPreview {
  evaluated_at: string;
  evaluated_as_enabled: true;
  stored_enabled: boolean;
  policy: LeadEscalationConfig;
  recipients: PreviewRecipient[];
  eligible_recipient_count: number;
  counts: PreviewCounts;
  leads: PreviewLead[];
  truncated: boolean;
  limit: number;
}

const COUNT_KEYS: ReadonlyArray<keyof PreviewCounts> = [
  "considered",
  "due",
  "would_send",
  "no_recipient",
  "only_recipient_is_assignee",
  "not_yet_due",
  "past_cutoff",
  "already_escalated",
];

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const nullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const nullableBoolean = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";

function readRecipient(v: unknown): PreviewRecipient | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== "string" || typeof v.eligible !== "boolean") return null;
  if (!nullableString(v.full_name) || !nullableString(v.role) || !nullableBoolean(v.is_active) || !nullableBoolean(v.has_email)) return null;
  if (typeof v.reason !== "string" || !(RECIPIENT_REASONS as ReadonlyArray<string>).includes(v.reason)) return null;
  return {
    id: v.id,
    full_name: v.full_name,
    role: v.role,
    is_active: v.is_active,
    has_email: v.has_email,
    eligible: v.eligible,
    reason: v.reason as RecipientReason,
  };
}

function readLead(v: unknown): PreviewLead | null {
  if (!isRecord(v)) return null;
  if (typeof v.lead_id !== "string" || !isIso(v.received_at) || !isIso(v.due_at) || typeof v.status !== "string") return null;
  if (typeof v.verdict !== "string" || !(PREVIEW_VERDICTS as ReadonlyArray<string>).includes(v.verdict)) return null;
  if (!nullableString(v.assignee_id) || !nullableString(v.assignee_name) || !nullableString(v.property_ref) || !nullableString(v.job_state)) return null;
  if (!isInt(v.recipients_eligible) || typeof v.only_recipient_is_assignee !== "boolean") return null;
  return {
    lead_id: v.lead_id,
    received_at: v.received_at,
    due_at: v.due_at,
    verdict: v.verdict as PreviewVerdict,
    status: v.status,
    assignee_id: v.assignee_id,
    assignee_name: v.assignee_name,
    property_ref: v.property_ref,
    recipients_eligible: v.recipients_eligible,
    only_recipient_is_assignee: v.only_recipient_is_assignee,
    job_state: v.job_state,
  };
}

/** The document, or null for anything that is not one. */
export function readLeadEscalationPreview(value: unknown): LeadEscalationPreview | null {
  if (!isRecord(value)) return null;
  if (!isIso(value.evaluated_at) || value.evaluated_as_enabled !== true || typeof value.stored_enabled !== "boolean") return null;
  if (!isRecord(value.policy) || !isRecord(value.counts) || !Array.isArray(value.recipients) || !Array.isArray(value.leads)) return null;
  if (typeof value.truncated !== "boolean" || !isInt(value.limit) || !isInt(value.eligible_recipient_count)) return null;

  const counts = {} as PreviewCounts;
  for (const k of COUNT_KEYS) {
    const n = value.counts[k];
    if (!isInt(n)) return null;
    counts[k] = n;
  }
  const recipients: PreviewRecipient[] = [];
  for (const r of value.recipients) {
    const read = readRecipient(r);
    if (!read) return null;
    recipients.push(read);
  }
  const leads: PreviewLead[] = [];
  for (const l of value.leads) {
    const read = readLead(l);
    if (!read) return null;
    leads.push(read);
  }
  return {
    evaluated_at: value.evaluated_at,
    evaluated_as_enabled: true,
    stored_enabled: value.stored_enabled,
    policy: readLeadEscalation(value.policy),
    recipients,
    eligible_recipient_count: value.eligible_recipient_count,
    counts,
    leads,
    truncated: value.truncated,
    limit: value.limit,
  };
}

/* ------------------------------------------------------------------------- */
/* the words                                                                 */
/* ------------------------------------------------------------------------- */

export const VERDICT_COPY: Record<PreviewVerdict, string> = {
  due: "would be escalated now",
  not_yet_due: "not yet due",
  past_cutoff: "its wait ended too long ago — past the cutoff, left to its task",
  already_escalated: "already has an escalation",
};

export const RECIPIENT_REASON_COPY: Record<RecipientReason, string> = {
  ok: "eligible",
  not_in_organisation: "not a member of this organisation",
  inactive: "inactive — the sweep skips them",
  not_admin_or_agent: "not an admin or agent — cannot work a lead",
  no_email: "no e-mail address on file",
};

const JOB_STATE_COPY: Record<string, string> = {
  pending: "queued",
  sending: "being sent",
  accepted: "accepted by the provider",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * Why this enquiry would NOT be e-mailed — or null when it would. For a due
 * enquiry the reason is about recipients; for the others, the verdict.
 */
export function leadExclusionReason(lead: PreviewLead): string | null {
  if (lead.verdict === "due") {
    if (lead.recipients_eligible > 0) return null;
    if (lead.only_recipient_is_assignee) return "its only eligible recipient is its assignee, who is never told";
    return "nobody eligible would receive it";
  }
  if (lead.verdict === "already_escalated") {
    const state = lead.job_state ? (JOB_STATE_COPY[lead.job_state] ?? lead.job_state) : "recorded";
    return `${VERDICT_COPY.already_escalated} (${state})`;
  }
  return VERDICT_COPY[lead.verdict];
}
