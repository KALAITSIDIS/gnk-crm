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
   * NOT a full Content-Security-Policy: Next's inline bootstrap scripts need a
   * nonce round-trip through the proxy to lock down script-src, which is a
   * behavioural change and is tracked separately in IMPROVEMENTS.md. The
   * frame-ancestors directive below is safe on its own — CSP directives that
   * are omitted stay unrestricted, so this only forbids framing.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Clickjacking: an admin can archive a listing, deactivate a user or
          // erase a contact's personal data in one click. None of those are
          // undoable, so UI redressing has real consequences here.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
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
