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
};

export default withNextIntl(nextConfig);
