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
 * Those are ours by name. Beyond them, a header is redacted when its NAME
 * carries a sensitive fragment — the SDK's own judgement (below), which it
 * applies to span attributes but never to `event.request`, so a Vercel OIDC
 * token or a visitor's `x-vercel-ip-city` travelled raw.
 *
 * Pure, and tested, because the alternative is finding out from a Sentry
 * event that it did not work. Wired through `scrubEventOrDrop`: if it throws,
 * the event is dropped — left to the SDK, a throwing `beforeSend` makes it
 * send its own replacement event, and that one skips `beforeSend`.
 */
export const REDACTED = "[redacted]";

/** Header names, lower-case, that are redacted from every outbound event. */
export const SENSITIVE_HEADERS = ["x-gnk-visitor-ip", "x-gnk-forward-key", "cookie", "authorization"] as const;

/**
 * Fragments of a header NAME that make it sensitive: @sentry/core 10.65's
 * SENSITIVE_KEY_SNIPPETS and PII_HEADER_SNIPPETS
 * (utils/data-collection/filtering-snippets.js — not exported, so copied; the
 * test holds this list against the SDK's filter itself), plus two of ours:
 * `bypass` (Vercel's `x-vercel-protection-bypass` automation secret) and
 * `signature` (a request signature is a credential, whoever sends it).
 */
const SENSITIVE_HEADER_FRAGMENTS = [
  "auth", "token", "secret", "session", "password", "passwd", "pwd", "key", "jwt", "bearer", "sso",
  "saml", "csrf", "xsrf", "credentials", "sid", "identity", "set-cookie", "cookie",
  "forwarded", "-ip", "remote-", "via", "-user",
  "bypass", "signature",
] as const;

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    (SENSITIVE_HEADERS as readonly string[]).includes(lower) ||
    SENSITIVE_HEADER_FRAGMENTS.some((fragment) => lower.includes(fragment))
  );
}

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
  exception?: unknown;
  message?: string;
  transaction?: string;
}

export function scrubSensitiveHeaders<T extends EventLike>(event: T): T {
  const headers = event.request?.headers;
  if (!isRecord(headers)) return event;
  for (const name of Object.keys(headers)) {
    if (isSensitiveHeader(name)) headers[name] = REDACTED;
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

// ---------------------------------------------------------------------------
// TOKENS IN THE PATH (T-sentry-path-token-redaction, 2026-09-23).
//
// Cutting the query keeps the path, and two routes' paths ARE the credential:
//
//   /p/<token>                      a buyer's proposal or availability link:
//                                   43 base64url characters; the row holds
//                                   only their sha256 (share-links-token.ts)
//   /api/portals/<portal>/<token>   a portal's feed: 64 hex, "the whole of the
//                                   caller's proof" (portals/token.ts, 0097)
//
// Next names both transactions by their route (`GET /p/[token]`), but the path
// itself rides wherever a URL does: `event.request.url`, the root span's
// `http.target`, onRequestError's `request_path`, the browser's location.href
// and a pageload's `url.full`, the Referer on the interest form's POST from
// the proposal page, a navigation breadcrumb. The secret segment becomes
// `[token]` — the route's own name for it — and the rest of the path stays,
// so an event still says which kind of page, or which portal's feed.
//
// A path counts where one can START: at the start of a value, after a
// character no path segment is made of (whitespace, a quote, `(`, `=`), or
// straight after an absolute or protocol-relative URL's origin — any origin,
// because a preview deployment's host is not the production one. Unlike the
// query cut above, a relative path inside prose counts too: a false match
// costs one segment of debugging detail, a miss costs a credential. A stack
// frame's `…/server/app/p/[token]/page.js` is a file, not the route, and is
// left alone. `app/` holds no other secret segment: a test walks it.

/** Group 1, kept: the start of the value or a delimiter, then an optional origin. */
const PATH_START = String.raw`((?:^|[^\w.~%/+-])(?:[a-z][a-z0-9+.-]*:)?(?:\/\/[^\/\s?#]*)?)`;
/** One path segment. Quotes and angle brackets end it: none is ever unencoded in a path. */
const SEGMENT = String.raw`[^\/\s?#"'<>]+`;

/** Group 2, kept: the route up to its secret segment, which is replaced. */
const TOKEN_PATHS = [
  new RegExp(String.raw`${PATH_START}(\/p\/)${SEGMENT}`, "gi"),
  new RegExp(String.raw`${PATH_START}(\/api\/portals\/${SEGMENT}\/)${SEGMENT}`, "gi"),
];

/**
 * The same token inside the router state Next sends with every RSC request
 * and server action made FROM a page (`next-router-state-tree`, percent-encoded
 * JSON), where a dynamic segment is the tuple `["token","<value>","d",null]`
 * (flight-data-helpers.js). No such request leaves /p/<token> today — the page
 * has no Link, router call or action — so this shuts a door a future "back to
 * listings" link would open without anyone thinking of Sentry. Both routes
 * call their secret `token`; the test that walks app/ holds that.
 */
const ROUTER_STATE_TOKEN = /((?:\[|%5B)(?:"|%22)token(?:"|%22)(?:,|%2C)(?:"|%22))[^"%]*/gi;

/** What the secret segment becomes: the name the route itself gives it. */
export const TOKEN_SEGMENT = "[token]";

/** Every tokenised route's secret segment in `text`, replaced by `[token]`; the rest of each path kept. */
export function redactPathTokens(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATHS) out = out.replace(pattern, `$1$2${TOKEN_SEGMENT}`);
  return out.replace(ROUTER_STATE_TOKEN, `$1${TOKEN_SEGMENT}`);
}

/** A value that may hold a URL, as it may leave: no query, no fragment, no token in its path. */
export function scrubUrlText(text: string): string {
  return redactPathTokens(stripUrlQueries(text));
}

/**
 * A record's string values, and the strings inside an array value (a console
 * breadcrumb's `arguments`: Next logs "Failed to fetch RSC payload for <url>").
 * Never an object inside an array: those are the app's OWN logged objects,
 * and `beforeBreadcrumb` runs before the SDK copies them.
 */
function scrubData(data: unknown): void {
  if (!isRecord(data)) return;
  for (const key of QUERY_ONLY_KEYS) delete data[key];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      data[key] = scrubUrlText(value);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "string") value[i] = scrubUrlText(item);
      });
    }
  }
}

interface SpanLike {
  description?: string;
  data?: Record<string, unknown>;
}

/** `beforeSendSpan`: a span's name and attributes, without any URL's query or path token. */
export function scrubSpanUrls<T extends SpanLike>(span: T): T {
  if (typeof span.description === "string") span.description = scrubUrlText(span.description);
  scrubData(span.data);
  return span;
}

interface BreadcrumbLike {
  message?: string;
  data?: Record<string, unknown>;
}

/** `beforeBreadcrumb`: a fetch breadcrumb keeps its method, path and status, not its query or a path token. */
export function scrubBreadcrumbUrls<T extends BreadcrumbLike>(breadcrumb: T): T {
  if (typeof breadcrumb.message === "string") breadcrumb.message = scrubUrlText(breadcrumb.message);
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

/** `event.request`: the URL's path (token redacted), no query, no cookies, no body; URL-valued headers cut. */
function scrubRequest(request: RequestLike | undefined): void {
  if (!isRecord(request)) return;
  delete request.query_string;
  delete request.cookies;
  delete request.data;
  if (typeof request.url === "string") request.url = scrubUrlText(request.url);
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
 * An exception's message and its frames' file names. In the browser a frame
 * with no file falls back to `location.href` (globalhandlers.js), and an
 * inline script's frames ARE the page URL — query included.
 */
function scrubException(exception: unknown): void {
  if (!isRecord(exception) || !Array.isArray(exception.values)) return;
  for (const value of exception.values) {
    if (!isRecord(value)) continue;
    if (typeof value.value === "string") value.value = scrubUrlText(value.value);
    const frames = isRecord(value.stacktrace) ? value.stacktrace.frames : undefined;
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (!isRecord(frame)) continue;
      if (typeof frame.filename === "string") frame.filename = scrubUrlText(frame.filename);
      if (typeof frame.abs_path === "string") frame.abs_path = scrubUrlText(frame.abs_path);
    }
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
  scrubException(event.exception);
  if (typeof event.message === "string") event.message = scrubUrlText(event.message);
  // Parameterised (`GET /p/[token]`, and `/p/[token]` in the browser from the
  // route manifest withSentryConfig injects), except where the manifest has no
  // match: then the browser names a pageload by the raw pathname.
  if (typeof event.transaction === "string") event.transaction = scrubUrlText(event.transaction);
  if (Array.isArray(event.spans)) {
    for (const span of event.spans) if (isRecord(span)) scrubSpanUrls(span);
  }
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) if (isRecord(crumb)) scrubBreadcrumbUrls(crumb);
  }
  return event;
}

/**
 * What the hooks call. A scrub that throws DROPS the event: handed back to
 * the SDK, the throw makes it send an "Event processing pipeline threw"
 * replacement, which returns before `beforeSend` (client.js, `__sentry__`) —
 * so whatever its scope holds would travel unscrubbed. Nothing of the event is
 * logged, only that one was dropped.
 */
export function scrubEventOrDrop<T extends EventLike>(event: T): T | null {
  try {
    return scrubEvent(event);
  } catch (error) {
    console.error(`[sentry] an event was dropped: the scrub threw ${error instanceof Error ? error.name : typeof error}`);
    return null;
  }
}
