import { test, expect } from "@playwright/test";
import { assertNoProblems, watchForProblems } from "./helpers";

/**
 * The performance reports say what they count (F06, migration 0154).
 *
 * Data-independent: it reads the words and the CSV contracts a signed-in admin
 * gets on any stack at 0154, whatever the window holds. The figures
 * themselves are pinned on a real PostgREST in
 * supabase/tests/report-definitions.test.ts (spam out of the convert rate,
 * the win rate in one scope, one row per pipeline and stage id, the direction
 * split) and the page's words per role and per failure in
 * tests/unit/performance-page-definitions.test.ts.
 */
const WINDOW = "from=2026-01-01&to=2026-01-31";
const withoutBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

test.describe("Performance reports: definitions, not ROI", () => {
  test("the page names lead sources, defines them, states the admin's scope and says nothing false about stages", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto(`/reports/performance?${WINDOW}`, { waitUntil: "networkidle" });

    await expect(page.getByRole("heading", { level: 2, name: "Lead sources" })).toBeVisible();
    const definition = page.getByTestId("lead-sources-definition");
    await expect(definition).toContainText("the transaction value, not commission");
    await expect(definition).toContainText("so this is not a return on investment");
    await expect(definition).toContainText("whenever the deal was won (its status today)");
    await expect(page.getByTestId("lead-sources-scope")).toHaveText("These figures cover the whole agency.");
    await expect(page.getByTestId("report-scope")).toHaveText("Every figure on this page covers the whole agency.");
    await expect(page.getByTestId("agent-performance-definition")).toContainText("in the window they closed");
    await expect(page.getByText(/Computed from the tamper-evident activity log\./)).toBeVisible();

    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/\bROI\b/);
    expect(text).not.toContain("renaming one splits its history");
    expect(text).not.toContain("your own records only");
    // a healthy stack: no section reports a failure, and every export is offered
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    for (const report of ["agent_performance", "source_roi", "time_to_close", "price_reductions"]) {
      await expect(page.locator(`a[href*="report=${report}"]`)).toHaveCount(1);
    }
    assertNoProblems(problems, "performance reports");
  });

  test("the lead-source CSV keeps its key and columns, and appends Spam and the visible conversions", async ({ page }) => {
    const res = await page.request.get(`/reports/performance/export?${WINDOW}&report=source_roi`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"] ?? "").toMatch(/filename="report-source_roi-2026-01-01-to-2026-01-31-/);
    expect(withoutBom(await res.text()).split("\r\n")[0]).toBe(
      'Source,Leads,Converted,Won,Won value,Convert rate,Win rate,From,To,Spam,"Converted, deal visible"',
    );
  });

  test("the stage-conversion CSV appends the pipeline, the direction split and the stage id", async ({ page }) => {
    const res = await page.request.get(`/reports/performance/export?${WINDOW}&report=stage_conversion`);
    // 422 only when the window holds nothing but unreadable stage changes — never on a fresh stack
    expect(res.status()).toBe(200);
    expect(withoutBom(await res.text()).split("\r\n")[0]).toBe(
      "Stage,Entered,Advanced,Advance rate,Note,From,To,Malformed moves excluded,Deal type,Moved back,Direction unknown,Stage id",
    );
  });

  test("the reports index describes the nightly check in plain words", async ({ page }) => {
    await page.goto("/reports", { waitUntil: "networkidle" });
    await expect(page.getByText("Performance reports", { exact: true })).toBeVisible();
    await expect(page.getByText(/Agent performance, lead sources, time to close/)).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/\bROI\b/);
    // the badge renders only once the nightly check has written a result
    expect(text).not.toContain("hash-chain check");
    if (/integrity check/.test(text)) expect(text).toContain("Nightly activity-log integrity check:");
  });
});
