import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  SENSITIVE_HEADERS,
  scrubBreadcrumbUrls,
  scrubSensitiveHeaders,
  scrubSpanUrls,
  scrubTransactionUrls,
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
    const event = scrubTransactionUrls({
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
    expect(() => scrubTransactionUrls({})).not.toThrow();
  });
});

describe("the scrub is actually wired to the thing that sends", () => {
  const instrumentation = readFileSync(join(root, "instrumentation.ts"), "utf-8");

  it("Sentry.init runs every event through it", () => {
    // A pure function nothing calls is decoration. This is the binding.
    expect(instrumentation).toContain("scrubSensitiveHeaders");
    expect(instrumentation).toMatch(/beforeSend/);
  });

  it("Sentry.init runs every span, breadcrumb and transaction through the URL scrub", () => {
    expect(instrumentation).toMatch(/beforeSendSpan:\s*\(span\)\s*=>\s*scrubSpanUrls\(span\)/);
    expect(instrumentation).toMatch(/beforeBreadcrumb:\s*\(breadcrumb\)\s*=>\s*scrubBreadcrumbUrls\(breadcrumb\)/);
    expect(instrumentation).toMatch(/beforeSendTransaction:\s*\(event\)\s*=>\s*scrubTransactionUrls\(event\)/);
  });

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
