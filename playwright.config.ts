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
  /**
   * `failOnFlakyTests: !!process.env.CI` WAS HERE AND WAS REVERTED THE SAME DAY
   * (2026-08-11, `ddfed85` then `1674771`). Do not re-add it without reading
   * this.
   *
   * It was added on a false premise — that CI had been hiding the cold-compile
   * failures behind a retry. CI builds and serves `next start`
   * (.github/workflows/ci.yml), so it never compiles on demand and never had
   * that problem to hide.
   *
   * Then it turned `main` red on a docs-only push, and the measurement is the
   * argument against it: `security.spec.ts`'s anonymous-visitor loop hits a
   * chrome-headless-shell **SIGSEGV** on `browser.newContext` in MOST CI runs —
   * 3 of the 5 on 2026-08-11 (0, 0, 2, 2, 1 flaky). `31483891162` had 2 and was
   * reported green; `31504544194` was identical and went red only because of
   * this option; `31505752738`, the revert itself, had 1. Failing most pushes on
   * runner noise teaches everyone to ignore CI, which hides more than a quiet
   * retry ever did.
   *
   * `retries: 1` above is doing the job it was added for: absorbing an
   * infrastructure crash. The flake rate is real and tracked in HANDOFF §6 —
   * the fix belongs there, not in the exit code.
   */
  reporter: [["list"], ["html", { outputFolder: "tests/.playwright-report", open: "never" }]],
  /**
   * Budgets are scaled for a LOCAL run, because a local run means `next dev`,
   * and `next dev` charges Turbopack's per-route compile cost to whichever test
   * touches that route first. That cost is tens of seconds, and it lands inside
   * whatever budget the test is already spending.
   *
   * Measured on a cold server (empty `.next/dev`) 2026-08-11: single-navigation
   * page checks in `csp.spec.ts` took 27–38s, `viewing detail` took 55.3s
   * against the old 60s ceiling, and four tests doing two cold navigations
   * overran it outright — reporting `net::ERR_ABORTED; maybe frame was
   * detached?`, which is the timeout guillotining a navigation mid-flight and
   * reads convincingly like a routing bug. `mfa.spec.ts` failed the same way
   * through the *expect* budget instead: the post-login redirect to
   * `/login/verify` compiles on first touch, so `toHaveURL` saw `/login` for
   * more than 15s while the submit button sat disabled. Warm, that test passes
   * in 15.3s. NONE of these were application defects.
   *
   * Per-test `test.slow()` was tried first and rejected: it fixes the instances
   * you have already found, and this failure mode moves — different spec,
   * different budget, same cause. Scaling both budgets closes the class without
   * anyone having to enumerate the affected tests.
   *
   * The numbers are sized to MEASURED first-compile cost, not guessed. From the
   * dev server's own log on a cold run (`next dev` reports compile time
   * separately from application code):
   *
   *   GET /login/verify              43s   (next.js 43s, application-code 328ms)
   *   GET /viewings/<id>/sign        44s
   *   GET /viewings/<id>          31.2s
   *   GET /contacts/export        28.8s
   *
   * A first pass used 30s for `expect` and `mfa.spec.ts` still failed, because
   * the redirect it waits for lands on `/login/verify` and the server action's
   * POST cannot answer until that route finishes compiling. 90s is roughly
   * double the worst measured compile — deliberately generous, because cold
   * compile time is NOT stable: the same four tests took 66–78s in one cold run
   * and 18–55s in the next, on identical code and an identically emptied cache.
   * Calibrating tightly against an unstable number is how this took three
   * attempts.
   *
   * Deployed targets keep the strict values: they serve a prebuilt app, so
   * there is no compilation to wait for and slowness there is real.
   *
   * CI matches `isLocal` — it runs against 127.0.0.1 — but it BUILDS and serves
   * `next start`, so nothing there compiles on demand and these larger budgets
   * simply never get consumed. The gate is "localhost" because that is what the
   * config can actually see; the thing it is really guarding against is
   * `next dev`, which is a local-development concern, not a CI one.
   *
   * The trade, stated plainly: a genuine hang on a local run now takes 240s to
   * surface instead of 60s. That is the price of not having cold compilation
   * masquerade as a product bug. (An earlier version of this note leaned on
   * `failOnFlakyTests` to keep a slow test visible; that option was added and
   * reverted the same day — see the comment above `retries`.)
   */
  timeout: isLocal ? 240_000 : 60_000,
  expect: { timeout: isLocal ? 90_000 : 15_000 },

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    /**
     * CI ONLY: keep chrome-headless-shell from starting a GPU process at all.
     *
     * It was segfaulting during GPU init on the runner, which killed the browser
     * mid-run and failed whichever test asked for the next context — reported as
     * flakiness in `security.spec.ts`'s anonymous-visitor loop, which is simply
     * a long run of context creations and was never the cause.
     *
     * The evidence that this is GPU init and not memory pressure: the fault
     * address is **identical every time** — `Received signal 11 SEGV_MAPERR
     * 0000000001b0` across runs `31483891162`, `31504544194` and `31505752738`
     * and five different pids. Exhaustion gives varying addresses; a fixed one is
     * a deterministic null dereference. And the two lines immediately before it
     * are always `drmGetDevices2() has not found any devices` and
     * `InitializeSandbox() called with multiple threads in process gpu-process`.
     * A GPU-less runner, seconds after `<launched>`.
     *
     * Playwright passes `--enable-unsafe-swiftshader` by default so WebGL works
     * headlessly. **This app has no WebGL** — the only `getContext` calls are
     * `"2d"` in `components/features/viewings/signature-pad.tsx`, and canvas 2D
     * rasterises on the CPU — so there is nothing to lose by refusing both the
     * GPU process and the SwiftShader fallback.
     *
     * Local runs are untouched: the crash is Linux-runner-specific, and changing
     * rasterisation locally would only churn the tracked screenshots.
     */
    launchOptions: {
      args: process.env.CI ? ["--disable-gpu", "--disable-software-rasterizer"] : [],
    },
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
