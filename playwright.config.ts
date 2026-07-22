import { defineConfig, devices } from "@playwright/test";

/**
 * E2E harness for the QA audit (Phase 2).
 *
 * Runs against the LOCAL dev server + local Supabase stack by default, so the
 * suite never writes to production data (rules of engagement). Point it at a
 * deployed environment with E2E_BASE_URL, but note that the write-flow specs
 * are gated on a local base URL and will skip themselves elsewhere.
 *
 *   npx playwright test                     # all specs, desktop + mobile
 *   npx playwright test --project=desktop   # desktop only
 *   npx playwright test tests/e2e/security.spec.ts
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const isLocal = baseURL.includes("localhost") || baseURL.includes("127.0.0.1");

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./tests/.playwright-output",
  // Server actions mutate shared rows; parallel writes make failures unreadable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "tests/.playwright-report", open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Cyprus desk: pin the locale/timezone so date assertions are stable.
    locale: "en-GB",
    timezoneId: "Asia/Nicosia",
  },

  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        storageState: "tests/.auth/admin.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 5"], // 393x851; the audit brief asks for ~390px
        viewport: { width: 390, height: 844 },
        storageState: "tests/.auth/admin.json",
      },
      dependencies: ["setup"],
      // Mobile run is a layout/navigability check, not a second write pass.
      testIgnore: [/happy-path\.spec\.ts/, /calculators\.spec\.ts/],
    },
  ],

  webServer: isLocal
    ? {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 180_000,
      }
    : undefined,
});
