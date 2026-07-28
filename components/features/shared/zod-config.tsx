"use client";

// Side-effect import: configures Zod to skip its `Function`-constructor JIT in
// the BROWSER bundle. The root layout is a server component, so importing
// lib/validators/zod-jitless there alone would only configure the server.
// See IMPROVEMENTS C1 / DECISIONS T-csp.
import "@/lib/validators/zod-jitless";

/** Renders nothing; it exists to pull the config into the client bundle. */
export function ZodConfig(): null {
  return null;
}
