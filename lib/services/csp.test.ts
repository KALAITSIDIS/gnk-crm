import { describe, expect, it } from "vitest";
import { buildCsp, originOf } from "./csp";

const HOSTED = "https://yjgirvzgoiywdojnpkpd.supabase.co";
const LOCAL = "http://127.0.0.1:54321";

/** Pull one directive's value out of the assembled header. */
function directive(csp: string, name: string): string | undefined {
  return csp
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1);
}

describe("originOf", () => {
  it("reduces a URL to its origin", () => {
    expect(originOf(`${HOSTED}/rest/v1/contacts?select=*`)).toBe(HOSTED);
    expect(originOf(LOCAL)).toBe(LOCAL);
  });

  it("is undefined for missing or malformed values rather than throwing", () => {
    expect(originOf(undefined)).toBeUndefined();
    expect(originOf("")).toBeUndefined();
    expect(originOf("not a url")).toBeUndefined();
  });
});

describe("buildCsp", () => {
  const base = { nonce: "abc123", isDev: false };

  it("carries the per-request nonce and strict-dynamic on script-src", () => {
    const script = directive(buildCsp(base), "script-src")!;
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).toContain("'self'");
  });

  it("never allows unsafe-eval in production", () => {
    expect(directive(buildCsp(base), "script-src")).not.toContain("unsafe-eval");
  });

  it("allows unsafe-eval and ws in development only — next dev compiles with eval", () => {
    const dev = buildCsp({ ...base, isDev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws:");
  });

  it("derives the Supabase origin for connect-src AND img-src", () => {
    // storage serves property renditions from the same origin as the API
    const csp = buildCsp({ ...base, supabaseUrl: HOSTED });
    expect(directive(csp, "connect-src")).toContain(HOSTED);
    expect(directive(csp, "img-src")).toContain(HOSTED);
  });

  it("allows the websocket origin so Realtime is not blocked", () => {
    const csp = buildCsp({ ...base, supabaseUrl: HOSTED });
    expect(directive(csp, "connect-src")).toContain("wss://yjgirvzgoiywdojnpkpd.supabase.co");
    const local = buildCsp({ ...base, supabaseUrl: LOCAL });
    expect(directive(local, "connect-src")).toContain("ws://127.0.0.1:54321");
  });

  // The OpenFreeMap tile origin is unconditional (B5), so it appears here even
  // with no Supabase and no Sentry. Kept as an exact match on purpose: this
  // assertion exists to catch an origin creeping into an ENFORCED policy.
  it("adds the Sentry origin only when a DSN is configured", () => {
    const without = buildCsp(base);
    expect(directive(without, "connect-src")).toBe("'self' https://tiles.openfreemap.org");

    const withDsn = buildCsp({
      ...base,
      sentryDsn: "https://abc123@o42.ingest.sentry.io/1234",
    });
    expect(directive(withDsn, "connect-src")).toContain("https://o42.ingest.sentry.io");
  });

  it("keeps the dangerous sinks shut", () => {
    const csp = buildCsp(base);
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'self'");
    expect(directive(csp, "form-action")).toBe("'self'");
    expect(directive(csp, "frame-ancestors")).toBe("'none'");
  });

  it("tolerates a malformed Supabase URL instead of emitting a broken directive", () => {
    const csp = buildCsp({ ...base, supabaseUrl: "://nonsense" });
    expect(directive(csp, "connect-src")).toBe("'self' https://tiles.openfreemap.org");
    expect(csp).not.toContain("undefined");
  });

  // The policy is ENFORCED (C1, 2026-08-10). A missing tile origin does not warn
  // — it renders a blank map in production with nothing in the UI to say why.
  it("allows the OpenFreeMap tile origin on img-src and connect-src", () => {
    const csp = buildCsp({ nonce: "n", isDev: false });
    expect(directive(csp, "img-src")).toContain("https://tiles.openfreemap.org");
    expect(directive(csp, "connect-src")).toContain("https://tiles.openfreemap.org");
  });
});
