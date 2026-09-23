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

// ---------------------------------------------------------------------------
// OUTGOING REQUEST URLS (T-enquiry-contact-suggestions, 2026-09-23).
//
// Every PostgREST read the server makes is a GET whose FILTER IS THE QUERY
// STRING — `?or=(email.in.("maria@…"),phone_e164.in.("+357…"))`. The Sentry
// SDK records the outgoing URL on each fetch span (`url.full`, `url.query`;
// Next's own fetch span carries it in its name and `http.url`) and on each
// fetch breadcrumb (`http.query`), and 10% of server traces are sampled. So
// the dedup check, the contact picker and the inbox's "Possible existing
// contact" lookup were sending the e-mails, phones and names they search for
// to a third party. The path stays — `GET …/rest/v1/contacts` is what a
// person debugging needs — and the query, which is where the person is, goes.

/** Attributes that hold nothing BUT a query or a fragment. */
const QUERY_ONLY_KEYS = ["url.query", "http.query", "http.fragment"] as const;

/** Every absolute URL in `text`, cut before its `?` or `#`. */
export function stripUrlQueries(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, "$1");
}

function scrubData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of QUERY_ONLY_KEYS) delete data[key];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") data[key] = stripUrlQueries(value);
  }
}

interface SpanLike {
  description?: string;
  data?: Record<string, unknown>;
}

/** `beforeSendSpan`: a span's name and attributes, without any URL's query. */
export function scrubSpanUrls<T extends SpanLike>(span: T): T {
  if (typeof span.description === "string") span.description = stripUrlQueries(span.description);
  scrubData(span.data);
  return span;
}

interface BreadcrumbLike {
  message?: string;
  data?: Record<string, unknown>;
}

/** `beforeBreadcrumb`: a fetch breadcrumb keeps its method, path and status, not its query. */
export function scrubBreadcrumbUrls<T extends BreadcrumbLike>(breadcrumb: T): T {
  if (typeof breadcrumb.message === "string") breadcrumb.message = stripUrlQueries(breadcrumb.message);
  scrubData(breadcrumb.data);
  return breadcrumb;
}

interface TransactionLike {
  spans?: SpanLike[];
  contexts?: { trace?: { data?: Record<string, unknown> } };
}

/**
 * `beforeSendTransaction`: every child span of a sampled trace, and the root
 * span's data. Belt and braces with `beforeSendSpan`, which the SDK calls for
 * the same spans — a transaction that reached Sentry unscrubbed would be the
 * failure this exists to prevent.
 */
export function scrubTransactionUrls<T extends TransactionLike>(event: T): T {
  for (const span of event.spans ?? []) scrubSpanUrls(span);
  scrubData(event.contexts?.trace?.data);
  return event;
}
