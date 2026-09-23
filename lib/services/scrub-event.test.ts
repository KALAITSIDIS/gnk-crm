import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @sentry/core is @sentry/nextjs's own dependency, pinned to the same version
// by the lockfile — which is the point: these are the functions production runs.
import { Scope, ServerRuntimeClient, httpRequestToRequestData, requestDataIntegration } from "@sentry/core";
import type { ErrorEvent, TransactionEvent } from "@sentry/core";
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  SENSITIVE_HEADERS,
  scrubBreadcrumbUrls,
  scrubEvent,
  scrubSensitiveHeaders,
  scrubSpanUrls,
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

describe("the installed SDK's own event, through scrubEvent, carries none of it", () => {
  /**
   * The shapes above are copies; this is the SDK itself. A real client with
   * RequestData and sendDefaultPii off, fed the normalizedRequest the http
   * integration builds from an incoming request (httpRequestToRequestData) —
   * so a new place an SDK upgrade puts the URL, a cookie or the body fails
   * HERE, not in someone else's log.
   */
  async function capture(): Promise<Array<ErrorEvent | TransactionEvent>> {
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
      method: "POST",
      url: `/contacts?q=${SEARCH}`,
      headers: {
        host: "gnk-crm.vercel.app",
        "x-forwarded-proto": "https",
        referer: PAGE,
        cookie: "sb-yjg-auth-token=FAKE-SESSION-TOKEN",
        authorization: "Bearer FAKE-CRON-SECRET",
        "x-gnk-visitor-ip": "198.51.100.22",
        "x-gnk-forward-key": "FAKE-FORWARD-KEY",
      },
    });
    const scope = new Scope();
    scope.setClient(client);
    // The body arrives on the scope the way patchRequestToCaptureBody puts it.
    scope.setSDKProcessingMetadata({ normalizedRequest: { ...normalizedRequest, data: ENQUIRY } });
    client.captureException(new Error("render failed"), {}, scope);
    client.captureEvent(
      {
        type: "transaction",
        transaction: "POST /contacts",
        start_timestamp: 1,
        timestamp: 2,
        contexts: {
          trace: {
            trace_id: "a".repeat(32),
            span_id: "b".repeat(16),
            op: "http.server",
            data: { "http.target": `/contacts?q=${SEARCH}`, "http.request.header.referer": PAGE },
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
    const sent = await capture();
    expect(sent.map((e) => e.type ?? "error")).toEqual(["error", "transaction"]);
    for (const event of sent) {
      expect(JSON.stringify(event)).not.toMatch(LEAKS);
      expect(event.request?.url).toBe(PAGE_PATH);
      expect(event.request?.headers?.cookie).toBe(REDACTED);
      expect(event.request?.method).toBe("POST");
    }
  });
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
    it(`${runtime}: every error AND every transaction goes through scrubEvent`, () => {
      expect(source).toMatch(/beforeSend:\s*\(event\)\s*=>\s*scrubEvent\(event\)/);
      expect(source).toMatch(/beforeSendTransaction:\s*\(event\)\s*=>\s*scrubEvent\(event\)/);
    });

    it(`${runtime}: every span and breadcrumb goes through the URL scrub`, () => {
      expect(source).toMatch(/beforeSendSpan:\s*\(span\)\s*=>\s*scrubSpanUrls\(span\)/);
      expect(source).toMatch(/beforeBreadcrumb:\s*\(breadcrumb\)\s*=>\s*scrubBreadcrumbUrls\(breadcrumb\)/);
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
