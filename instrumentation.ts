import * as Sentry from "@sentry/nextjs";
import { scrubBreadcrumbUrls, scrubDsc, scrubEventOrDrop, scrubSpanUrls } from "@/lib/services/scrub-event";

/**
 * Server/edge Sentry init (T5.7). Strictly env-gated: with no DSN (dev, CI,
 * or a deploy that hasn't set the secret) this is a complete no-op, so nothing
 * can throw at startup. Set SENTRY_DSN in the Vercel project to activate.
 */
export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? "production",
    tracesSampleRate: 0.1,
    enabled: true,
    // Errors AND sampled transactions carry the incoming request whole —
    // `sendDefaultPii` off strips none of this (measured, scrub-event.ts):
    // the URL's query (`/contacts?q=<name>`), the session cookie, a bearer
    // secret, the visitor's raw address and the forward key, and — when Next
    // clones it for the proxy — the BODY (an enquiry's name, e-mail and
    // phone). The path stays; the rest goes.
    beforeSend: (event) => scrubEventOrDrop(event),
    beforeSendTransaction: (event) => scrubEventOrDrop(event),
    // A PostgREST read's filter IS its query string — the e-mails, phones
    // and names being searched for. Outgoing URLs keep their path and lose
    // their query on every span and breadcrumb.
    beforeSendSpan: (span) => scrubSpanUrls(span),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumbUrls(breadcrumb),
  });
  // The trace header's transaction name, which no hook above sees: named from
  // the raw path before Next sets the route, it would carry a proposal
  // link's token into the page's <meta name="baggage"> (scrub-event.ts).
  // After init, so it runs after the SDK's own listener.
  Sentry.getClient()?.on("createDsc", (dsc) => scrubDsc(dsc));
}

// Next 15+ server-error hook — no-ops until init() has run with a DSN.
export const onRequestError = Sentry.captureRequestError;
