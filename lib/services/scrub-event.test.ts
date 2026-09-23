import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @sentry/core is @sentry/nextjs's own dependency, pinned to the same version
// by the lockfile — which is the point: these are the functions production runs.
import {
  Scope,
  ServerRuntimeClient,
  dynamicSamplingContextToSentryBaggageHeader,
  getCurrentScope,
  getDynamicSamplingContextFromSpan,
  httpHeadersToSpanAttributes,
  httpRequestToRequestData,
  requestDataIntegration,
  setCurrentClient,
} from "@sentry/core";
// What @sentry/nextjs's server build runs on (@sentry/node's own dependencies).
import { SpanKind } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { enhanceDscWithOpenTelemetryRootSpanName } from "@sentry/opentelemetry";
import type { ErrorEvent, TransactionEvent } from "@sentry/core";
import { describe, expect, it, vi } from "vitest";
import {
  REDACTED,
  SENSITIVE_HEADERS,
  TOKEN_SEGMENT,
  redactPathTokens,
  scrubBreadcrumbUrls,
  scrubDsc,
  scrubEvent,
  scrubEventOrDrop,
  scrubSensitiveHeaders,
  scrubSpanUrls,
  scrubUrlText,
  stripUrlQueries,
} from "./scrub-event";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("nothing of ours travels in an error report", () => {
  it("redacts the visitor's raw address — the legal page promises it is never stored", () => {
    const e = scrubSensitiveHeaders({
      request: { headers: { "x-gnk-visitor-ip": "198.51.100.22", "user-agent": "curl/8" } },
    });
    expect(e.request!.headers!["x-gnk-visitor-ip"]).toBe(REDACTED);
    expect(e.request!.headers!["user-agent"], "everything else is left alone").toBe("curl/8");
  });

  it("redacts the forward key — a secret in someone else's log is not yours", () => {
    const e = scrubSensitiveHeaders({ request: { headers: { "x-gnk-forward-key": "s3cret" } } });
    expect(JSON.stringify(e)).not.toContain("s3cret");
  });

  it("matches however the header was cased on the wire", () => {
    const e = scrubSensitiveHeaders({ request: { headers: { "X-GNK-Visitor-IP": "198.51.100.22" } } });
    expect(e.request!.headers!["X-GNK-Visitor-IP"]).toBe(REDACTED);
  });

  it("says the header was THERE, rather than deleting it — that is what a debugger needs", () => {
    const e = scrubSensitiveHeaders({ request: { headers: { "x-gnk-forward-key": "s3cret" } } });
    expect(Object.keys(e.request!.headers!)).toContain("x-gnk-forward-key");
  });

  it("survives an event with no request, no headers, or empty headers", () => {
    expect(() => scrubSensitiveHeaders({})).not.toThrow();
    expect(() => scrubSensitiveHeaders({ request: {} })).not.toThrow();
    expect(scrubSensitiveHeaders({ request: { headers: {} } }).request!.headers).toEqual({});
  });
});

/**
 * A PostgREST read's filter is its query string — the lookup behind
 * "Possible existing contact" sends up to a page of enquirers' e-mails and
 * phones in one (T-enquiry-contact-suggestions). The shapes below are the
 * ones @sentry/node-core 10 and Next's fetch tracing actually record
 * (undici-instrumentation.js: url.full / url.query; outgoingFetchRequest.js:
 * breadcrumb url + http.query / http.fragment; Next: span name + http.url).
 */
const LOOKUP =
  'https://yjgirvzgoiywdojnpkpd.supabase.co/rest/v1/contacts?select=id&or=(email.in.("maria@example.invalid"),phone_e164.in.("+35799123456"))';
const BASE = "https://yjgirvzgoiywdojnpkpd.supabase.co/rest/v1/contacts";

describe("no outgoing URL carries its query into a span, breadcrumb or trace", () => {
  it("cuts every absolute URL in a text at its query or fragment, and leaves other text alone", () => {
    expect(stripUrlQueries(LOOKUP)).toBe(BASE);
    expect(stripUrlQueries(`fetch GET ${LOOKUP}`)).toBe(`fetch GET ${BASE}`);
    expect(stripUrlQueries("https://example.invalid/a#frag")).toBe("https://example.invalid/a");
    expect(stripUrlQueries("GET /leads?page=2")).toBe("GET /leads?page=2");
    expect(stripUrlQueries("no url here")).toBe("no url here");
  });

  it("scrubs a node-fetch span: url.full keeps its path, url.query goes", () => {
    const span = scrubSpanUrls({
      description: `GET ${LOOKUP}`,
      data: {
        "url.full": LOOKUP,
        "url.query": LOOKUP.slice(LOOKUP.indexOf("?")),
        "url.path": "/rest/v1/contacts",
        "http.request.method": "GET",
        "server.port": 443,
      } as Record<string, unknown>,
    });
    expect(span.data["url.full"]).toBe(BASE);
    expect(span.data).not.toHaveProperty("url.query");
    expect(span.data["url.path"]).toBe("/rest/v1/contacts");
    expect(span.data["server.port"]).toBe(443);
    expect(span.description).toBe(`GET ${BASE}`);
    expect(JSON.stringify(span)).not.toMatch(/maria|35799123456/);
  });

  it("scrubs Next's fetch span, whose NAME is the whole URL", () => {
    const span = scrubSpanUrls({
      description: `fetch GET ${LOOKUP}`,
      data: { "http.url": LOOKUP, "next.span_name": `fetch GET ${LOOKUP}` } as Record<string, unknown>,
    });
    expect(JSON.stringify(span)).not.toMatch(/maria|35799123456/);
    expect(span.data["http.url"]).toBe(BASE);
  });

  it("scrubs a fetch breadcrumb's query and fragment, keeping method, url and status", () => {
    const crumb = scrubBreadcrumbUrls({
      category: "http",
      data: {
        url: BASE,
        "http.method": "GET",
        "http.query": "?or=(email.in.(%22maria%40example.invalid%22))",
        "http.fragment": "#x",
        status_code: 200,
      } as Record<string, unknown>,
    });
    expect(crumb.data).toEqual({ url: BASE, "http.method": "GET", status_code: 200 });
  });

  it("scrubs every span of a sampled transaction, and the root span's data", () => {
    const event = scrubEvent({
      spans: [
        { description: `GET ${LOOKUP}`, data: { "url.full": LOOKUP } as Record<string, unknown> },
        { description: "render", data: {} },
      ],
      contexts: { trace: { data: { "http.url": LOOKUP } as Record<string, unknown> } },
    });
    expect(JSON.stringify(event)).not.toMatch(/maria|35799123456/);
    expect(event.spans[1]!.description).toBe("render");
  });

  it("survives a span, breadcrumb or transaction with no data at all", () => {
    expect(() => scrubSpanUrls({})).not.toThrow();
    expect(() => scrubBreadcrumbUrls({})).not.toThrow();
    expect(() => scrubEvent({})).not.toThrow();
  });
});

/**
 * An INCOMING request (T-sentry-incoming-request-scrub, 2026-09-23). Every
 * shape below was MEASURED through the real @sentry/nextjs 10.65 server
 * pipeline (a local http server, Next's root-span attributes, Next's
 * onRequestError arguments) and read out of @sentry/browser 10.65:
 *
 *   - Next's root span sets `http.target` to the RELATIVE req.url
 *     (base-server.js; the app-page and app-route templates), and the SDK
 *     copies the request headers onto it as `http.request.header.*`
 *     (addHeadersAsAttributes) — the referer included.
 *   - onRequestError's `path` is req.url; captureRequestError files it as
 *     `contexts.nextjs.request_path`.
 *   - The http integration puts the ABSOLUTE url, the raw query_string, every
 *     header and the request BODY on the isolation scope, and RequestData
 *     copies them onto errors AND transactions as `event.request`. With
 *     sendDefaultPii off too: `queryParams` and `cookies` default to
 *     `{deny: [...]}`, which is `!== false`, so both are included — the deny
 *     lists are applied to span attributes, never to `event.request` — and
 *     the body is captured whenever anything listens for "data" on the
 *     request, which Next's own body clone for the proxy does.
 *   - The browser: `request.url` is location.href, `Referer` is
 *     document.referrer, pageload and navigation spans carry `url.full`, and
 *     a navigation breadcrumb's `to` is the relative "/contacts?q=…".
 */
const SEARCH = "maria%40example.invalid";
const PAGE = `https://gnk-crm.vercel.app/contacts?q=${SEARCH}`;
const PAGE_PATH = "https://gnk-crm.vercel.app/contacts";
const TARGET = `/contacts?q=${SEARCH}&_rsc=1x2y3`;
const ENQUIRY = JSON.stringify({ name: "Maria Enquirer", email: "maria@example.invalid", phone: "+35799123456" });
const LEAKS = /maria|35799123456|FAKE-SESSION-TOKEN|FAKE-CRON-SECRET|FAKE-FORWARD-KEY|198\.51\.100\.22/i;

describe("no incoming request's query, cookie, secret or body travels in an error or a transaction", () => {
  it("cuts a value that is itself a relative URL at its query or fragment, keeping the path", () => {
    expect(stripUrlQueries(TARGET)).toBe("/contacts");
    expect(stripUrlQueries("/contacts#top")).toBe("/contacts");
    expect(stripUrlQueries("//gnk-crm.vercel.app/contacts?q=x")).toBe("//gnk-crm.vercel.app/contacts");
    expect(stripUrlQueries("/contacts/8f0c"), "a path with no query is left alone").toBe("/contacts/8f0c");
  });

  it("scrubs Next's root span: http.target and the copied referer keep their path", () => {
    const span = scrubSpanUrls({
      description: "GET /contacts",
      data: {
        "http.method": "GET",
        "http.target": TARGET,
        "http.route": "/contacts",
        "next.route": "/contacts",
        "http.request.header.referer": PAGE,
        "http.status_code": 500,
      } as Record<string, unknown>,
    });
    expect(span.data["http.target"]).toBe("/contacts");
    expect(span.data["http.request.header.referer"]).toBe(PAGE_PATH);
    expect(span.data["http.route"]).toBe("/contacts");
    expect(span.data["http.status_code"]).toBe(500);
    expect(JSON.stringify(span)).not.toMatch(LEAKS);
  });

  it("scrubs a server ERROR event from onRequestError: url, query_string, referer, request_path, cookie", () => {
    const event = scrubEvent({
      transaction: "GET /contacts",
      request: {
        method: "GET",
        url: `https://gnk-crm.vercel.app${TARGET}`,
        query_string: `q=${SEARCH}&_rsc=1x2y3`,
        headers: { host: "gnk-crm.vercel.app", referer: PAGE, cookie: "sb-yjg-auth-token=FAKE-SESSION-TOKEN; theme=dark" },
        cookies: { "sb-yjg-auth-token": "FAKE-SESSION-TOKEN", theme: "dark" },
      },
      contexts: {
        nextjs: { request_path: TARGET, router_kind: "App Router", router_path: "/contacts", route_type: "render" },
      },
    });
    expect(JSON.stringify(event)).not.toMatch(LEAKS);
    expect(event.request.url, "the path is what a person debugging needs").toBe(PAGE_PATH);
    expect(event.request).not.toHaveProperty("query_string");
    expect(event.request).not.toHaveProperty("cookies");
    expect(event.request.headers.referer).toBe(PAGE_PATH);
    expect(event.request.headers.cookie, "present and unreadable, like our other headers").toBe(REDACTED);
    expect(event.request.headers.host).toBe("gnk-crm.vercel.app");
    expect(event.contexts.nextjs.request_path).toBe("/contacts");
    expect(event.contexts.nextjs.router_path).toBe("/contacts");
  });

  it("scrubs a sampled TRANSACTION: the root span's data and the request RequestData put on it", () => {
    const event = scrubEvent({
      type: "transaction",
      transaction: "GET /contacts",
      contexts: {
        trace: {
          op: "http.server",
          data: { "http.target": TARGET, "http.request.header.referer": PAGE, "http.route": "/contacts" } as Record<string, unknown>,
        },
      },
      request: {
        url: PAGE_PATH,
        query_string: `q=${SEARCH}&_rsc=1x2y3`,
        headers: { referer: PAGE, cookie: "sb-yjg-auth-token=FAKE-SESSION-TOKEN" },
        cookies: { "sb-yjg-auth-token": "FAKE-SESSION-TOKEN" },
      },
      spans: [],
    });
    expect(JSON.stringify(event)).not.toMatch(LEAKS);
    expect(event.contexts.trace.data["http.target"]).toBe("/contacts");
    expect(event.request).not.toHaveProperty("query_string");
  });

  it("redacts the enquiry door's two headers and a bearer secret on a TRANSACTION too, and drops the body", () => {
    // A sampled transaction of the site's POST carries event.request exactly
    // as an error does; until now only beforeSend redacted our headers.
    const event = scrubEvent({
      type: "transaction",
      request: {
        method: "POST",
        url: "https://gnk-crm.vercel.app/api/public/enquiries",
        headers: {
          "x-gnk-visitor-ip": "198.51.100.22",
          "x-gnk-forward-key": "FAKE-FORWARD-KEY",
          authorization: "Bearer FAKE-CRON-SECRET",
          "content-type": "application/json",
        },
        data: ENQUIRY,
      },
    });
    expect(JSON.stringify(event)).not.toMatch(LEAKS);
    expect(event.request.headers["x-gnk-visitor-ip"]).toBe(REDACTED);
    expect(event.request.headers.authorization).toBe(REDACTED);
    expect(event.request.headers["content-type"]).toBe("application/json");
    expect(event.request).not.toHaveProperty("data");
    expect(event.request.url).toBe("https://gnk-crm.vercel.app/api/public/enquiries");
  });

  it("scrubs a BROWSER event: location.href, Referer, the pageload span's url.full", () => {
    const event = scrubEvent({
      type: "transaction",
      transaction: "/contacts",
      request: { url: PAGE, headers: { Referer: PAGE, "User-Agent": "Mozilla/5.0" } },
      contexts: { trace: { op: "pageload", data: { "url.full": PAGE, "url.path": "/contacts" } as Record<string, unknown> } },
    });
    expect(JSON.stringify(event)).not.toMatch(LEAKS);
    expect(event.request.url).toBe(PAGE_PATH);
    expect(event.request.headers.Referer).toBe(PAGE_PATH);
    expect(event.request.headers["User-Agent"]).toBe("Mozilla/5.0");
  });

  it("scrubs a browser navigation breadcrumb and a relative fetch span", () => {
    const crumb = scrubBreadcrumbUrls({ category: "navigation", data: { from: "/contacts", to: `/contacts?q=${SEARCH}` } });
    expect(crumb.data).toEqual({ from: "/contacts", to: "/contacts" });
    const span = scrubSpanUrls({
      description: "GET /contacts",
      data: { url: TARGET, type: "fetch", "http.method": "GET", "http.query": `?q=${SEARCH}` } as Record<string, unknown>,
    });
    expect(span.data).toEqual({ url: "/contacts", type: "fetch", "http.method": "GET" });
  });

  it("never throws on an odd shape — a throw makes the SDK drop the event and send its own error instead", () => {
    // Measured: "Event processing pipeline threw an error, original event will not be sent".
    const odd = {
      request: { headers: { n: 1, u: undefined } as unknown as Record<string, string>, url: 5 as unknown as string },
      contexts: { a: null, b: "text", c: { data: null } } as Record<string, unknown>,
      spans: [{}, { data: undefined }],
      breadcrumbs: [{}, { data: { to: 3 } }],
    };
    expect(() => scrubEvent(odd)).not.toThrow();
    expect(() => scrubEvent({ request: {} })).not.toThrow();
  });
});

describe("what the independent review found (2026-09-23)", () => {
  it("redacts every header the SDK's OWN filter would — it applies that filter to span attributes, never to event.request", () => {
    // The SDK judges a header by fragments of its NAME (auth, token, key,
    // session, cookie, -ip, forwarded, …) when it copies headers onto a span;
    // RequestData copies event.request.headers raw. Its filter is the oracle,
    // so a fragment an SDK upgrade adds is caught here. Cookie is covered
    // above (the SDK splits it per cookie).
    const names = [
      "authorization", "proxy-authorization", "x-vercel-oidc-token", "x-vercel-ip-city",
      "x-vercel-ip-latitude", "x-vercel-ip-longitude", "x-vercel-ip-postal-code", "x-vercel-ip-country",
      "x-forwarded-host", "x-forwarded-for", "x-real-ip", "x-gnk-visitor-ip", "x-gnk-forward-key",
      "x-csrf-token", "x-session-id", "x-api-key", "via", "x-remote-user", "x-jwt-assertion",
      "host", "user-agent", "accept", "content-type", "x-matched-path", "next-router-state-tree",
      "sentry-trace", "baggage", "rsc", "next-url",
    ];
    const headers = Object.fromEntries(names.map((n) => [n, `value-of-${n}`]));
    const sdk = httpHeadersToSpanAttributes(headers, false);
    const sdkFilters = (n: string) => sdk[`http.request.header.${n.replace(/-/g, "_")}`] === "[Filtered]";
    expect(sdkFilters("x-vercel-oidc-token") && sdkFilters("x-vercel-ip-city"), "the oracle still filters").toBe(true);

    const event = scrubEvent({ request: { headers: { ...headers } } });
    for (const name of names) {
      const expected = sdkFilters(name) ? REDACTED : `value-of-${name}`;
      expect(event.request.headers[name], name).toBe(expected);
    }
  });

  it("also redacts a bypass secret and a request signature, which the SDK's fragments miss", () => {
    const event = scrubEvent({
      request: { headers: { "x-vercel-protection-bypass": "FAKE-BYPASS", "x-request-signature": "FAKE-SIG" } },
    });
    expect(event.request.headers).toEqual({ "x-vercel-protection-bypass": REDACTED, "x-request-signature": REDACTED });
  });

  it("cuts a browser stack frame's filename — the SDK falls back to location.href — and URLs in the message", () => {
    // globalhandlers.js: `filename: getFilenameFromUrl(url) ?? getLocationHref()`,
    // and an inline script's frames are the page URL itself.
    const event = scrubEvent({
      message: `GET ${PAGE} failed`,
      exception: {
        values: [
          {
            type: "Error",
            value: `Failed to load ${PAGE}`,
            stacktrace: {
              frames: [
                { filename: PAGE, abs_path: PAGE, function: "?", in_app: true },
                { filename: "/var/task/.next/server/chunks/815.js", function: "render" },
                { filename: "app:///_next/static/chunks/app/page.js", function: "x" },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(event)).not.toMatch(LEAKS);
    const [value] = event.exception.values;
    expect(value!.stacktrace.frames[0]!.filename).toBe(PAGE_PATH);
    expect(value!.stacktrace.frames[0]!.abs_path).toBe(PAGE_PATH);
    expect(value!.stacktrace.frames[1]!.filename).toBe("/var/task/.next/server/chunks/815.js");
    expect(value!.stacktrace.frames[2]!.filename).toBe("app:///_next/static/chunks/app/page.js");
    expect(value!.value).toBe(`Failed to load ${PAGE_PATH}`);
    expect(event.message).toBe(`GET ${PAGE_PATH} failed`);
  });

  it("cuts a console breadcrumb's logged strings — Next logs 'Failed to fetch RSC payload for <url>'", () => {
    const logged = { url: PAGE };
    const line = `Failed to fetch RSC payload for ${PAGE}. Falling back to browser navigation.`;
    const crumb = scrubBreadcrumbUrls({
      category: "console",
      message: line,
      data: { arguments: [line, 42, logged], logger: "console" },
    });
    expect(crumb.message).not.toMatch(LEAKS);
    // The cut runs to the next whitespace, so the full stop Next puts straight
    // after the URL goes with the query.
    expect(crumb.data.arguments[0]).toBe(`Failed to fetch RSC payload for ${PAGE_PATH} Falling back to browser navigation.`);
    expect(crumb.data.arguments[1]).toBe(42);
    // The arguments are the app's OWN objects, and beforeBreadcrumb runs
    // before the SDK copies them: a logged object is never rewritten.
    expect(logged.url).toBe(PAGE);
  });

  it("drops the event — null — when the scrub throws; the SDK's replacement would skip beforeSend", () => {
    // client.js: the "Event processing pipeline threw" replacement is sent
    // with data.__sentry__ and returns before processBeforeSend.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const hostile = {
      request: {
        get headers(): Record<string, string> {
          throw new Error("hostile shape");
        },
      },
    };
    expect(scrubEventOrDrop(hostile)).toBeNull();
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
    const ordinary = { request: { url: PAGE } };
    expect(scrubEventOrDrop(ordinary)).toBe(ordinary);
    expect(ordinary.request.url).toBe(PAGE_PATH);
  });
});

/**
 * Two routes' PATHS are the credential (T-sentry-path-token-redaction,
 * 2026-09-23): cutting the query, above, kept them whole. Each carrier below
 * is one the scrub already cuts queries from — the same shapes, measured then
 * — now holding a token in its path instead of a search term in its query.
 */
/** 43 base64url characters, the shape isWellFormedShareToken accepts — and made the way the real one is. */
const SHARE_TOKEN = createHash("sha256").update("a fake share link").digest("base64url");
/** 64 hex, the shape the feed route accepts. */
const FEED_TOKEN = createHash("sha256").update("a fake portal feed").digest("hex");
/** Any 8-character chunk of either token (both alphabets are regex-literal): a half-redacted token is still a leak. */
const TOKEN_LEAKS = new RegExp([SHARE_TOKEN, FEED_TOKEN].flatMap((token) => token.match(/.{8}/g)!).join("|"));
const ORIGIN = "https://gnk-crm.vercel.app";

const TOKENISED = [
  { route: "the proposal link", live: `/p/${SHARE_TOKEN}`, kept: "/p/[token]", name: "GET /p/[token]" },
  {
    route: "the portal feed",
    live: `/api/portals/bazaraki/${FEED_TOKEN}`,
    kept: "/api/portals/bazaraki/[token]",
    name: "GET /api/portals/[portal]/[token]",
  },
] as const;

describe("no tokenised route's secret travels in its path", () => {
  it("replaces the secret segment wherever a path starts, keeping the rest of the path", () => {
    for (const [text, expected] of [
      [`/p/${SHARE_TOKEN}`, "/p/[token]"],
      [`/p/${SHARE_TOKEN}/`, "/p/[token]/"],
      [`${ORIGIN}/p/${SHARE_TOKEN}`, `${ORIGIN}/p/[token]`],
      [`//gnk-crm.vercel.app/p/${SHARE_TOKEN}`, "//gnk-crm.vercel.app/p/[token]"],
      [`http://localhost:3000/p/${SHARE_TOKEN}`, "http://localhost:3000/p/[token]"],
      [`GET /p/${SHARE_TOKEN}`, "GET /p/[token]"],
      [`a[title="${ORIGIN}/p/${SHARE_TOKEN}"]`, `a[title="${ORIGIN}/p/[token]"]`],
      [`/api/portals/bazaraki/${FEED_TOKEN}`, "/api/portals/bazaraki/[token]"],
      [`${ORIGIN}/api/portals/prian/${FEED_TOKEN}`, `${ORIGIN}/api/portals/prian/[token]`],
    ] as const) {
      expect(redactPathTokens(text), text).toBe(expected);
    }
  });

  it("leaves a route's own name, a file path and every other path alone", () => {
    for (const text of [
      "GET /p/[token]",
      "/api/portals/[portal]/[token]",
      "/var/task/.next/server/app/p/[token]/page.js",
      "app:///_next/static/chunks/app/p/%5Btoken%5D/page-4f2a.js",
      "/contacts/8f0c",
      "/api/portals/bazaraki",
      "/p",
      "/pages/1",
      "https://example.invalid/shop/p/42",
    ]) {
      expect(redactPathTokens(text), text).toBe(text);
    }
  });

  it("cuts the query AND the token when a value has both", () => {
    expect(scrubUrlText(`${ORIGIN}/p/${SHARE_TOKEN}?_rsc=1x2y3`)).toBe(`${ORIGIN}/p/[token]`);
    expect(scrubUrlText(`/api/portals/bazaraki/${FEED_TOKEN}?page=2#x`)).toBe("/api/portals/bazaraki/[token]");
  });

  for (const { route, live, kept, name } of TOKENISED) {
    describe(route, () => {
      it("a server ERROR event: request.url, the referer, onRequestError's request_path", () => {
        const event = scrubEvent({
          transaction: name,
          request: {
            method: "GET",
            url: `${ORIGIN}${live}`,
            headers: { host: "gnk-crm.vercel.app", referer: `${ORIGIN}${live}`, "x-matched-path": name.slice(4) },
          },
          contexts: { nextjs: { request_path: live, router_path: name.slice(4), route_type: "render" } },
        });
        expect(JSON.stringify(event)).not.toMatch(TOKEN_LEAKS);
        expect(event.request.url, "the path is what a person debugging needs").toBe(`${ORIGIN}${kept}`);
        expect(event.request.headers.referer).toBe(`${ORIGIN}${kept}`);
        expect(event.contexts.nextjs.request_path).toBe(kept);
        expect(event.transaction, "already the route's name").toBe(name);
        expect(event.request.headers["x-matched-path"]).toBe(name.slice(4));
      });

      it("Next's root span and a sampled TRANSACTION: http.target, http.url, the copied referer", () => {
        const data = {
          "http.method": "GET",
          "http.target": live,
          "http.url": `${ORIGIN}${live}`,
          "http.route": name.slice(4),
          "next.span_name": name,
          "http.request.header.referer": `${ORIGIN}${live}`,
        };
        const span = scrubSpanUrls({ description: name, data: { ...data } as Record<string, unknown> });
        expect(JSON.stringify(span)).not.toMatch(TOKEN_LEAKS);
        expect(span.data["http.target"]).toBe(kept);
        expect(span.data["http.route"]).toBe(name.slice(4));
        const event = scrubEvent({
          type: "transaction",
          transaction: name,
          contexts: { trace: { op: "http.server", data: { ...data } as Record<string, unknown> } },
          request: { url: `${ORIGIN}${live}`, headers: { referer: `${ORIGIN}${live}` } },
          spans: [{ description: name, data: { ...data } as Record<string, unknown> }],
        });
        expect(JSON.stringify(event)).not.toMatch(TOKEN_LEAKS);
        expect(event.contexts.trace.data["http.url"]).toBe(`${ORIGIN}${kept}`);
      });

      it("a BROWSER event: location.href, Referer, the pageload's url.full, a pageload named by its raw path", () => {
        // The route manifest withSentryConfig injects names a pageload
        // `/p/[token]`; where it has no match, the name IS the raw pathname
        // (appRouterRoutingInstrumentation.js, source "url").
        const event = scrubEvent({
          type: "transaction",
          transaction: live,
          request: { url: `${ORIGIN}${live}`, headers: { Referer: `${ORIGIN}${live}`, "User-Agent": "Mozilla/5.0" } },
          contexts: {
            trace: { op: "pageload", data: { "url.full": `${ORIGIN}${live}`, "url.path": live } as Record<string, unknown> },
          },
        });
        expect(JSON.stringify(event)).not.toMatch(TOKEN_LEAKS);
        expect(event.transaction).toBe(kept);
        expect(event.request.url).toBe(`${ORIGIN}${kept}`);
        expect(event.request.headers.Referer).toBe(`${ORIGIN}${kept}`);
        expect(event.contexts.trace.data["url.path"]).toBe(kept);
      });

      it("a navigation breadcrumb, a logged URL and an exception message", () => {
        const crumb = scrubBreadcrumbUrls({ category: "navigation", data: { from: live, to: "/" } });
        expect(crumb.data).toEqual({ from: kept, to: "/" });
        const logged = scrubBreadcrumbUrls({
          category: "console",
          message: `Failed to fetch RSC payload for ${ORIGIN}${live}?_rsc=1x2y3. Falling back to browser navigation.`,
          data: { arguments: [`GET ${live} 500`] },
        });
        expect(JSON.stringify(logged)).not.toMatch(TOKEN_LEAKS);
        expect(logged.data.arguments[0]).toBe(`GET ${kept} 500`);
        const event = scrubEvent({
          message: `GET ${ORIGIN}${live} failed`,
          exception: { values: [{ type: "Error", value: `Failed to load ${ORIGIN}${live}`, stacktrace: { frames: [] } }] },
        });
        expect(JSON.stringify(event)).not.toMatch(TOKEN_LEAKS);
        expect(event.message).toBe(`GET ${ORIGIN}${kept} failed`);
      });
    });
  }

  it("the proposal page's interest POST: its Referer IS the link, and its body holds the token", () => {
    // interest-form.tsx posts from /p/<token>, and our Referrer-Policy
    // (strict-origin-when-cross-origin, next.config.ts) sends the WHOLE URL on
    // a same-origin request.
    const event = scrubEvent({
      type: "transaction",
      request: {
        method: "POST",
        url: `${ORIGIN}/api/public/proposals/interest`,
        headers: { referer: `${ORIGIN}/p/${SHARE_TOKEN}`, "content-type": "application/json" },
        data: JSON.stringify({ token: SHARE_TOKEN, name: "Maria Enquirer" }),
      },
    });
    expect(JSON.stringify(event)).not.toMatch(TOKEN_LEAKS);
    expect(event.request.headers.referer).toBe(`${ORIGIN}/p/[token]`);
    expect(event.request.url).toBe(`${ORIGIN}/api/public/proposals/interest`);
  });

  it("an RSC request made FROM the proposal page: next-url and the router state tree", () => {
    // None leaves the page today (no Link, router call or action on it); Next
    // would send both headers the day one does, and the SDK copies them onto
    // the root span as well as event.request.
    const tree = encodeURIComponent(
      JSON.stringify([
        "",
        { children: ["p", { children: [["token", SHARE_TOKEN, "d", null], { children: ["__PAGE__", {}] }] }] },
        null,
        null,
        true,
      ]),
    );
    const event = scrubEvent({
      request: { url: `${ORIGIN}/`, headers: { rsc: "1", "next-url": `/p/${SHARE_TOKEN}`, "next-router-state-tree": tree } },
      contexts: { trace: { data: { "http.request.header.next_router_state_tree": tree } as Record<string, unknown> } },
    });
    expect(JSON.stringify(event)).not.toMatch(TOKEN_LEAKS);
    expect(event.request.headers["next-url"]).toBe("/p/[token]");
    const cleaned = JSON.parse(decodeURIComponent(event.request.headers["next-router-state-tree"]!));
    expect(cleaned[1].children[1].children[0], "the tree keeps its shape").toEqual(["token", TOKEN_SEGMENT, "d", null]);
    expect(event.contexts.trace.data["http.request.header.next_router_state_tree"]).toBe(
      event.request.headers["next-router-state-tree"],
    );
  });
});

describe("app/ holds no secret path segment the scrub does not know", () => {
  /**
   * Every dynamic segment in app/, classified. A new one fails here until
   * someone decides whether its value is a credential — and a new tokenised
   * route fails the second test until redactPathTokens covers it.
   */
  const SEGMENTS: Record<string, string> = {
    id: "a record's uuid: reaching the page needs a signed-in session",
    portal: "a portal's public name from the registry",
    token: "THE CREDENTIAL: redactPathTokens replaces it",
  };
  const routes = readdirSync(join(root, "app"), { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, "/"))
    .filter((file) => /(^|\/)(page|route)\.tsx?$/.test(file))
    .map((file) => `/${file.split("/").slice(0, -1).filter((part) => !/^\(.*\)$/.test(part)).join("/")}`)
    .filter((route) => route.includes("["));

  it("every dynamic segment is one of the classified names", () => {
    const names = new Set(routes.flatMap((route) => [...route.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!)));
    expect(names.size, "the walk found the dynamic routes").toBeGreaterThan(0);
    for (const n of names) expect(Object.keys(SEGMENTS), `[${n}] is unclassified`).toContain(n);
  });

  it("every route with a [token] segment loses it, on any origin", () => {
    const tokenised = routes.filter((route) => route.includes("[token]")).sort();
    expect(tokenised).toEqual(["/api/portals/[portal]/[token]", "/p/[token]"]);
    for (const route of tokenised) {
      const named = route.replace("[portal]", "bazaraki");
      const live = named.replace("[token]", SHARE_TOKEN);
      expect(redactPathTokens(live), route).toBe(named);
      expect(redactPathTokens(`https://preview-abc.vercel.app${live}?_rsc=1`), route).toBe(
        `https://preview-abc.vercel.app${named}?_rsc=1`,
      );
    }
  });
});

describe("what the path-token review found (2026-09-23)", () => {
  it("redacts a percent-encoded path, a doubled slash, and every URL in one value", () => {
    for (const [text, expected] of [
      // A transaction name inside a `baggage` header, and an encoded URL.
      [`sentry-transaction=GET%20%2Fp%2F${SHARE_TOKEN},sentry-sampled=true`, "sentry-transaction=GET%20%2Fp%2F[token],sentry-sampled=true"],
      [`https%3A%2F%2Fgnk-crm.vercel.app%2Fp%2F${SHARE_TOKEN}`, "https%3A%2F%2Fgnk-crm.vercel.app%2Fp%2F[token]"],
      [`%2Fapi%2Fportals%2Fbazaraki%2F${FEED_TOKEN}`, "%2Fapi%2Fportals%2Fbazaraki%2F[token]"],
      // The token's own alphabet ends it, so a separator is never swallowed.
      [`/p/${SHARE_TOKEN},/p/${SHARE_TOKEN}`, "/p/[token],/p/[token]"],
      [`${ORIGIN}/p/${SHARE_TOKEN}|${ORIGIN}/p/${SHARE_TOKEN}`, `${ORIGIN}/p/[token]|${ORIGIN}/p/[token]`],
      [`(/p/${SHARE_TOKEN})(/p/${SHARE_TOKEN})`, "(/p/[token])(/p/[token])"],
      [`/p/${SHARE_TOKEN}:12:5`, "/p/[token]:12:5"],
      // A garbled copy of a real link still opens the page.
      [`${ORIGIN}//p/${SHARE_TOKEN}`, `${ORIGIN}//p/[token]`],
      [`//p/${SHARE_TOKEN}`, "//p/[token]"],
      [`/p//${SHARE_TOKEN}`, "/p//[token]"],
      [`/api//portals/bazaraki/${FEED_TOKEN}`, "/api//portals/bazaraki/[token]"],
      // Vercel's routing hands a route's params over as a prefixed query.
      [`GET /p/${SHARE_TOKEN}?nxtPtoken=${SHARE_TOKEN}`, "GET /p/[token]?nxtPtoken=[token]"],
    ] as const) {
      expect(redactPathTokens(text), text).toBe(expected);
    }
  });

  it("the interest POST's baggage header, and a string in tags or extra", () => {
    const event = scrubEvent({
      request: {
        url: `${ORIGIN}/api/public/proposals/interest`,
        headers: { baggage: `sentry-environment=production,sentry-transaction=GET%20%2Fp%2F${SHARE_TOKEN}` },
      },
      contexts: {
        trace: {
          data: { "http.request.header.baggage": `sentry-transaction=GET%20%2Fp%2F${SHARE_TOKEN}` } as Record<string, unknown>,
        },
      },
      tags: { page: `/p/${SHARE_TOKEN}` },
      extra: { arguments: [`${ORIGIN}/p/${SHARE_TOKEN}`] },
    });
    expect(JSON.stringify(event)).not.toMatch(TOKEN_LEAKS);
    expect(event.request.headers.baggage).toBe("sentry-environment=production,sentry-transaction=GET%20%2Fp%2F[token]");
  });

  it("the trace header the page's <meta name=baggage> carries: the SDK's own listener names it from the raw path", () => {
    // On Vercel, Next opens the root span with only http.method and
    // http.target (app-page-runtime.js) — this span, built with the same
    // OpenTelemetry SDK @sentry/node runs — and @sentry/opentelemetry's
    // createDsc listener names the DSC from http.target. No beforeSend* hook
    // sees it: it rides the envelope header and the baggage the browser
    // continues. scrubDsc, registered after it, has the last word.
    function baggage(withScrub: boolean): string | undefined {
      const client = new ServerRuntimeClient({
        dsn: "https://public@o1.ingest.sentry.io/1",
        transport: () => ({ send: async () => ({}), flush: async () => true }),
        stackParser: () => [],
        integrations: [],
        tracesSampleRate: 1,
      });
      setCurrentClient(client);
      client.init();
      enhanceDscWithOpenTelemetryRootSpanName(client);
      if (withScrub) client.on("createDsc", (dsc) => scrubDsc(dsc));
      const span = new BasicTracerProvider().getTracer("next.js").startSpan("GET /p/[token]", {
        kind: SpanKind.SERVER,
        attributes: { "http.method": "GET", "http.target": `/p/${SHARE_TOKEN}` },
      });
      const dsc = getDynamicSamplingContextFromSpan(span as unknown as Parameters<typeof getDynamicSamplingContextFromSpan>[0]);
      span.end();
      getCurrentScope().setClient(undefined);
      return dynamicSamplingContextToSentryBaggageHeader(dsc);
    }
    expect(baggage(false), "the SDK alone puts the token in the trace header").toMatch(TOKEN_LEAKS);
    const cleaned = baggage(true);
    expect(cleaned).not.toMatch(TOKEN_LEAKS);
    expect(cleaned).toContain("sentry-transaction=GET%20%2Fp%2F%5Btoken%5D");
  });

  it("scrubDsc leaves a DSC with no transaction, or a route's name, as it is", () => {
    const none: { transaction?: string } = {};
    scrubDsc(none);
    expect(none).toEqual({});
    const named = { transaction: "GET /api/portals/[portal]/[token]" };
    scrubDsc(named);
    expect(named.transaction).toBe("GET /api/portals/[portal]/[token]");
  });

  it("cuts a long hostile value in linear time — the scrub runs on the browser's main thread", () => {
    // A pattern that rescans the rest of the string from every position is
    // seconds here: the old query cut on "a://" (~2.3 s), an unbounded slash
    // run on "%2F" (7.1 s). Measured after the fix, the worst of 21 hostile
    // 64 KB inputs took 4 ms; the bound is 1 s.
    for (const hostile of ["a://".repeat(16_384), "a.".repeat(32_768), "=//".repeat(21_845), "%2F".repeat(21_845), "/p/".repeat(21_845)]) {
      const started = performance.now();
      scrubUrlText(hostile);
      expect(performance.now() - started, hostile.slice(0, 8)).toBeLessThan(1000);
    }
  });
});

describe("the installed SDK's own event, through scrubEvent, carries none of it", () => {
  /**
   * The shapes above are copies; this one RequestData builds. A real core
   * client with RequestData and sendDefaultPii off, fed the normalizedRequest
   * the http integration builds from an incoming request
   * (httpRequestToRequestData) — so a new place an SDK upgrade makes
   * RequestData put the URL, a cookie or the body fails HERE. It does not run
   * @sentry/nextjs's own hooks, the header copy onto the root span, or the
   * browser SDK; those are the measured shapes above.
   */
  interface Incoming {
    method: string;
    /** req.url as Node hands it over: relative, query and all. */
    url: string;
    /** Next's name for the route: the transaction's, and the root span's route. */
    route: string;
    headers: Record<string, string>;
    body: string;
  }

  const CONTACTS_SEARCH: Incoming = {
    method: "POST",
    url: `/contacts?q=${SEARCH}`,
    route: "/contacts",
    headers: {
      host: "gnk-crm.vercel.app",
      "x-forwarded-proto": "https",
      referer: PAGE,
      cookie: "sb-yjg-auth-token=FAKE-SESSION-TOKEN",
      authorization: "Bearer FAKE-CRON-SECRET",
      "x-gnk-visitor-ip": "198.51.100.22",
      "x-gnk-forward-key": "FAKE-FORWARD-KEY",
    },
    body: ENQUIRY,
  };

  async function capture(incoming: Incoming): Promise<Array<ErrorEvent | TransactionEvent>> {
    const sent: Array<ErrorEvent | TransactionEvent> = [];
    const keep = <T extends ErrorEvent | TransactionEvent>(event: T): null => {
      sent.push(JSON.parse(JSON.stringify({ ...scrubEvent(event), sdkProcessingMetadata: undefined })));
      return null;
    };
    const client = new ServerRuntimeClient({
      dsn: "https://public@o1.ingest.sentry.io/1",
      transport: () => ({ send: async () => ({}), flush: async () => true }),
      stackParser: () => [],
      integrations: [requestDataIntegration()],
      sendDefaultPii: false,
      beforeSend: keep,
      beforeSendTransaction: keep,
    });
    client.init();
    const normalizedRequest = httpRequestToRequestData({
      method: incoming.method,
      url: incoming.url,
      headers: incoming.headers,
    });
    const scope = new Scope();
    scope.setClient(client);
    // The body arrives on the scope the way patchRequestToCaptureBody puts it.
    scope.setSDKProcessingMetadata({ normalizedRequest: { ...normalizedRequest, data: incoming.body } });
    client.captureException(new Error("render failed"), {}, scope);
    client.captureEvent(
      {
        type: "transaction",
        transaction: `${incoming.method} ${incoming.route}`,
        start_timestamp: 1,
        timestamp: 2,
        contexts: {
          trace: {
            trace_id: "a".repeat(32),
            span_id: "b".repeat(16),
            op: "http.server",
            data: {
              "http.target": incoming.url,
              "http.route": incoming.route,
              ...(incoming.headers.referer && { "http.request.header.referer": incoming.headers.referer }),
            },
          },
        },
        spans: [],
      },
      {},
      scope,
    );
    await client.flush(1000);
    return sent;
  }

  it("an error and a transaction both arrive, with the path and without the rest", async () => {
    const sent = await capture(CONTACTS_SEARCH);
    expect(sent.map((e) => e.type ?? "error")).toEqual(["error", "transaction"]);
    for (const event of sent) {
      expect(JSON.stringify(event)).not.toMatch(LEAKS);
      expect(event.request?.url).toBe(PAGE_PATH);
      expect(event.request?.headers?.cookie).toBe(REDACTED);
      expect(event.request?.method).toBe("POST");
    }
  });

  // A buyer opening a proposal link, a portal's crawler pulling its feed, and
  // the proposal page's interest POST, whose Referer is the link itself.
  for (const [what, incoming, kept, referer] of [
    [
      "a buyer opening the proposal link",
      {
        method: "GET",
        url: `/p/${SHARE_TOKEN}`,
        route: "/p/[token]",
        body: "",
        headers: { host: "gnk-crm.vercel.app", "x-forwarded-proto": "https", "user-agent": "Mozilla/5.0" },
      },
      `${ORIGIN}/p/[token]`,
      undefined,
    ],
    [
      "a portal's crawler pulling its feed",
      {
        method: "GET",
        url: `/api/portals/bazaraki/${FEED_TOKEN}?since=1`,
        route: "/api/portals/[portal]/[token]",
        body: "",
        headers: { host: "gnk-crm.vercel.app", "x-forwarded-proto": "https", "user-agent": "BazarakiBot/1.0" },
      },
      `${ORIGIN}/api/portals/bazaraki/[token]`,
      undefined,
    ],
    [
      "the proposal page's interest POST",
      {
        method: "POST",
        url: "/api/public/proposals/interest",
        route: "/api/public/proposals/interest",
        body: JSON.stringify({ token: SHARE_TOKEN, name: "Maria Enquirer" }),
        headers: {
          host: "gnk-crm.vercel.app",
          "x-forwarded-proto": "https",
          referer: `${ORIGIN}/p/${SHARE_TOKEN}`,
          "content-type": "application/json",
        },
      },
      `${ORIGIN}/api/public/proposals/interest`,
      `${ORIGIN}/p/[token]`,
    ],
  ] as const satisfies ReadonlyArray<readonly [string, Incoming, string, string | undefined]>) {
    it(`${what}: the error and the transaction keep the path and lose the token`, async () => {
      const sent = await capture(incoming);
      expect(sent.map((e) => e.type ?? "error")).toEqual(["error", "transaction"]);
      for (const event of sent) {
        expect(JSON.stringify(event)).not.toMatch(TOKEN_LEAKS);
        expect(event.request?.url).toBe(kept);
        expect(event.request?.headers?.referer).toBe(referer);
      }
    });
  }
});

describe("the scrub is actually wired to the thing that sends", () => {
  const instrumentation = readFileSync(join(root, "instrumentation.ts"), "utf-8");
  const client = readFileSync(join(root, "instrumentation-client.ts"), "utf-8");

  // A pure function nothing calls is decoration. These are the bindings — on
  // the server AND in the browser, whose DSN is live in production and whose
  // every event carries location.href.
  for (const [runtime, source] of [
    ["server (instrumentation.ts)", instrumentation],
    ["browser (instrumentation-client.ts)", client],
  ] as const) {
    it(`${runtime}: every error AND every transaction goes through scrubEventOrDrop`, () => {
      // OrDrop: a scrub that throws must drop the event, not hand it to the
      // SDK's replacement path, which skips beforeSend.
      expect(source).toMatch(/beforeSend:\s*\(event\)\s*=>\s*scrubEventOrDrop\(event\)/);
      expect(source).toMatch(/beforeSendTransaction:\s*\(event\)\s*=>\s*scrubEventOrDrop\(event\)/);
    });

    it(`${runtime}: every span and breadcrumb goes through the URL scrub`, () => {
      expect(source).toMatch(/beforeSendSpan:\s*\(span\)\s*=>\s*scrubSpanUrls\(span\)/);
      expect(source).toMatch(/beforeBreadcrumb:\s*\(breadcrumb\)\s*=>\s*scrubBreadcrumbUrls\(breadcrumb\)/);
    });

    it(`${runtime}: the trace header's transaction name goes through scrubDsc, registered AFTER init`, () => {
      // After: the SDK's own createDsc listener is registered by init, and
      // listeners run in order — ours must have the last word.
      const hook = source.search(/getClient\(\)\?\.on\("createDsc",\s*\(dsc\)\s*=>\s*scrubDsc\(dsc\)\)/);
      expect(hook, "the hook is wired").toBeGreaterThan(-1);
      expect(hook, "after Sentry.init").toBeGreaterThan(source.indexOf("Sentry.init("));
    });
  }

  it("every header the route trusts is on the list", () => {
    // The two headers the enquiry door reads by name (route.ts) are exactly
    // the two that must never travel; a third would need adding here.
    const route = readFileSync(join(root, "app", "api", "public", "enquiries", "route.ts"), "utf-8");
    const named = [...route.matchAll(/"(x-gnk-[a-z-]+)"/g)].map((m) => m[1]);
    expect(named.length, "the route names its headers as literals").toBeGreaterThan(0);
    for (const header of named) {
      expect(SENSITIVE_HEADERS as readonly string[], `${header} is unscrubbed`).toContain(header);
    }
  });
});
