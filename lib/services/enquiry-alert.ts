/**
 * Telling the desk that a website enquiry arrived.
 *
 * WHY THIS EXISTS. Until now this CRM sent nothing outbound at all — Supabase
 * handles its own auth mail and the app itself has never had a sender. A
 * website enquiry therefore landed in the lead inbox and waited for somebody
 * to go and look. The inbox colour-codes response time in minutes (green under
 * five, amber under an hour, red beyond) which is exactly right for a business
 * where speed wins the instruction, and useless if nobody knows the clock has
 * started. Production's last logged call before this shipped was seven weeks
 * old.
 *
 * ONLY PUBLIC ENQUIRIES. A lead the desk types into the CRM itself needs no
 * email: they are looking at it. This fires for the anonymous door only.
 *
 * ARMED BY CONFIGURATION, exactly like the off-site backup leg (0084 era,
 * scripts/backup/offsite-github.mjs): with no key it SKIPS and says so in the
 * log, and everything else carries on. That matters more here than usual —
 * the enquiry is already saved by the time this runs, so nothing this module
 * does may ever turn a saved enquiry into a failed one.
 *
 * SINCE 0101 THIS IS ONE ATTEMPT, NOT THE WHOLE STORY. The desk alert is a
 * `notification_jobs` row written with the lead; this module makes one
 * provider call for one claimed job and answers in the outbox's vocabulary —
 * accepted (the provider took the message; delivery is not confirmed by
 * anything here), skipped (unarmed), or failed with a CATEGORY that decides
 * what the worker does next: transient and timeout are retried under the
 * same idempotency key, permanent and conflict wait for a human. It reports
 * nothing to Sentry itself: a transient failure that succeeds on the next
 * attempt is not a page. The worker pages on the terminal outcome.
 *
 * The key belongs in Vercel's environment, never in this repository, which is
 * public.
 */
import { retryAfterSeconds } from "@/lib/services/enquiry-alert-jobs";

export interface EnquiryAlert {
  name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  propertyReference: string | null;
  /**
   * The site's provenance and brief (0098), already cleaned against the
   * allowlist — a path and campaign names, never a person. Optional so the
   * callers and tests that predate it still compile.
   */
  meta?: Record<string, string> | null;
}

export type AlertFailureCategory = "transient" | "permanent" | "timeout" | "conflict";

export type AlertSendResult =
  /** The provider accepted the message. Its id is kept for the record; delivery is not confirmed. */
  | { outcome: "accepted"; providerMessageId: string | null }
  /** Not configured on this deployment. The row waits; nothing was attempted. */
  | { outcome: "skipped" }
  /** One attempt failed. `result` is a status or the provider's error NAME — never its body. */
  | { outcome: "failed"; category: AlertFailureCategory; result: string; retryAfterSeconds: number | null };

const FROM = process.env.ENQUIRY_ALERT_FROM ?? "GNK website <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://gnk-crm.vercel.app";

/** What the outbox row may hold for a diagnostic word (0101: last_result). */
const RESULT_MAX = 80;

function subjectFor(a: EnquiryAlert): string {
  const about = a.propertyReference ? ` — ${a.propertyReference}` : "";
  return `Website enquiry from ${a.name}${about}`;
}

/**
 * Plain text, deliberately. This is read on a phone, usually while walking,
 * and the only job is: who, how to reach them, what they want, one link.
 */
export function bodyFor(a: EnquiryAlert): string {
  const from = [a.meta?.source_page, a.meta?.utm_source, a.meta?.utm_medium, a.meta?.utm_campaign]
    .filter((v): v is string => Boolean(v))
    .join(" · ");
  const lines = [
    `${a.name} enquired through the website.`,
    "",
    a.email ? `Email:  ${a.email}` : null,
    a.phone ? `Phone:  ${a.phone}` : null,
    // Whether that reference matched a PUBLISHED listing is decided inside the
    // database function, which returns only success — so this line states what
    // the visitor typed and nothing more. The lead's own message carries the
    // "(no published listing with that reference)" note where it applies.
    a.propertyReference ? `About:  ${a.propertyReference}` : null,
    // Where it came from (0098, audit LR-02): the page, then the campaign the
    // visitor arrived on, if the site remembered one. Omitted entirely when
    // there is nothing to say — a "From:" line with no value is noise.
    from ? `From:   ${from}` : null,
    "",
    a.message ? a.message : "(no message)",
    "",
    "—",
    `Open the lead inbox: ${APP_URL}/leads`,
    "",
    "The response clock is running: green under five minutes, amber under an hour.",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

/**
 * Is the desk alert armed on this deployment? One answer for the sender, the
 * worker and the route, so "unconfigured" is decided once.
 */
export function enquiryAlertConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RESEND_API_KEY && env.ENQUIRY_ALERT_TO);
}

/**
 * What a non-2xx answer from the provider MEANS, by status and by the error
 * name Resend puts in the body (docs: api-reference/errors, read 2026-09-21):
 *
 *   transient — 5xx (application_error, service_unavailable), 429 (any of
 *               the three quota/rate names), 408, and 409
 *               concurrent_idempotent_requests (the same key is in flight —
 *               ours, from a lease that lapsed mid-send). Retried under the
 *               same key.
 *   conflict  — 409 invalid_idempotent_request: this key was already used
 *               with a DIFFERENT payload. The key is burnt, not the enquiry;
 *               the retry action rotates it.
 *   permanent — everything else in 4xx: validation, a missing or restricted
 *               key, an unverified domain, a bad recipient. Nothing a retry
 *               would change; a human reads the inbox chip and fixes the
 *               configuration or the address.
 *
 * The RESULT is the error name when the body carried one, else the status —
 * never the message, which can echo the recipient address.
 */
export function classifyProviderFailure(
  status: number,
  errorName: string | null,
): { category: AlertFailureCategory; result: string } {
  const result = (errorName && errorName.trim() ? errorName.trim() : String(status)).slice(0, RESULT_MAX);
  if (status === 409 && errorName === "invalid_idempotent_request") return { category: "conflict", result };
  if (status >= 500 || status === 429 || status === 408) return { category: "transient", result };
  if (status === 409 && errorName === "concurrent_idempotent_requests") return { category: "transient", result };
  return { category: "permanent", result };
}

/**
 * Long enough for a slow provider, short enough that a stuck one cannot hold
 * the function open (integrations audit 2026-09-15, INT-01). `after()` runs
 * this once the visitor has their 202, so nothing here delays them — but a
 * provider that accepts the connection and never answers would otherwise
 * hold the function until the platform kills it.
 */
export const ALERT_TIMEOUT_MS = 8000;

/**
 * One attempt. NEVER throws: the enquiry it describes is already committed,
 * and the word returned is what the outbox records.
 */
export async function sendEnquiryAlert(
  a: EnquiryAlert,
  opts: { timeoutMs?: number; idempotencyKey?: string } = {},
): Promise<AlertSendResult> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ENQUIRY_ALERT_TO;

  if (!key || !to) {
    console.warn(
      "[enquiry-alert] SKIPPED — set RESEND_API_KEY and ENQUIRY_ALERT_TO in the Vercel " +
        "environment to arm it. The enquiry itself was saved.",
    );
    return { outcome: "skipped" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Resend remembers a key for 24 hours and answers a repeat with the
        // first message's id instead of sending again (docs:
        // dashboard/emails/idempotency-keys). That is what makes a retry
        // after an ambiguous timeout safe.
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: FROM,
        to: to.split(",").map((s) => s.trim()).filter(Boolean),
        // so a reply from the phone goes to the buyer, not into the void
        ...(a.email ? { reply_to: a.email } : {}),
        subject: subjectFor(a),
        text: bodyFor(a),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? ALERT_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) {
      const name = typeof body?.name === "string" ? body.name : null;
      const { category, result } = classifyProviderFailure(res.status, name);
      // The status and the NAME, never the message: a provider's message can
      // repeat the address it refused.
      console.error(`[enquiry-alert] provider responded ${res.status} (${result}, ${category})`);
      return {
        outcome: "failed",
        category,
        result,
        retryAfterSeconds: retryAfterSeconds(res.headers.get("retry-after"), new Date()),
      };
    }
    const id = typeof body?.id === "string" ? body.id.slice(0, 120) : null;
    return { outcome: "accepted", providerMessageId: id };
  } catch (err) {
    const name = err instanceof Error ? err.name : "threw";
    // AbortSignal.timeout rejects with TimeoutError; an abort from elsewhere
    // with AbortError. Both mean the ANSWER was lost, not the request — the
    // provider may have accepted the message, which is why the worker
    // retries under the same key rather than a fresh one.
    if (name === "TimeoutError" || name === "AbortError") {
      console.error("[enquiry-alert] send timed out — the provider's answer is unknown");
      return { outcome: "failed", category: "timeout", result: "timeout", retryAfterSeconds: null };
    }
    console.error(`[enquiry-alert] send threw: ${name}`);
    return { outcome: "failed", category: "transient", result: "network", retryAfterSeconds: null };
  }
}
