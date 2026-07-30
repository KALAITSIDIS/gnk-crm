import { test, expect } from "@playwright/test";

/**
 * Installable PWA (IMPROVEMENTS B8).
 *
 * Scope is installable + resilient reads: the shell and already-visited screens
 * survive a dead signal; writes still need the network and fail honestly.
 * Offline slip signing is deliberately NOT in scope (see public/sw.js).
 *
 * The worker itself only registers in production builds, so these tests assert
 * the things that must be true of the deployed artefacts — the manifest, the
 * icons, the worker script and the offline page — rather than driving a worker
 * the dev server never installs.
 */

test.describe("PWA", () => {
  test("serves a valid, installable manifest", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);

    const manifest = await res.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    // Installability minimums: standalone display, a start_url, and at least
    // one 192px and one 512px icon.
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBeTruthy();

    const sizes = (manifest.icons ?? []).map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");

    // A maskable icon stops Android cropping the glyph inside the safe zone.
    const purposes = (manifest.icons ?? []).map((i: { purpose?: string }) => i.purpose);
    expect(purposes).toContain("maskable");
  });

  test("every icon the manifest promises actually exists", async ({ request }) => {
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    for (const icon of manifest.icons as { src: string }[]) {
      const res = await request.get(icon.src);
      expect(res.status(), `${icon.src} is referenced but not served`).toBe(200);
      expect(res.headers()["content-type"]).toContain("image");
    }
    // iOS ignores manifest icons and reads this one instead.
    expect((await request.get("/apple-touch-icon.png")).status()).toBe(200);
  });

  test("the layout links the manifest and sets a theme colour", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      /manifest\.webmanifest/,
    );
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0B1F33");
  });

  test("the service worker is served as JavaScript from the root scope", async ({ request }) => {
    const res = await request.get("/sw.js");
    expect(res.status()).toBe(200);
    // Served from a nested path, a worker cannot control "/" — the scope is the
    // whole point.
    expect(res.headers()["content-type"]).toContain("javascript");

    const body = await res.text();
    // The privacy guarantee this feature rests on: caches are purged on
    // sign-out, and API responses are never cached.
    expect(body, "the worker must handle the sign-out purge").toContain("PURGE");
    expect(body, "the worker must never cache /api/").toContain("/api/");
  });

  test("the offline fallback renders without a session", async ({ browser }) => {
    // A genuinely anonymous context: the fallback exists for the case where
    // there is no network, and the worker precaches it at install time. Behind
    // the auth gate it would cache a redirect to /login instead.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      const res = await page.goto("/offline", { waitUntil: "networkidle" });
      expect(res?.status()).toBe(200);
      expect(page.url(), "the offline page must not bounce to /login").toContain("/offline");
      await expect(page.getByRole("heading", { name: /offline/i })).toBeVisible();
      // It must be explicit that nothing was saved — an agent who just signed a
      // slip needs to know whether to redo it.
      await expect(page.getByText(/has \s*not\s* been sent|nothing was recorded/i)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
