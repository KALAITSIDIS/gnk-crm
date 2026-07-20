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
};

export default withNextIntl(nextConfig);
