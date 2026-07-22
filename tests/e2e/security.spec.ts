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
    "/reports/commission-evidence",
    "/properties/new",
    "/contacts/new",
    "/route-sheet",
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

    // A service_role JWT always carries this claim; the anon key never does.
    expect(bundle, "service_role JWT found in client bundle").not.toContain('"role":"service_role"');
    expect(bundle).not.toContain("service_role");
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
    expect(headers["content-security-policy"], "frame-ancestors missing (SEC-1)").toContain(
      "frame-ancestors 'none'",
    );
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

  test("the signing screen keeps geolocation permitted for self", async ({ page }) => {
    // Regression guard: locking geolocation down would silently stop viewing
    // slips being geotagged, and slips are the commission evidence.
    const response = await page.goto("/login", { waitUntil: "domcontentloaded" });
    expect(response?.headers()["permissions-policy"]).toContain("geolocation=(self)");
  });
});
