import { test, expect } from "@playwright/test";
import { assertNoProblems, watchForProblems } from "./helpers";

/**
 * Retention-expiry surface (IMPROVEMENTS B11). The classification logic is
 * unit-tested in lib/services/retention.test.ts; this covers what only the
 * running app proves — the page renders for an admin, is reachable from the
 * settings nav, and never offers destruction for records still under the AML
 * duty. Written to hold whether or not the local DB has retained contacts.
 *
 * Anonymous access is covered in security.spec.ts with the other routes.
 */
test.describe("Data retention settings", () => {
  test("renders for an admin without console or network errors", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/settings/retention", { waitUntil: "networkidle" });

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // either the table or the honest empty state, never a crash
    const table = page.getByRole("table");
    const empty = page.getByText(/nothing is being retained/i);
    await expect(table.or(empty).first()).toBeVisible();

    assertNoProblems(problems, "settings/retention");
  });

  test("is linked from the settings nav", async ({ page }) => {
    await page.goto("/settings/organization", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Data retention" }).click();
    await expect(page).toHaveURL(/\/settings\/retention/);
  });

  test("never offers destruction for records still under the AML duty", async ({ page }) => {
    await page.goto("/settings/retention", { waitUntil: "networkidle" });

    const rows = page.getByRole("row");
    const count = await rows.count();
    for (let i = 1; i < count; i++) {
      const row = rows.nth(i);
      const text = (await row.innerText()).toLowerCase();
      // Only an expired row may carry the destroy action. A row still inside
      // its five-year duty offering one would be a compliance defect.
      if (!text.includes("retention expired")) {
        await expect(row.getByRole("button", { name: /destroy/i })).toHaveCount(0);
      }
    }
  });
});
