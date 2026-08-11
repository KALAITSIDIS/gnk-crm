import { withSentryConfig } from "@sentry/nextjs";
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
   * a temporary `/api/csp-echo` route, since removed; the evidence it produced
   * is in IMPROVEMENTS C1 and `docs/ENGINEERING_NOTES.md` §1.
   *
   * The whole policy — `frame-ancestors` included — is built per request in
   * `proxy.ts` and has been **ENFORCED since 2026-08-10** (C1 promoted). So
   * clickjacking is now covered twice over: by `X-Frame-Options: DENY` below,
   * and by the policy's own `frame-ancestors 'none'`. Relying on X-Frame-Options
   * alone was the trade this removal made, and it lasted exactly as long as
   * report-only did.
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

/**
 * Sentry build plugin — source maps and release tracking (BACKLOG, 2026-08-11).
 *
 * WHY: delivery and alerting were already proven, but the DATA was unusable.
 * Every production stack arrived minified — the TypeError investigated on
 * 2026-08-10 read `_next/static/chunks/44sdjkbb-9351.js:6:5336`, which names no
 * file and no line. This uploads the maps so a frame points at real source.
 *
 * Turbopack: `next build` uses Turbopack on Next 16, and this plugin was
 * webpack-only for a long time. @sentry/nextjs 10.65 ships Turbopack support
 * (`constructTurbopackConfig`) and uploads via Next 16's
 * `runAfterProductionCompile` hook, which is why the version matters — do not
 * downgrade it without re-checking that maps still upload.
 *
 * ⚠️ THIS FILE IS THE ONE THAT ATE THE CSP NONCE. A `Content-Security-Policy`
 * key in `headers()` above landed on the REQUEST and blanked every nonce for
 * four days (see the warning there). `withSentryConfig` does not add headers,
 * but it DOES rewrite the build — `csp.spec.ts` and `security.spec.ts` assert
 * the enforcing policy still carries a nonce, and those are the tests to watch
 * if this wrapper is ever changed.
 */
export default withSentryConfig(withNextIntl(nextConfig), {
  // org/project/authToken are read from SENTRY_ORG / SENTRY_PROJECT /
  // SENTRY_AUTH_TOKEN, all three present in Vercel for Production and Preview
  // (verified 2026-08-11, not assumed — the backlog entry's list was checked
  // against the dashboard before this was written).

  /**
   * Upload only when a token exists, decided HERE rather than left to the
   * plugin's internal skip. CI and every local `npm run build` run without
   * SENTRY_AUTH_TOKEN, and a build that dies on a missing upload credential
   * would take the whole pipeline with it. Explicit beats a warning path.
   */
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    /**
     * Do NOT ship .map files. They reconstruct the original source, and this
     * app's client bundles carry the CRM's business logic. Sentry keeps its own
     * copy; the public one is deleted after upload.
     */
    deleteSourcemapsAfterUpload: true,
  },

  /**
   * Events ALREADY carry a release name — Sentry auto-detects
   * VERCEL_GIT_COMMIT_SHA at runtime, which is why issues on 2026-08-10 read
   * `release 7b9c11c213c7` despite the backlog saying no release was attached.
   * What was missing is the release OBJECT in Sentry that the maps attach to.
   * Naming it explicitly keeps the two halves the same string.
   */
  release: { name: process.env.VERCEL_GIT_COMMIT_SHA },

  // Client chunks are served from a route the default upload globs miss.
  widenClientFileUpload: true,

  // Build logs are read when a deploy misbehaves; keep them quiet otherwise.
  silent: !process.env.CI,

  // A private client CRM does not need to send build analytics to a vendor.
  telemetry: false,
});
