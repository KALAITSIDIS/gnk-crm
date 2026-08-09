import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build script, no types
import { auditScriptTags, nonceFromPolicy } from "./check-csp-nonce.mjs";

/** The exact policy `buildCsp` emits, so the parse is tested against the real shape. */
const POLICY =
  "default-src 'self'; script-src 'self' 'nonce-317865205c064a4cb16415650e472335' 'strict-dynamic'; " +
  "style-src 'self' 'unsafe-inline'; report-uri /api/csp-report; report-to csp-endpoint";

describe("nonceFromPolicy", () => {
  it("reads the nonce out of the policy this app actually sends", () => {
    expect(nonceFromPolicy(POLICY)).toBe("317865205c064a4cb16415650e472335");
  });

  it("returns undefined when script-src carries no nonce", () => {
    expect(nonceFromPolicy("default-src 'self'; script-src 'self'")).toBeUndefined();
  });

  it("returns undefined for a missing header rather than throwing", () => {
    expect(nonceFromPolicy(undefined)).toBeUndefined();
    expect(nonceFromPolicy(null)).toBeUndefined();
  });

  it("does not mistake frame-ancestors-only for a script policy", () => {
    expect(nonceFromPolicy("frame-ancestors 'none'")).toBeUndefined();
  });
});

describe("auditScriptTags", () => {
  const N = "317865205c064a4cb16415650e472335";

  it("counts production's actual failure: tags present, nonces absent", () => {
    // Shape of what gnk-crm.vercel.app/login really served on 2026-08-09.
    const html = `<script src="/_next/static/chunks/1gdpaddb8g4_s.js" async=""></script>
                  <script src="/_next/static/chunks/3ybnd4appz5-0.js" async=""></script>
                  <script>self.__next_f.push([1,"..."])</script>`;
    expect(auditScriptTags(html, N)).toEqual({ total: 3, nonced: 0, bare: 3 });
  });

  it("passes a correctly stamped page", () => {
    const html = `<script nonce="${N}" src="/a.js"></script><script nonce="${N}">x()</script>`;
    expect(auditScriptTags(html, N)).toEqual({ total: 2, nonced: 2, bare: 0 });
  });

  it("does not accept a DIFFERENT nonce as a match", () => {
    // A stale nonce is as fatal as none — it is refused just the same.
    const html = `<script nonce="deadbeef" src="/a.js"></script>`;
    expect(auditScriptTags(html, N)).toEqual({ total: 1, nonced: 0, bare: 1 });
  });

  it("counts opening tags only, not closing ones", () => {
    expect(auditScriptTags(`<script nonce="${N}">x()</script>`, N).total).toBe(1);
  });

  it("reports nothing to check for a page with no scripts", () => {
    expect(auditScriptTags("<html><body>hi</body></html>", N)).toEqual({
      total: 0,
      nonced: 0,
      bare: 0,
    });
  });
});
