import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REDACTED, SENSITIVE_HEADERS, scrubSensitiveHeaders } from "./scrub-event";

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

describe("the scrub is actually wired to the thing that sends", () => {
  const instrumentation = readFileSync(join(root, "instrumentation.ts"), "utf-8");

  it("Sentry.init runs every event through it", () => {
    // A pure function nothing calls is decoration. This is the binding.
    expect(instrumentation).toContain("scrubSensitiveHeaders");
    expect(instrumentation).toMatch(/beforeSend/);
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
