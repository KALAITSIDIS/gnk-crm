import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // standalone Node import scripts (T5.6): run via `node --env-file`, type-
    // stripped at runtime, outside the app's module graph and generated types
    "scripts/**",
    // local stack artifacts written by `supabase start` (bundled edge runtime).
    // Already git-ignored; linting vendored, minified output is noise.
    "supabase/.temp/**",
    // Playwright's generated HTML report and per-test output (traces,
    // screenshots, its bundled trace viewer). Git-ignored, and the viewer alone
    // produced ~2,800 lint warnings once a test had failed.
    "tests/.playwright-report/**",
    "tests/.playwright-output/**",
  ]),
]);

export default eslintConfig;
