import path from "node:path";
import { defineConfig } from "vitest/config";

// RLS suite — requires the local Supabase stack (`supabase start`).
export default defineConfig({
  test: {
    environment: "node",
    include: ["supabase/tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // fixtures are shared state; keep the suite strictly sequential
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
    },
  },
});
