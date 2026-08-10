import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // multi-photo uploads go through a server action (media pipeline, T1.4)
      bodySizeLimit: "25mb",
    },
  },
  // PDF fonts are read from disk at render time (react-pdf Font.register), so
  // Vercel's import tracing never sees them — force them into the bundles.
  outputFileTracingIncludes: {
    "/**": ["./lib/assets/fonts/**"],
  },

  /**
   * Baseline security headers (audit 2026-07-22, findings SEC-1..SEC-4).
   * Vercel supplies Strict-Transport-Security; everything below was absent on
   * both local and production, leaving the CRM framable and its record URLs
   * leaking through the Referer header.
   *
   * ⚠️ **NEVER ADD A `Content-Security-Policy` KEY HERE.** This block carried
   * `Content-Security-Policy: frame-ancestors 'none'` from the 2026-07-22 audit
   * until 2026-08-10, and on Vercel it was silently breaking the nonce for four
   * days. Next reads the per-request nonce off the REQUEST header of that exact
   * name (`app-render.js` → `getScriptNonceFromHeader`); a header declared here
   * lands under the same name and wins, so Next read `frame-ancestors 'none'`,
   * found no nonce, emitted `$undefined`, and stamped 0 of 22 script tags on
   * every production page. Locally it did not, which is why three rounds of
   * investigation blamed the platform. Measured and confirmed via
   * `/api/csp-echo`; the evidence is in IMPROVEMENTS C1.
   *
   * The whole policy — `frame-ancestors` included — is built per request in
   * `proxy.ts` and ships as Report-Only until C1 is promoted. Clickjacking stays
   * ENFORCED by `X-Frame-Options: DENY` below, which every current browser
   * honours; that is the trade this removal made, deliberately.
   *
   * Moving the same header into middleware does NOT work either: a response
   * header set through `NextResponse.next()` comes back round as a request
   * header and reproduces the collision.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Clickjacking: an admin can archive a listing, deactivate a user or
          // erase a contact's personal data in one click. None of those are
          // undoable, so UI redressing has real consequences here. With the CSP
          // key gone (see above) this is the ENFORCING clickjacking guard, not a
          // belt-and-braces duplicate of frame-ancestors.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Record UUIDs live in the path (/contacts/<uuid>). Send the origin
          // only, and nothing at all when leaving HTTPS.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // geolocation stays enabled for self: the viewing-slip signing screen
          // geotags the signature (components/features/viewings/sign-slip.tsx).
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), payment=(), interest-cohort=(), geolocation=(self)",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
