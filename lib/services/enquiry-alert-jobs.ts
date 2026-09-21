/**
 * The pure half of the desk-alert outbox (0101): the retry schedule, the
 * provider key, and the reconstruction of the e-mail from the lead.
 *
 * The database owns the state machine (migration 0101: notification_jobs,
 * claim_notification_jobs, complete_notification_job); the worker
 * (enquiry-alert-worker.ts) drives it. Everything here is arithmetic or
 * parsing, so a unit test reaches it without a stack or a provider.
 */
import { ENQUIRY_META_KEYS, type EnquiryMeta } from "@/lib/services/enquiry-meta";
import { parseWebsiteEnquiry, websiteEnquiryBody } from "@/lib/services/lead-contact";
import type { EnquiryAlert } from "@/lib/services/enquiry-alert";

/**
 * How many times a job may be attempted before it waits for a human. Matches
 * the column default (`notification_jobs.max_attempts`) and is only quoted
 * here so the schedule below can be checked against it: every automatic
 * retry reuses ONE provider idempotency key, and the provider forgets a key
 * after 24 hours, so the whole budget must fit well inside a day.
 * 60s · 2^(n-1), capped at an hour, over seven retries ≈ 2h07m.
 */
export const ALERT_MAX_ATTEMPTS = 8;
export const RETRY_BASE_SECONDS = 60;
export const RETRY_CAP_SECONDS = 3600;

/**
 * Seconds to wait before the next attempt, given how many have been made.
 * A longer Retry-After from the provider wins, but never past the cap: a
 * provider that says "come back tomorrow" is a provider whose key window we
 * would leave, and that is a human's decision (the retry action rotates the
 * key when it must).
 */
export function retryDelaySeconds(attempt: number, retryAfterSeconds: number | null): number {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const backoff = Math.min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * 2 ** (n - 1));
  const asked = retryAfterSeconds !== null && retryAfterSeconds > 0 ? Math.min(RETRY_CAP_SECONDS, retryAfterSeconds) : 0;
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
 * key is no longer safe to reuse.
 */
export function idempotencyKeyFor(job: { id: string; key_serial: number }): string {
  return `enquiry-desk-alert/${job.id}/${job.key_serial}`;
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
