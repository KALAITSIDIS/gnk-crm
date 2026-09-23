import * as Sentry from "@sentry/nextjs";
import {
  scrubBreadcrumbUrls,
  scrubSensitiveHeaders,
  scrubSpanUrls,
  scrubTransactionUrls,
} from "@/lib/services/scrub-event";

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
    // An error event carries the request's headers, and two of ours must not
    // travel: the visitor's raw address (the site's legal page says it is
    // never stored) and the forward key. `sendDefaultPii` is off and strips
    // what the SDK knows about; a custom header is ours to scrub.
    beforeSend: (event) => scrubSensitiveHeaders(event),
    // A PostgREST read's filter IS its query string — the e-mails, phones
    // and names being searched for. Outgoing URLs keep their path and lose
    // their query on every span, breadcrumb and sampled trace.
    beforeSendSpan: (span) => scrubSpanUrls(span),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumbUrls(breadcrumb),
    beforeSendTransaction: (event) => scrubTransactionUrls(event),
  });
}

// Next 15+ server-error hook — no-ops until init() has run with a DSN.
export const onRequestError = Sentry.captureRequestError;
