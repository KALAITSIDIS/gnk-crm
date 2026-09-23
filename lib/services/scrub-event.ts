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
 * Two more travel on every event and are no custom header of ours (measured
 * 2026-09-23 through the real SDK pipeline, T-sentry-incoming-request-scrub):
 *
 *   cookie             the Supabase session (`sb-…-auth-token`: the access and
 *                      refresh tokens). This comment used to say
 *                      `sendDefaultPii` off strips it. In @sentry/core 10.65 it
 *                      does not: `cookies` defaults to `{deny: [...]}`, which
 *                      is `!== false`, and that deny list is applied to span
 *                      attributes only, never to `event.request`.
 *   authorization      `Bearer <CRON_SECRET>` on every enquiry-alert sweep,
 *                      every 2 minutes — a sampled transaction of the sweep
 *                      carried the secret.
 *
 * Redacted rather than deleted: an event that shows the header was PRESENT and
 * unreadable tells the person debugging what they need (was the site the
 * caller? was anyone signed in?) without telling them the value.
 *
 * Pure, and tested, because the alternative is finding out from a Sentry
 * event that it did not work. It must not throw on any shape: the SDK drops an
 * event whose `beforeSend` throws and sends its own error in its place.
 */
export const REDACTED = "[redacted]";

/** Header names, lower-case, that are redacted from every outbound event. */
export const SENSITIVE_HEADERS = ["x-gnk-visitor-ip", "x-gnk-forward-key", "cookie", "authorization"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RequestLike {
  url?: string;
  headers?: Record<string, string>;
  query_string?: unknown;
  cookies?: unknown;
  data?: unknown;
}

interface EventLike {
  request?: RequestLike | undefined;
  contexts?: Record<string, unknown>;
  spans?: SpanLike[];
  breadcrumbs?: BreadcrumbLike[];
}

export function scrubSensitiveHeaders<T extends EventLike>(event: T): T {
  const headers = event.request?.headers;
  if (!isRecord(headers)) return event;
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

/**
 * Every absolute URL in `text` cut before its `?` or `#` — and `text` itself
 * when it IS a relative URL (`/contacts?q=…`, `//host/path?…`), which is how
 * Next's `http.target`, onRequestError's path and a browser navigation's `to`
 * arrive. A relative path inside other text ("GET /leads?page=2") is left
 * alone: no shape measured puts one there, and prose is not a URL.
 */
export function stripUrlQueries(text: string): string {
  const absolute = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, "$1");
  return absolute.startsWith("/") ? absolute.replace(/[?#][\s\S]*$/, "") : absolute;
}

function scrubData(data: unknown): void {
  if (!isRecord(data)) return;
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

// ---------------------------------------------------------------------------
// INCOMING REQUESTS (T-sentry-incoming-request-scrub, 2026-09-23).
//
// A sampled transaction of `/contacts?q=<name or e-mail>` — and any error
// raised while serving it — carried the search term, and every event carried
// more than that. Measured through the real @sentry/nextjs 10.65 pipeline:
//
//   - the http integration puts the ABSOLUTE url, the raw query_string, every
//     header and the request BODY on the isolation scope, and RequestData
//     copies them onto errors AND transactions as `event.request`. The body
//     (up to 10 KB) is captured whenever anything listens for "data" on the
//     request — Next's own body clone for the proxy does
//     (next/dist/server/body-streams getCloneableBody), a plain `for await`
//     read does not — so an enquiry POST can carry the enquirer's name,
//     e-mail and phone;
//   - Next's root span sets `http.target` to the RELATIVE req.url, and the SDK
//     copies the request headers onto it (`http.request.header.referer`);
//   - onRequestError's path is req.url: `contexts.nextjs.request_path`;
//   - in the browser, `request.url` is location.href, `Referer` is the
//     previous page, and pageload/navigation spans carry `url.full`.
//
// The path stays everywhere: `/contacts` is what a person debugging needs.
// The query, the cookies and the body go; the secrets are redacted above.

/** `event.request`: the URL's path, no query, no cookies, no body; URL-valued headers cut. */
function scrubRequest(request: RequestLike | undefined): void {
  if (!isRecord(request)) return;
  delete request.query_string;
  delete request.cookies;
  delete request.data;
  if (typeof request.url === "string") request.url = stripUrlQueries(request.url);
  scrubData(request.headers);
}

/** Every context's own values (`nextjs.request_path`) and its `data` (the root span's, on a transaction). */
function scrubContexts(contexts: Record<string, unknown> | undefined): void {
  if (!isRecord(contexts)) return;
  for (const context of Object.values(contexts)) {
    if (!isRecord(context)) continue;
    scrubData(context);
    scrubData(context.data);
  }
}

/**
 * `beforeSend` AND `beforeSendTransaction`, server and browser: one event,
 * whatever its type, leaves with nothing above on it. One function for both
 * hooks, because the two used to differ — only errors had the door's headers
 * redacted, while a sampled transaction carried the same `event.request`.
 * Spans and breadcrumbs are belt and braces with `beforeSendSpan` and
 * `beforeBreadcrumb`, which see the same objects first.
 */
export function scrubEvent<T extends EventLike>(event: T): T {
  scrubSensitiveHeaders(event);
  scrubRequest(event.request);
  scrubContexts(event.contexts);
  if (Array.isArray(event.spans)) {
    for (const span of event.spans) if (isRecord(span)) scrubSpanUrls(span);
  }
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) if (isRecord(crumb)) scrubBreadcrumbUrls(crumb);
  }
  return event;
}
