import { test, expect } from "@playwright/test";
import {
  MODULES,
  assertNoHorizontalOverflow,
  assertNoProblems,
  assertShellRendered,
  watchForProblems,
} from "./helpers";

/**
 * Per-module smoke (audit brief Phase 2). For every sidebar module:
 * page loads with no 4xx/5xx, no console errors, no unhandled network
 * failure, the shell renders, the layout does not overflow sideways, and a
 * screenshot lands in tests/screenshots/ for the report.
 *
 * Runs on both the desktop and mobile projects, so the 390px column of the
 * evidence set comes from the same assertions as the 1280px one.
 */
for (const mod of MODULES) {
  test(`${mod.name} — loads clean`, async ({ page }, testInfo) => {
    const problems = watchForProblems(page);

    const response = await page.goto(mod.path, { waitUntil: "networkidle" });
    expect(response?.status(), `${mod.name}: navigation status`).toBeLessThan(400);

    // Auth must not have silently bounced us to /login.
    expect(page.url(), `${mod.name}: unexpected redirect`).toContain(mod.path);

    await assertShellRendered(page);
    await expect(page.getByRole("heading", { name: mod.heading, exact: false }).first()).toBeVisible();
    await assertNoHorizontalOverflow(page, mod.name);

    await page.screenshot({
      path: `tests/screenshots/${mod.name.toLowerCase()}-${testInfo.project.name}.png`,
      fullPage: true,
    });

    assertNoProblems(problems, mod.name);
  });
}

test("sidebar links reach every module without a dead link", async ({ page }, testInfo) => {
  const problems = watchForProblems(page);
  await page.goto("/dashboard", { waitUntil: "networkidle" });

  // Mobile hides the sidebar behind the hamburger (components/features/shared/mobile-nav).
  const isMobile = testInfo.project.name === "mobile";
  if (isMobile) {
    const burger = page.getByRole("button", { name: /menu|navigation/i }).first();
    await expect(burger, "mobile: no hamburger — the app would be unnavigable").toBeVisible();
    await burger.click();
  }

  // NB: the desktop <aside> stays in the DOM on mobile (`hidden md:flex`), so
  // scope to the VISIBLE nav — otherwise we assert against display:none links.
  const nav = page.locator("nav").filter({ visible: true }).first();
  for (const mod of MODULES) {
    const link = nav.getByRole("link", { name: mod.name, exact: false }).first();
    await expect(link, `sidebar is missing a link to ${mod.name}`).toBeVisible();
    await expect(link, `sidebar link for ${mod.name} points at the wrong route`).toHaveAttribute(
      "href",
      new RegExp(mod.path),
    );
  }

  assertNoProblems(problems, "sidebar");
});

test("unknown route renders the not-found page, not a crash", async ({ page }) => {
  const response = await page.goto("/this-route-does-not-exist", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(404);
  await expect(page.getByText(/not found|404/i).first()).toBeVisible();
});
