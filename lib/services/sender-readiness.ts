/**
 * What this deployment can truthfully say about its e-mail SENDER
 * (audit 2026-09-22, late). Pure: the answer's shape, reading a From's
 * domain, and the words the lead escalation's activation preview prints.
 * The one call that asks the provider lives with the other provider call,
 * in enquiry-alert.ts (`senderReadiness`).
 *
 * WHY. The preview used to say "armed" whenever RESEND_API_KEY and
 * ENQUIRY_ALERT_TO existed. That is the worker's gate — without them it
 * claims nothing — but it says nothing about the From. Unset, the From is
 * Resend's shared test sender, which delivers only to the address that owns
 * the Resend account and refuses a message naming anyone else (403, docs:
 * knowledge-base/403-error-resend-dev-domain). A custom From is refused too
 * until its domain is verified. An escalation names every eligible recipient
 * in ONE message, so "armed" could stand beside two eligible admins neither
 * of whom would get it.
 *
 * THE ANSWERS, and only one of them is green:
 *   not_configured      — the worker's gate fails: it claims nothing
 *   invalid_from        — the gate passes but the From is no address the
 *                         provider accepts: every attempt would be refused
 *   key_rejected        — the provider answered that the key is invalid
 *   test_sender         — resend.dev: the account owner's own address only
 *   custom_unverified   — a custom From; whether its domain is verified is
 *                         UNKNOWN (the key may only send, or the provider
 *                         could not be asked) — never shown as verified
 *   custom_not_verified — the provider SAID so: another status, sending
 *                         disabled, or not in this account at all
 *   domain_verified     — the provider's own read-only answer: this exact
 *                         domain is verified with sending enabled
 * Verified means the provider will take mail from the address. It is not
 * delivery to anyone's inbox, and the words never say it is.
 */

export type SenderReadiness =
  | { state: "not_configured"; missing: string[] }
  | { state: "invalid_from" }
  | { state: "key_rejected" }
  | { state: "test_sender"; fromSet: boolean; domain: string }
  | { state: "custom_unverified"; domain: string; evidence: "key_cannot_read_domains" | "lookup_failed" | "listing_incomplete" }
  | { state: "custom_not_verified"; domain: string; providerStatus: string | null }
  | { state: "domain_verified"; domain: string };

/** The From every internal message uses when ENQUIRY_ALERT_FROM is unset: Resend's shared test sender. */
export const DEFAULT_ALERT_FROM = "GNK website <onboarding@resend.dev>";

/**
 * The domain of a From in one of the two forms the provider accepts — a bare
 * address (`a@b.c`) or a display name with the address in brackets
 * (`Name <a@b.c>`) — lower-cased; null for anything else (no address, a
 * name without brackets, an unclosed bracket), which the provider would
 * refuse. A single-label domain (`localhost`) is no sending domain.
 */
export function senderDomain(from: string): string | null {
  const trimmed = from.trim();
  const address = /^[^<>]*<([^<>]*)>$/.exec(trimmed)?.[1] ?? trimmed;
  const m = /^[^\s<>@]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(address);
  return m ? m[1]!.toLowerCase() : null;
}

/** Resend's shared test domain — its onboarding sender and anything else under resend.dev. */
export function isResendTestDomain(domain: string): boolean {
  return domain === "resend.dev" || domain.endsWith(".resend.dev");
}

export type SenderTone = "danger" | "warning" | "neutral";

const UNKNOWN_BECAUSE: Record<Extract<SenderReadiness, { state: "custom_unverified" }>["evidence"], string> = {
  key_cannot_read_domains: "this deployment's key may only send, so it cannot read the domain's status",
  lookup_failed: "the provider could not be asked just now",
  listing_incomplete: "the account lists more domains than one page of the provider's answer",
};

/**
 * Statuses in which the provider's answer itself establishes that the domain
 * cannot send yet (docs: dashboard/domains — a domain sends once verified).
 * Any other non-verified word (partially_verified, temporary_failure, …) is
 * reported as what it is, without claiming what the provider does with it.
 */
const NOT_SENDABLE = new Set(["not_started", "pending", "failed"]);

/** The providerStatus word for a domain listed as verified whose `capabilities.sending` is "disabled". */
export const SENDING_DISABLED = "sending disabled";

/** The sender line on the activation preview. A test pins every answer's words. */
export function senderReadinessCopy(r: SenderReadiness): { tone: SenderTone; text: string } {
  switch (r.state) {
    case "not_configured":
      return {
        tone: "danger",
        text: `NOT configured on this deployment (${r.missing.join("; ")}) — the worker sends nothing, so any job the sweep creates would wait.`,
      };
    case "invalid_from":
      return {
        tone: "danger",
        text:
          "ENQUIRY_ALERT_FROM holds no usable e-mail address (the provider takes a@domain or Name <a@domain>). The worker would still " +
          "attempt every message and the provider would refuse each one — a permanent failure on the inbox row.",
      };
    case "key_rejected":
      return {
        tone: "danger",
        text: "Resend rejects this deployment's RESEND_API_KEY as invalid — it would refuse every message until the key is replaced.",
      };
    case "test_sender":
      return {
        tone: "danger",
        text:
          `Resend's shared test sender (${r.fromSet ? `ENQUIRY_ALERT_FROM is a ${r.domain} address` : "onboarding@resend.dev, because ENQUIRY_ALERT_FROM is not set"}). ` +
          "Resend delivers from it only to the address that owns the Resend account, and refuses a message naming anyone else (403). " +
          "An escalation names every eligible recipient in one message. Set ENQUIRY_ALERT_FROM to an address on a domain verified in Resend, then redeploy.",
      };
    case "custom_unverified":
      return {
        tone: "warning",
        text: `From ${r.domain}. Whether Resend has verified this domain is unknown — ${UNKNOWN_BECAUSE[r.evidence]}. Until it is verified, Resend refuses mail from it.`,
      };
    case "custom_not_verified":
      if (r.providerStatus === null) {
        return {
          tone: "danger",
          text: `From ${r.domain}, which is not a domain in the Resend account behind this deployment's key — Resend refuses mail from it.`,
        };
      }
      if (r.providerStatus === SENDING_DISABLED) {
        return {
          tone: "danger",
          text: `From ${r.domain}, which Resend lists as verified but with sending disabled, not "verified" for sending — Resend refuses mail from it.`,
        };
      }
      return NOT_SENDABLE.has(r.providerStatus)
        ? {
            tone: "danger",
            text: `From ${r.domain}, which Resend reports as "${r.providerStatus}", not "verified" — Resend refuses mail from it until it is verified.`,
          }
        : {
            tone: "warning",
            text: `From ${r.domain}, which Resend reports as "${r.providerStatus}", not "verified". Whether it takes mail in that state is not established here — check the domain in Resend.`,
          };
    case "domain_verified":
      return {
        tone: "neutral",
        text: `From ${r.domain}, verified for sending in Resend (read when this preview ran). Resend takes mail from it; acceptance is not delivery to an inbox.`,
      };
  }
}
