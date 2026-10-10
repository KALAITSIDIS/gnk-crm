import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { EXPORT_FAILED_MESSAGE, EXPORT_TOO_MANY_MESSAGE } from "@/lib/constants/export";
import { EXPORT_SESSION_ENDED_MESSAGE } from "@/lib/utils/export-download";
import { opTimeout } from "./helpers";

/**
 * The "Export CSV" button as a user meets it (DECISIONS T-export-complete).
 * The routes' contract — complete up to 10,000 records, a 422 past it, a 500
 * for a failed read — is proven against a real PostgREST in
 * supabase/tests/list-export-complete.test.ts; this proves the BUTTON turns
 * each answer into the right outcome in a real browser: a CSV is saved under
 * the route's filename, and a refusal saves NOTHING and says why on screen
 * (a plain `<a download>` showed at most a failed download, no reason).
 *
 * The refusals are the routes' answers replayed with `page.route`: seeding
 * 10,001 records into the shared seed org would skew every other spec.
 */
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

/**
 * After hydration: a click on the server-rendered anchor before React attaches
 * its handler is the plain `<a download>` it falls back to (no JavaScript).
 */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

async function clickExportAndWatch(page: Page) {
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.getByRole("link", { name: "Export CSV" }).click();
  return downloads;
}

test.describe("Export CSV button", () => {
  test("saves the route's CSV under the route's filename", async ({ page }) => {
    await open(page, "/tasks");
    const pending = page.waitForEvent("download", { timeout: opTimeout(30_000) });
    await page.getByRole("link", { name: "Export CSV" }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/^my-tasks-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = readFileSync((await download.path())!, "utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toMatch(/^Title,Status,Due,Done at,Property,Auto,Created\r\n/);
  });

  test("more records than one export holds: nothing is saved, the reason is on screen", async ({ page }) => {
    await page.route("**/pipeline/export?type=sale", (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ error: EXPORT_TOO_MANY_MESSAGE, reason: "too_many" }),
      }),
    );
    await open(page, "/pipeline");
    const downloads = await clickExportAndWatch(page);
    await expect(toast(page, "More than 10,000 records match")).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(toast(page, "narrow the filters and export again")).toBeVisible();
    expect(downloads).toEqual([]);
    await expect(page).toHaveURL(/\/pipeline$/);
    await expect(page.getByRole("link", { name: "Export CSV" })).toBeVisible(); // usable again
  });

  test("a failed export (an empty 500 — a thrown audit write): nothing is saved, it says so", async ({ page }) => {
    await page.route("**/tasks/export", (route) => route.fulfill({ status: 500, body: "" }));
    await open(page, "/tasks");
    const downloads = await clickExportAndWatch(page);
    await expect(toast(page, EXPORT_FAILED_MESSAGE)).toBeVisible({ timeout: opTimeout(15_000) });
    expect(downloads).toEqual([]);
  });

  test("an ended session: the sign-in page is not saved as a CSV; it says sign in again", async ({ page }) => {
    await open(page, "/viewings");
    // the session ends while the page is open: the REAL proxy now answers the
    // export with a 307 to /login, which fetch follows to a 200 HTML page
    await page.context().clearCookies();
    const downloads = await clickExportAndWatch(page);
    await expect(toast(page, EXPORT_SESSION_ENDED_MESSAGE)).toBeVisible({ timeout: opTimeout(15_000) });
    expect(downloads).toEqual([]);
  });
});
