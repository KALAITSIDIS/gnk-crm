/**
 * The pure half of the desk-alert outbox (0101, reviewed 0102): the retry
 * schedule, the provider key and its window, what a run's budget fits, and
 * the reconstruction of the e-mail from the lead.
 *
 * The database owns the state machine (migrations 0101/0102:
 * notification_jobs, claim_notification_jobs, complete_notification_job);
 * the worker (enquiry-alert-worker.ts) drives it. Everything here is
 * arithmetic or parsing, so a unit test reaches it without a stack or a
 * provider.
 */
import { ENQUIRY_META_KEYS, type EnquiryMeta } from "@/lib/services/enquiry-meta";
import { parseWebsiteEnquiry, websiteEnquiryBody } from "@/lib/services/lead-contact";
import type { EnquiryAlert } from "@/lib/services/enquiry-alert";

/**
 * How many times a job may be attempted before it waits for a human. Matches
 * the column default (`notification_jobs.max_attempts`) and is only quoted
 * here so the schedule below can be checked against it: every automatic
 * retry reuses ONE provider idempotency key, so the whole budget must fit
 * inside the key window below with room to spare.
 * 60s · 2^(n-1), capped at an hour, over seven retries ≈ 2h07m.
 */
export const ALERT_MAX_ATTEMPTS = 8;
export const RETRY_BASE_SECONDS = 60;
export const RETRY_CAP_SECONDS = 3600;

/**
 * THE KEY WINDOW (review A). Resend keeps an idempotency key for 24 hours
 * (docs read 2026-09-21) and says nothing about after; a retry under a key
 * the provider has forgotten is a second e-mail if the first was accepted
 * and its answer lost. 20 hours leaves a margin for clock skew and for the
 * provider counting from ITS receipt. The database carries the same number
 * in `notification_key_window()` (0102) and refuses to hand out a row past
 * it; enquiry-alert-jobs.test.ts pins the two against each other.
 */
export const KEY_SAFE_WINDOW_MS = 20 * 3_600_000;

/**
 * What one job costs beyond the provider call: the lead read, the completion
 * round trip, and the claim's share. Generous on purpose — a budget that is
 * a little too small releases a row; one that is a little too large strands
 * an invocation with a job mid-send.
 */
export const PER_JOB_OVERHEAD_MS = 2_000;

/**
 * Seconds to wait before the next attempt, given how many have been made.
 * A longer Retry-After from the provider wins IN FULL — a retry that comes
 * earlier than the provider asked is a retry the provider told us not to
 * make. Whether such a wait is SAFE is the key window's question
 * (`retryFitsKeyWindow`), not this function's, so no cap is applied to it.
 */
export function retryDelaySeconds(attempt: number, retryAfterSeconds: number | null): number {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const backoff = Math.min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * 2 ** (n - 1));
  const asked = retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 0;
  return Math.max(backoff, asked);
}

/**
 * Retry-After as seconds from now, or null. Accepts the two shapes the header
 * may take (delta-seconds or an HTTP date); anything else, and a date already
 * in the past, is treated as no advice.
 */
export function retryAfterSeconds(header: string | null | undefined, now: Date): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n > 0 ? n : null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const delta = Math.ceil((at - now.getTime()) / 1000);
  return delta > 0 ? delta : null;
}

/**
 * The provider idempotency key: stable for the life of a serial, so every
 * automatic retry — including one after an ambiguous timeout — presents the
 * same key and the provider answers with the first message rather than a
 * second. `request_enquiry_alert_retry` moves the serial only when the old
 * key is no longer safe to reuse, on a person's say-so.
 */
export function idempotencyKeyFor(job: { id: string; key_serial: number; kind?: string }): string {
  // prefixed by the kind (0107): the two messages a lead can produce must
  // never share a key, and a row's kind never changes
  const prefix = job.kind === "lead_escalation" ? "lead-escalation" : "enquiry-desk-alert";
  return `${prefix}/${job.id}/${job.key_serial}`;
}

/**
 * How much of the key window is left, measured from the FIRST attempt of
 * the current key — never from the row's creation: a job nobody ever tried
 * has no window running and may be sent however old it is. Negative once
 * the window has passed; null when nothing was ever presented.
 */
export function keyWindowRemainingMs(job: { first_attempted_at: string | null }, now: Date): number | null {
  if (!job.first_attempted_at) return null;
  const first = new Date(job.first_attempted_at).getTime();
  if (Number.isNaN(first)) return null;
  return first + KEY_SAFE_WINDOW_MS - now.getTime();
}

/** Would a retry scheduled `delaySeconds` from now still land inside the key window? */
export function retryFitsKeyWindow(
  job: { first_attempted_at: string | null },
  delaySeconds: number,
  now: Date,
): boolean {
  const remaining = keyWindowRemainingMs(job, now);
  if (remaining === null) return true;
  return delaySeconds * 1000 <= remaining;
}

/**
 * How many jobs a run may claim so that every one of them can be attempted
 * inside `budgetMs`, at the provider's worst case plus its round trips.
 */
export function jobsThatFit(budgetMs: number, sendTimeoutMs: number, overheadMs: number = PER_JOB_OVERHEAD_MS): number {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return 0;
  const perJob = Math.max(1, sendTimeoutMs + overheadMs);
  return Math.max(0, Math.floor(budgetMs / perJob));
}

/** The two keys the door writes into criteria itself — not the visitor's brief. */
const OWN_CRITERIA_KEYS = new Set(["channel", "listing_reference"]);

/**
 * The desk e-mail, rebuilt from the lead row the door wrote — the SAME
 * input the route used to pass from the request body, so the message reads
 * identically whichever path sends it and a retry presents an identical
 * payload to the provider. Null when there is nothing to send: a redacted
 * lead, a desk-typed one, or no message at all.
 */
export function alertFromLead(lead: { message: string | null; criteria: unknown }): EnquiryAlert | null {
  const person = parseWebsiteEnquiry(lead.message);
  if (!person) return null;

  let meta: EnquiryMeta | null = null;
  if (lead.criteria && typeof lead.criteria === "object" && !Array.isArray(lead.criteria)) {
    const picked: EnquiryMeta = {};
    for (const [key, value] of Object.entries(lead.criteria as Record<string, unknown>)) {
      if (OWN_CRITERIA_KEYS.has(key)) continue;
      if (!(key in ENQUIRY_META_KEYS)) continue;
      if (typeof value !== "string" || !value.trim()) continue;
      picked[key as keyof EnquiryMeta] = value;
    }
    if (Object.keys(picked).length > 0) meta = picked;
  }

  return {
    name: person.name,
    email: person.email,
    phone: person.phone,
    propertyReference: person.about,
    message: websiteEnquiryBody(lead.message),
    meta,
  };
}
