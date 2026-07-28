import { describe, expect, it } from "vitest";
import { parseCspReport, violationKey } from "./csp-report";

/** The shape a browser posts to `report-uri`. */
const reportUriBody = {
  "csp-report": {
    "document-uri": "https://gnk-crm.vercel.app/properties?status=sold&q=smith",
    referrer: "",
    "violated-directive": "script-src 'self'",
    "effective-directive": "script-src",
    "original-policy": "default-src 'self'; script-src 'self' 'nonce-abc'",
    "blocked-uri": "eval",
    "status-code": 200,
    "source-file": "https://gnk-crm.vercel.app/_next/static/chunks/2-abc.js",
    "line-number": 1,
  },
};

/** The shape a browser posts to `report-to`. */
const reportToBody = [
  {
    age: 0,
    type: "csp-violation",
    url: "https://gnk-crm.vercel.app/contacts/1234",
    user_agent: "Mozilla/5.0",
    body: {
      documentURL: "https://gnk-crm.vercel.app/contacts/1234?tab=kyc",
      disposition: "report",
      effectiveDirective: "img-src",
      blockedURL: "https://evil.example.com/x.png",
      originalPolicy: "default-src 'self'",
      sourceFile: "https://gnk-crm.vercel.app/app.js",
      lineNumber: 42,
    },
  },
];

describe("parseCspReport — report-uri format", () => {
  it("extracts the directive, blocked URI and source", () => {
    const [v] = parseCspReport(reportUriBody);
    expect(v).toMatchObject({
      directive: "script-src",
      blockedUri: "eval",
      lineNumber: 1,
    });
    expect(v.sourceFile).toContain("/_next/static/chunks/");
  });

  it("keeps only the PATH of the document URI — query strings can hold filters", () => {
    const [v] = parseCspReport(reportUriBody);
    expect(v.documentPath).toBe("/properties");
    expect(JSON.stringify(v)).not.toContain("smith");
  });

  it("prefers effective-directive but falls back to violated-directive", () => {
    // older browsers send only `violated-directive`, which carries the full
    // source expression rather than the bare directive name
    const rest: Record<string, unknown> = { ...reportUriBody["csp-report"] };
    delete rest["effective-directive"];
    expect(parseCspReport({ "csp-report": rest })[0].directive).toBe("script-src 'self'");
  });
});

describe("parseCspReport — report-to format", () => {
  it("reads the camelCased body out of the envelope", () => {
    const [v] = parseCspReport(reportToBody);
    expect(v).toMatchObject({
      directive: "img-src",
      blockedUri: "https://evil.example.com/x.png",
      documentPath: "/contacts/1234",
      lineNumber: 42,
    });
  });

  it("ignores envelopes that are not CSP violations", () => {
    const mixed = [{ type: "deprecation", body: { id: "x" } }, ...reportToBody];
    expect(parseCspReport(mixed)).toHaveLength(1);
  });
});

describe("parseCspReport — hostile and malformed input", () => {
  // The endpoint is public: anyone on the internet can POST to it, so the
  // parser must degrade to [] rather than throw.
  it.each([
    ["null", null],
    ["a string", "not a report"],
    ["a number", 42],
    ["an empty object", {}],
    ["an empty array", []],
    ["a report with no directive", { "csp-report": { "blocked-uri": "eval" } }],
    ["a nested array", [[{ type: "csp-violation" }]]],
    ["an envelope with no body", [{ type: "csp-violation" }]],
  ])("returns [] for %s", (_label, input) => {
    expect(parseCspReport(input)).toEqual([]);
  });

  it("survives a document-uri that is not a URL", () => {
    const [v] = parseCspReport({
      "csp-report": { "effective-directive": "script-src", "document-uri": "about:blank" },
    });
    expect(v.documentPath).toBe("about:blank");
    expect(v.blockedUri).toBe("unknown");
  });
});

describe("violationKey", () => {
  it("groups the same violation from different pages together", () => {
    const a = parseCspReport(reportUriBody)[0];
    const b = { ...a, documentPath: "/contacts" };
    // the operator wants the distinct set of blocked things, not one line per
    // page view
    expect(violationKey(a)).toBe(violationKey(b));
  });

  it("separates different directives and different sources", () => {
    const a = parseCspReport(reportUriBody)[0];
    expect(violationKey(a)).not.toBe(violationKey({ ...a, directive: "img-src" }));
    expect(violationKey(a)).not.toBe(violationKey({ ...a, sourceFile: "other.js" }));
  });
});
