import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests only. The RLS suite (supabase/tests) needs a running local
// Supabase stack and has its own config: vitest.rls.config.ts (npm run test:rls).
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(import.meta.dirname, "lib/testing/server-only-stub.ts"),
      "@": path.resolve(import.meta.dirname),
    },
  },
});
