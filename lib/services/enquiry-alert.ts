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
 * The key belongs in Vercel's environment, never in this repository, which is
 * public.
 */
import * as Sentry from "@sentry/nextjs";

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

const FROM = process.env.ENQUIRY_ALERT_FROM ?? "GNK website <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://gnk-crm.vercel.app";

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
 * Send, or say why not. NEVER throws and never returns a failure the caller
 * is expected to act on — the enquiry it describes is already committed.
 */
/**
 * Long enough for a slow provider, short enough that a stuck one cannot hold
 * the function open (integrations audit 2026-09-15, INT-01). `after()` runs
 * this once the visitor has their 202, so nothing here delays them — but a
 * provider that accepts the connection and never answers would otherwise
 * hold the function until the platform kills it.
 */
export const ALERT_TIMEOUT_MS = 8000;

export async function sendEnquiryAlert(
  a: EnquiryAlert,
  opts: { timeoutMs?: number } = {},
): Promise<"sent" | "skipped" | "failed"> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ENQUIRY_ALERT_TO;

  if (!key || !to) {
    console.warn(
      "[enquiry-alert] SKIPPED — set RESEND_API_KEY and ENQUIRY_ALERT_TO in the Vercel " +
        "environment to arm it. The enquiry itself was saved.",
    );
    return "skipped";
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[enquiry-alert] provider responded ${res.status}: ${detail.slice(0, 300)}`);
      reportFailure(a, `provider responded ${res.status}`);
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("[enquiry-alert] send threw:", err);
    reportFailure(a, err instanceof Error ? err.name : "threw");
    return "failed";
  }
}

/**
 * A failed alert is the one failure this module exists to prevent, and until
 * 0098 it was a console line that nobody was watching (audit LR-07; the lead
 * also carries an `enquiry_alert` event since 0096, but a timeline is read
 * when someone opens the lead, and the point of the alert is that nobody has).
 * Sentry is where a human is paged. SHAPE ONLY: the reference and which
 * details existed, never the person, the address or the message.
 */
function reportFailure(a: EnquiryAlert, reason: string): void {
  try {
    Sentry.captureMessage(`[enquiry-alert] send failed: ${reason}`, {
      level: "error",
      extra: {
        reason,
        propertyReference: a.propertyReference,
        hasEmail: Boolean(a.email),
        hasPhone: Boolean(a.phone),
        sourcePage: a.meta?.source_page ?? null,
      },
    });
  } catch {
    // Sentry is best-effort; the enquiry is already saved and the console line stands.
  }
}
