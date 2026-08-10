import { test, expect } from "@playwright/test";
import { MODULES } from "./helpers";

/**
 * Security regression suite (audit brief Phase 5) — NON-DESTRUCTIVE.
 * Read-only probing only: no high-volume traffic, no writes, no attacks
 * against production. Everything here is an assertion about what an
 * UNAUTHENTICATED caller can reach.
 */

// This whole file must run without the stored admin session.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("protected routes", () => {
  for (const mod of MODULES) {
    test(`${mod.name} redirects an anonymous visitor to /login`, async ({ page }) => {
      await page.goto(mod.path, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/login/);
      // and none of the module's data leaked into the pre-redirect payload
      await expect(page.getByRole("heading", { name: mod.heading })).toHaveCount(0);
    });
  }

  // Detail + print routes are easy to forget in a middleware matcher.
  const deepRoutes = [
    "/settings/users",
    "/settings/cyprus-config",
    "/settings/organization",
    "/settings/stages",
    "/settings/locations",
    "/settings/retention",
    "/reports/commission-evidence",
    "/properties/new",
    "/contacts/new",
    "/contacts/export",
    "/properties/export",
    "/leads/export",
    "/pipeline/export",
    "/viewings/export",
    "/keys/export",
    "/tasks/export",
    "/route-sheet",
    "/security",
    // the 2FA challenge upgrades an EXISTING session, so it is meaningless —
    // and confusing — to show a code prompt to an anonymous visitor
    "/login/verify",
  ];
  for (const path of deepRoutes) {
    test(`${path} redirects an anonymous visitor to /login`, async ({ page }) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/login/);
    });
  }
});

test.describe("client bundle hygiene", () => {
  test("no service-role key or private env var reaches the browser", async ({ page }) => {
    const scripts: string[] = [];
    page.on("response", async (res) => {
      if (!/\.js(\?|$)/.test(res.url())) return;
      if (res.status() !== 200) return;
      try {
        scripts.push(await res.text());
      } catch {
        /* body already consumed / binary — ignore */
      }
    });

    await page.goto("/login", { waitUntil: "networkidle" });
    const bundle = scripts.join("\n");
    expect(bundle.length, "no JS was captured — the assertion would be vacuous").toBeGreaterThan(
      1000,
    );

    // --- legacy JWT-format keys ---------------------------------------------
    // A service_role JWT always carries this claim; the anon key never does.
    expect(bundle, "service_role JWT found in client bundle").not.toContain('"role":"service_role"');
    expect(bundle).not.toContain("service_role");

    // --- modern (sb_) keys ---------------------------------------------------
    // Supabase's replacement for the legacy pair is `sb_publishable_…` (safe to
    // ship) and `sb_secret_…` (never). Both checks above key on the literal
    // string "service_role", which a modern secret key does NOT contain — so on
    // the day the legacy keys are rotated out (HANDOFF §2b) this test would go
    // on passing while having quietly lost its ability to catch the very thing
    // it exists to catch. Detect the secret key by its own prefix instead.
    expect(bundle, "a modern sb_secret_ key reached the client bundle").not.toContain("sb_secret_");

    // Belt and braces: any Supabase key material that is NOT the publishable
    // one. Written as a prefix scan rather than an assignment-shape regex
    // because a leak arrives inlined into minified code, not as
    // `NAME = "value"`.
    const sbKeys = [...bundle.matchAll(/sb_[a-z]+_[A-Za-z0-9_-]{10,}/g)].map((m) => m[0]);
    const nonPublishable = sbKeys.filter((k) => !k.startsWith("sb_publishable_"));
    expect(nonPublishable, `non-publishable Supabase key(s) in the bundle`).toEqual([]);

    /**
     * NO Supabase credential at all, publishable included (2026-08-08).
     *
     * A publishable key is designed to be public, so this is not a leak
     * assertion — it pins a stronger property this app happens to have: nothing
     * builds a browser Supabase client, so the browser receives no Supabase
     * credential whatsoever. Until now that was an ACCIDENT of
     * `lib/supabase/client.ts` being unimported (BACKLOG). That file has been
     * deleted, and this makes its absence deliberate.
     *
     * **If you are here because this failed, it is doing its job.** Someone
     * added a browser client. That is a legitimate thing to do — realtime and
     * client-side reads both need one — but it changes what ships to every
     * visitor, so it should be a decision rather than a side effect of an
     * import. Make the decision, then relax this to the `nonPublishable` check
     * above.
     */
    expect(sbKeys, "a Supabase key reached the browser — see the note above").toEqual([]);
    expect(
      [...bundle.matchAll(/eyJhbGciOi[A-Za-z0-9._-]{30,}/g)].map((m) => m[0].slice(0, 12)),
      "a JWT-shaped credential reached the browser — legacy anon keys look like this",
    ).toEqual([]);

    expect(bundle).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/);
    expect(bundle).not.toMatch(/RESEND_API_KEY\s*[:=]\s*["'][^"']{10,}/);
  });

  test("login page sets no sensitive data in localStorage before auth", async ({ page }) => {
    await page.goto("/login", { waitUntil: "networkidle" });
    const stored = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(stored).not.toContain("service_role");
  });
});

test.describe("auth surface", () => {
  test("bad credentials are rejected without disclosing which field was wrong", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("nobody@example.invalid");
    await page.getByLabel(/password/i).fill("definitely-not-the-password");
    await page.getByRole("button", { name: /log in/i }).click();

    const error = page.getByText(/invalid|incorrect|could not|failed/i).first();
    await expect(error).toBeVisible({ timeout: 20_000 });
    // Must not distinguish "no such user" from "wrong password" (user enumeration).
    await expect(page.getByText(/no such user|user not found|unknown email/i)).toHaveCount(0);
    await expect(page).toHaveURL(/\/login/);
  });

  test("login form does not submit credentials in the URL", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("someone@example.invalid");
    await page.getByLabel(/password/i).fill("hunter2");
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain("hunter2");
    expect(page.url()).not.toContain("someone@example.invalid");
  });
});

test.describe("security headers", () => {
  test("app responses carry baseline hardening headers", async ({ page }) => {
    const response = await page.goto("/login", { waitUntil: "domcontentloaded" });
    const headers = response?.headers() ?? {};

    // Findings SEC-1..SEC-4: all four were absent on local AND production
    // before this audit; next.config.ts `headers()` now supplies them.
    expect(headers["x-frame-options"], "clickjacking guard missing (SEC-1)").toBe("DENY");
    // SEC-1's frame-ancestors moved INTO the report-only policy on 2026-08-10.
    // It cannot live in next.config.ts: a Content-Security-Policy header
    // declared there lands on the REQUEST under the name Next reads the nonce
    // from, and stamped 0 of 22 scripts in production for four days
    // (IMPROVEMENTS C1). X-Frame-Options above is the enforcing guard now.
    expect(
      headers["content-security-policy"],
      "an ENFORCING CSP header silently breaks the nonce — see next.config.ts",
    ).toBeUndefined();
    expect(
      headers["content-security-policy-report-only"],
      "frame-ancestors missing (SEC-1)",
    ).toContain("frame-ancestors 'none'");
    expect(headers["x-content-type-options"], "MIME sniffing guard missing (SEC-2)").toBe(
      "nosniff",
    );
    expect(headers["referrer-policy"], "record UUIDs leak via Referer (SEC-3)").toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers["permissions-policy"], "Permissions-Policy missing (SEC-4)").toContain(
      "camera=()",
    );
  });

  /**
   * SEC-5 (investigated 2026-07-23 — no code change warranted).
   *
   * Production returns `Access-Control-Allow-Origin: *`, which the audit
   * flagged. Investigation showed it comes from Vercel's CDN defaults for
   * STATIC and prerendered responses (there is no vercel.json and no CORS
   * code in the app — the only `cors` hits in the repo are a transitive
   * lockfile entry). Those responses are public by construction: compiled
   * JS/CSS and the logged-out login form. They contain no user data.
   *
   * Every DYNAMIC route carries no ACAO at all, and nothing anywhere sets
   * `Access-Control-Allow-Credentials`, so a cross-origin script cannot read
   * an authenticated response even where the wildcard is present.
   *
   * Removing the wildcard from static assets would be cosmetic. What is worth
   * guarding is the invariant that actually protects data, so that is what
   * these tests pin — they would fail if someone ever added a permissive CORS
   * policy to the app routes or turned on credentialed CORS.
   */
  test("[SEC-5] authenticated routes never advertise CORS", async ({ request, baseURL }) => {
    const protectedPaths = [
      "/dashboard",
      "/properties",
      "/contacts",
      "/leads",
      "/reports",
      "/settings/users",
    ];

    for (const path of protectedPaths) {
      const res = await request.get(`${baseURL}${path}`, { maxRedirects: 0 });
      const headers = res.headers();
      expect(
        headers["access-control-allow-origin"],
        `${path} advertises CORS — a cross-origin script could read app responses`,
      ).toBeUndefined();
    }
  });

  test("[SEC-5] credentialed CORS is never enabled, anywhere", async ({ request, baseURL }) => {
    // The wildcard on static assets is only safe while this stays off: with
    // `Allow-Credentials: true` a wildcard origin would let any site read
    // authenticated responses. Browsers reject that combination, but a
    // specific-origin echo plus credentials would not be rejected.
    for (const path of ["/login", "/dashboard", "/"]) {
      const res = await request.get(`${baseURL}${path}`, { maxRedirects: 0 });
      expect(
        res.headers()["access-control-allow-credentials"],
        `${path} enables credentialed CORS`,
      ).toBeUndefined();
    }
  });

  test("the signing screen keeps geolocation permitted for self", async ({ page }) => {
    // Regression guard: locking geolocation down would silently stop viewing
    // slips being geotagged, and slips are the commission evidence.
    const response = await page.goto("/login", { waitUntil: "domcontentloaded" });
    expect(response?.headers()["permissions-policy"]).toContain("geolocation=(self)");
  });
});
