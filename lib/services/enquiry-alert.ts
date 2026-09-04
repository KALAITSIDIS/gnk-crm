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

export interface EnquiryAlert {
  name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  propertyReference: string | null;
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
export async function sendEnquiryAlert(a: EnquiryAlert): Promise<"sent" | "skipped" | "failed"> {
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
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[enquiry-alert] provider responded ${res.status}: ${detail.slice(0, 300)}`);
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("[enquiry-alert] send threw:", err);
    return "failed";
  }
}
