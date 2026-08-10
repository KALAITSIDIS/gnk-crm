/**
 * TEMPORARY DIAGNOSTIC — IMPROVEMENTS C1. Delete this file, its test, its route
 * and the two `CSP_ECHO_PATH` lines in `proxy.ts` once the nonce drop is
 * root-caused. It exists to answer exactly one question and then go away.
 *
 * **The question.** Production serves `/login` with 22 script tags and 0 nonces
 * while the response header advertises one; the same build under `next start`
 * stamps 22 of 22. Next reads the nonce off the REQUEST
 * (`app-render.js` → `getScriptNonceFromHeader`), so something between
 * `proxy.ts` and the renderer drops what `NextResponse.next({ request: {
 * headers } })` sets. Two candidates remain, and they need different fixes:
 *
 *  1. the override does not propagate on Vercel AT ALL, or
 *  2. it propagates, but the `content-security-policy*` names specifically are
 *     filtered.
 *
 * Setting the report-only name as well was tried on 2026-08-10 (`51e7050`,
 * reverted) and changed nothing, which rules out a filter keyed to one name but
 * not the other. `proxy.ts` sets `x-nonce` on the SAME request object in the
 * SAME call, so whether that one arrives separates 1 from 2 outright.
 *
 * **Why this is safe to expose unauthenticated.** It reports on exactly three
 * hard-coded header names and returns booleans. It never enumerates headers,
 * never touches `cookie` or `authorization`, and never returns a value read off
 * the request — so it cannot become a credential echo if the auth gate above it
 * changes. The one fact it reveals, that a CSP header carries a nonce, is
 * already in the response headers of every page this app serves.
 */

/** Where the diagnostic answers. Exempt from the auth gate in `proxy.ts`. */
export const CSP_ECHO_PATH = "/api/csp-echo";

/** Just enough of `Headers` to read: also satisfied by Next's ReadonlyHeaders. */
type ReadableHeaders = Pick<Headers, "get" | "has">;

export interface CspEchoResult {
  /** did `x-nonce` survive the middleware request-header override? */
  xNonce: boolean;
  /** did `content-security-policy` survive it? */
  contentSecurityPolicy: boolean;
  /** did `content-security-policy-report-only` survive it? */
  contentSecurityPolicyReportOnly: boolean;
  /** does whichever CSP header arrived actually carry a `'nonce-…'`? */
  cspCarriesNonce: boolean;
  /** is that nonce the same one `x-nonce` carries? (both must be present) */
  nonceMatches: boolean;
  /**
   * Is the arriving policy EXACTLY `next.config.ts`'s `frame-ancestors 'none'`?
   * This is the confirming measurement: `cspCarriesNonce: false` proves the
   * value is not ours, but only this proves whose it is.
   */
  cspIsFrameAncestorsOnly: boolean;
  /**
   * Directive NAMES in the arriving policy — never their values. A bare
   * `cspIsFrameAncestorsOnly: false` would be a dead end; this says what turned
   * up instead. Names are structural (`script-src`, `frame-ancestors`) and carry
   * no secret; the values, which could contain a nonce or an internal origin,
   * never leave this function.
   */
  cspDirectives: string[];
  /** which of the two candidates above the evidence supports */
  verdict: string;
}

const NONCE_IN_POLICY = /'nonce-([0-9a-f]+)'/;
/** `frame-ancestors 'none'` in any spacing/casing, with or without a trailing `;`. */
const FRAME_ANCESTORS_ONLY = /^frame-ancestors\s+'none'\s*;?\s*$/i;
/** A CSP directive name is letters and dashes. Anything else is not echoed. */
const DIRECTIVE_NAME = /^[a-z-]{1,40}$/;

/**
 * Directive names only, deduped and capped. Every segment is validated against
 * `DIRECTIVE_NAME` before it is returned, so a header carrying something
 * unexpected cannot turn this into an arbitrary-value echo.
 */
function directiveNames(policy: string): string[] {
  const names = policy
    .split(";")
    .map((segment) => segment.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "")
    .filter((name) => DIRECTIVE_NAME.test(name));
  return [...new Set(names)].slice(0, 20);
}

export function describeRequestHeaders(headers: ReadableHeaders): CspEchoResult {
  const xNonce = headers.get("x-nonce");
  const csp = headers.get("content-security-policy");
  const cspReportOnly = headers.get("content-security-policy-report-only");

  // Next prefers the enforcing name and falls back to report-only, so read them
  // in that order here too — otherwise this could disagree with the renderer.
  const policy = csp ?? cspReportOnly;
  const nonceInPolicy = policy?.match(NONCE_IN_POLICY)?.[1] ?? null;

  const anyCsp = csp !== null || cspReportOnly !== null;

  return {
    xNonce: xNonce !== null,
    contentSecurityPolicy: csp !== null,
    contentSecurityPolicyReportOnly: cspReportOnly !== null,
    cspCarriesNonce: nonceInPolicy !== null,
    nonceMatches: nonceInPolicy !== null && xNonce !== null && nonceInPolicy === xNonce,
    cspIsFrameAncestorsOnly: policy !== null && FRAME_ANCESTORS_ONLY.test(policy.trim()),
    cspDirectives: policy === null ? [] : directiveNames(policy),
    verdict: verdictFor(xNonce !== null, anyCsp, nonceInPolicy !== null),
  };
}

function verdictFor(xNonce: boolean, anyCsp: boolean, carriesNonce: boolean): string {
  if (xNonce && anyCsp && carriesNonce) {
    return (
      "OVERRIDE INTACT. Both x-nonce and our own CSP reached the handler, nonce and " +
      "all. Nothing is being dropped or overwritten here."
    );
  }
  if (xNonce && anyCsp) {
    return (
      "COLLISION. A CSP header arrived under the name Next reads, but it is NOT ours " +
      "— it carries no nonce, so getScriptNonceFromHeader has nothing to read and " +
      "emits $undefined. Read cspIsFrameAncestorsOnly and cspDirectives to see whose " +
      "policy won. The override is fine; something is overwriting it."
    );
  }
  if (xNonce && !anyCsp) {
    return (
      "x-nonce ARRIVED, the CSP name did NOT. The override propagates and " +
      "content-security-policy is filtered specifically. Carry the nonce under a " +
      "name nobody filters and have the app read that instead."
    );
  }
  if (!xNonce && anyCsp) {
    return (
      "UNEXPECTED: a CSP header arrived without x-nonce. proxy.ts sets both in the " +
      "same call, so this points at something rewriting headers between them."
    );
  }
  return (
    "NOTHING ARRIVED. NextResponse.next({ request: { headers } }) does not " +
    "propagate on this platform at all, so no header name will rescue the nonce " +
    "and C1 needs a different transport."
  );
}
