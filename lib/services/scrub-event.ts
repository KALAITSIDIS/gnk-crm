/**
 * What must never leave this system in an error report.
 *
 * `instrumentation.ts` wires Next's `onRequestError` straight to Sentry, and
 * an error event carries the request's headers. Two of ours must not travel
 * (the 2026-09-07 review):
 *
 *   x-gnk-visitor-ip   the visitor's RAW address, forwarded by our marketing
 *                      site. gnk-web's legal page tells that visitor "We never
 *                      store the address itself — only a scrambled, one-way
 *                      fingerprint of it". An uncaught error on the enquiry
 *                      route would have sent the address itself to a third
 *                      party, which is that promise being false.
 *   x-gnk-forward-key  the shared secret the site proves itself with. It
 *                      grants only a per-visitor rate budget, but a secret in
 *                      someone else's log is a secret you no longer control.
 *
 * `sendDefaultPii` is off by default and strips `cookie`, `authorization` and
 * the IP the SDK infers — it knows nothing about a custom header, so this is
 * ours to do. Redacted rather than deleted: an event that shows the header was
 * PRESENT and unreadable tells the person debugging what they need (was the
 * site the caller?) without telling them the value.
 *
 * Pure, and tested, because the alternative is finding out from a Sentry
 * event that it did not work.
 */
export const REDACTED = "[redacted]";

/** Header names, lower-case, that are redacted from every outbound event. */
export const SENSITIVE_HEADERS = ["x-gnk-visitor-ip", "x-gnk-forward-key"] as const;

interface EventLike {
  request?: { headers?: Record<string, string> } | undefined;
}

export function scrubSensitiveHeaders<T extends EventLike>(event: T): T {
  const headers = event.request?.headers;
  if (!headers) return event;
  for (const name of Object.keys(headers)) {
    if ((SENSITIVE_HEADERS as readonly string[]).includes(name.toLowerCase())) {
      headers[name] = REDACTED;
    }
  }
  return event;
}
