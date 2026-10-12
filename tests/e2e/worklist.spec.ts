import { test, expect } from "@playwright/test";
import { assertShellRendered } from "./helpers";

/**
 * The listing worklist renders for a signed-in user (T-worklist-id-lists).
 * Data-independent: its reads embed each live listing's photos and active
 * mandate, and PostgREST refuses a select it cannot resolve (400) — which
 * would be the error boundary here. Which listings each category names, at
 * scale and under a lowered row cap, is supabase/tests/worklist-id-lists.test.ts.
 */
test.describe("Listing worklist", () => {
  test("renders its heading, not the error boundary", async ({ page }) => {
    await page.goto("/properties/worklist");
    await assertShellRendered(page);
    await expect(page.getByRole("heading", { name: "Listing worklist" })).toBeVisible();
  });
});
