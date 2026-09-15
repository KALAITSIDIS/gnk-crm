/**
 * Acknowledging the enquirer (0098, audit LR-06).
 *
 * WHY THIS EXISTS. The website's thank-you panel was the only thing a visitor
 * ever received. A buyer who filled in a brief at 22:00 had no confirmation,
 * no reference to the listing they asked about, no idea when a reply would
 * come, and no way to notice a mistyped address. Resend was wired for the
 * desk alert and idle otherwise.
 *
 * SAME SHAPE AS THE DESK ALERT (enquiry-alert.ts): plain text, sent in
 * `after()` once the visitor has their 202, never throws, never fails the
 * saved enquiry. Two extra rules, both about who the recipient is:
 *
 *   NEVER FROM THE ONBOARDING SENDER. The desk alert may leave as
 *   `onboarding@resend.dev` because the desk knows what it is; a client must
 *   not receive mail from an address that is not the firm's. So this is armed
 *   by `ENQUIRY_ALERT_FROM` holding a real sending address — the verified
 *   `send.kalaitsidis.com` domain — and skips loudly otherwise.
 *
 *   ONLY WHEN THERE IS AN ADDRESS. A phone-only enquiry is acknowledged by
 *   the call the desk makes.
 *
 * The route sends it once per fresh enquiry: not for a replay (0096) and not
 * for a honeypot hit, the same two cases that get no desk alert.
 */
import * as Sentry from "@sentry/nextjs";

export interface EnquiryAck {
  name: string;
  email: string | null;
  propertyReference: string | null;
  /** the firm's name from the organisations row, never a literal here */
  orgName: string;
}

/** The desk's own hours, as the site states them (gnk-web lib/site.ts). */
export const DESK_HOURS = "Monday to Friday, 09:00–18:00 (Cyprus time)";

/** As the desk alert's: a stuck provider cannot hold the function open. */
export const ACK_TIMEOUT_MS = 8000;

export function ackSubjectFor(a: EnquiryAck): string {
  const about = a.propertyReference ? ` about ${a.propertyReference}` : "";
  return `Your enquiry${about} — ${a.orgName}`;
}

/**
 * Plain text, no links, no marketing. It confirms one thing and sets one
 * expectation; the reply itself is a person's job.
 */
export function ackBodyFor(a: EnquiryAck): string {
  const first = a.name.trim().split(/\s+/)[0] || a.name.trim();
  const about = a.propertyReference ? ` about ${a.propertyReference}` : "";
  return [
    `Thank you, ${first}. Your enquiry${about} has reached us.`,
    "",
    `One of us will reply personally — usually within the hour during ${DESK_HOURS}, ` +
      "otherwise the next working morning.",
    "",
    "If you need to add anything, or a detail you gave was wrong, reply to this e-mail.",
    "",
    a.orgName,
  ].join("\n");
}

/**
 * Send, or say why not. NEVER throws — the enquiry it acknowledges is already
 * committed and the desk already told.
 */
export async function sendEnquiryAck(
  a: EnquiryAck,
  opts: { timeoutMs?: number } = {},
): Promise<"sent" | "skipped" | "failed"> {
  if (!a.email) {
    console.warn("[enquiry-ack] SKIPPED — the enquirer left no e-mail address.");
    return "skipped";
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ENQUIRY_ALERT_FROM;
  if (!key || !from || /@resend\.dev\b/i.test(from)) {
    console.warn(
      "[enquiry-ack] SKIPPED — set RESEND_API_KEY and ENQUIRY_ALERT_FROM (a verified " +
        "sending address, never resend.dev) in the Vercel environment to arm it.",
    );
    return "skipped";
  }
  const replyTo = (process.env.ENQUIRY_ALERT_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [a.email],
        // a reply lands with the desk, where the person who answers sits
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject: ackSubjectFor(a),
        text: ackBodyFor(a),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? ACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[enquiry-ack] provider responded ${res.status}: ${detail.slice(0, 300)}`);
      reportFailure(a, `provider responded ${res.status}`);
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("[enquiry-ack] send threw:", err);
    reportFailure(a, err instanceof Error ? err.name : "threw");
    return "failed";
  }
}

/** Shape only: the reference, never the person or the address. */
function reportFailure(a: EnquiryAck, reason: string): void {
  try {
    Sentry.captureMessage(`[enquiry-ack] send failed: ${reason}`, {
      level: "warning",
      extra: { reason, propertyReference: a.propertyReference },
    });
  } catch {
    // best-effort; the console line stands
  }
}
