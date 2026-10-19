import { test, expect } from "@playwright/test";
import { assertNoHorizontalOverflow, assertNoProblems, assertShellRendered, watchForProblems } from "./helpers";

/**
 * A08 PR 2 (review 2026-10-18): business words first, the system's words
 * behind "Technical details".
 *
 * The words themselves, and that the components put each in its place, are
 * pinned by tests/unit/business-wording.test.ts on the real components; the
 * lead card's chips by tests/e2e/lead-escalation-recovery.spec.ts. This spec
 * covers what only a browser can prove on the admin's own screens: a closed
 * "Technical details" hides its codes, opens by keyboard, and the pages read
 * without the machinery's words at both widths.
 *
 * Read-only: it opens pages and a disclosure, and writes nothing.
 */

/** The machinery a settings screen must not name (the A08 acceptance list). */
const JARGON = /\b(sweeps?|workers?|guardrails?|migrations?|outbox)\b|\bthe row\b/i;

test.describe("Business wording — settings and the dashboard", () => {
  test("Cyprus config heads rows by name; the key opens from Technical details by keyboard", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/settings/cyprus-config", { waitUntil: "networkidle" });
    await assertShellRendered(page);

    const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Land Registry transfer fees", level: 3 }) });
    await expect(card).toBeVisible();
    // the key is there, closed
    const key = card.getByText("key transfer_fees");
    await expect(key).toBeHidden();
    const summary = card.locator("summary", { hasText: "Technical details" });
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(key).toBeVisible();
    // the JSON editor, the escape hatch, stays — named by the row's title
    await expect(card.getByRole("textbox", { name: /Land Registry transfer fees — configuration JSON/ })).toBeVisible();
    // the rows with their own form say where it is
    await expect(page.getByRole("link", { name: "Settings → Lead escalation" })).toHaveAttribute("href", "/settings/lead-escalation");

    const intro = page.locator("main p").filter({ hasText: /calculators read tax and fee rates/ });
    await expect(intro).not.toHaveText(JARGON);
    await assertNoHorizontalOverflow(page, "settings/cyprus-config");
    assertNoProblems(problems, "settings/cyprus-config");
  });

  for (const path of ["/settings/lead-routing", "/settings/lead-escalation", "/settings/nudges"]) {
    test(`${path} reads without the machinery's words`, async ({ page }) => {
      const problems = watchForProblems(page);
      await page.goto(path, { waitUntil: "networkidle" });
      await assertShellRendered(page);
      // every paragraph and list item the admin reads on the page
      for (const text of await page.locator("main p, main li").allInnerTexts()) {
        expect(text, path).not.toMatch(JARGON);
      }
      assertNoProblems(problems, path);
    });
  }

  test("the dashboard's background-jobs line names the work, not the job", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await assertShellRendered(page);
    const banner = page.getByTestId("cron-health");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/^Background jobs: /);
    // a pg_cron name is only ever under Technical details, which starts closed — never in the sentence
    await expect(banner.locator("details[open]")).toHaveCount(0);
    await expect(banner.locator("span").first()).not.toHaveText(/expire-mandates|enquiry-alerts|lead-escalation|verify-events-chain|cron_health/);
    await assertNoHorizontalOverflow(page, "dashboard (background jobs)");
    assertNoProblems(problems, "dashboard (background jobs)");
  });
});
