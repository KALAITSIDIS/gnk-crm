import { test as setup, expect } from "@playwright/test";
import { login } from "./helpers";

const AUTH_FILE = "tests/.auth/admin.json";

/**
 * Logs in once and stores the Supabase session cookies for every other
 * project to reuse. Runs as a Playwright `dependency`, so a credential
 * problem fails here with a clear message instead of failing 40 specs.
 */
setup("authenticate as admin", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
});
