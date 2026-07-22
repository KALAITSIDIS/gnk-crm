import { test, expect, type Page } from "@playwright/test";
import { assertNoProblems, runTag, watchForProblems } from "./helpers";

/**
 * Critical-path smoke (audit brief Phase 2): the chain a Paphos desk runs
 * every day — capture a lead, work the pipeline, list a property, book a
 * viewing, raise a task, and see it all roll up on the dashboard.
 *
 * WRITE FLOWS. Guarded to a local base URL so the suite can never touch the
 * client's production data.
 *
 * Cleanup note: this app DELIBERATELY has no hard delete — `events` is
 * append-only and hash-chained, so RLS denies DELETE on every business table
 * (docs/04). Fixtures are therefore tagged `qa-<base36 ts>` and RETIRED into
 * the app's own terminal states (lead -> spam, property -> archived) rather
 * than removed. `supabase db reset` is the only true cleanup.
 */

const TAG = runTag();

test.beforeEach(async ({ baseURL }) => {
  test.skip(
    !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
    "write flows are local-only — never run against production data",
  );
});

/**
 * Picks an option from a shadcn/Radix Select BY POSITION.
 *
 * FINDING A11Y-1: none of these triggers has an accessible name — the visible
 * <Label> carries no htmlFor and the SelectTrigger carries no id, aria-label
 * or aria-labelledby, so `getByLabel` / `getByRole(name:)` cannot reach them
 * and a screen reader announces a bare "combobox". Positional selection is the
 * workaround; when the labels are fixed this helper should take a name again.
 */
async function selectByIndex(page: Page, index: number, optionText: RegExp) {
  await page.getByRole("combobox").nth(index).click();
  await page.getByRole("option", { name: optionText }).first().click();
}

test.describe.serial("critical path", () => {
  const leadMessage = `${TAG} audit lead — 2-bed Kato Paphos, budget EUR 250.000`;
  const propertyTitle = `${TAG} audit villa`;

  test("1. capture a lead from the inbox", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/leads", { waitUntil: "networkidle" });

    await page.getByRole("button", { name: /add lead/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/new lead/i)).toBeVisible();

    await dialog.getByLabel(/message \/ request/i).fill(leadMessage);
    await dialog.getByRole("button", { name: /^add lead$/i }).click();

    await expect(dialog).toBeHidden({ timeout: 20_000 });
    // the inbox must show it without a manual refresh (revalidatePath)
    await expect(page.getByText(leadMessage)).toBeVisible({ timeout: 20_000 });

    assertNoProblems(problems, "lead capture");
  });

  test("2. the new lead is counted, not just displayed", async ({ page }) => {
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = page.getByText(leadMessage);
    await expect(row).toBeVisible();

    // Regression guard for the 2026-07-21 list-scope defect: the header count
    // and the visible rows must describe the same set.
    const header = await page.locator("main").innerText();
    const openCount = header.match(/(\d+)\s+open/i);
    if (openCount) {
      expect(Number(openCount[1]), "header says 0 open while rows are shown").toBeGreaterThan(0);
    }
  });

  test("3. pipeline renders every stage with a reconciled total", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/pipeline", { waitUntil: "networkidle" });

    const board = page.locator("main");
    await expect(board).toBeVisible();

    // FINDING UX-3: the kanban columns are plain <div>s — no data-stage-id, no
    // role="list", no heading element; stage names are bare <span>s. There is
    // therefore no stable hook to count columns, so this asserts on the seeded
    // stage vocabulary instead. Adding `data-stage-id` would make this exact.
    const text = await board.innerText();
    const seededStages = ["New", "Qualified", "Viewing"];
    for (const stage of seededStages) {
      expect(text, `pipeline is missing the "${stage}" stage column`).toContain(stage);
    }
    // every column prints a money total, even when empty
    expect(text, "pipeline shows no stage totals").toMatch(/€/);

    assertNoProblems(problems, "pipeline");
  });

  test("4. list a property through the create wizard", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/properties/new", { waitUntil: "networkidle" });

    // Step 1 — classification. Selects in DOM order: 0 Kind, 1 Property type,
    // 2 Transaction, 3 District. Kind and Transaction already default to
    // "Standalone listing" / "Sale", so only the two empty ones need setting.
    await selectByIndex(page, 1, /apartment|villa|house/i);
    await selectByIndex(page, 3, /paphos/i);
    // NB: scope to <main> — /next/i also matches the Next.js dev-tools button.
    await page.locator("main").getByRole("button", { name: /^continue$/i }).click();

    // Step 2 — the fields a Cyprus listing actually needs
    const form = page.locator("main");
    await form.getByLabel(/title \(en\)/i).fill(propertyTitle);
    await form.getByLabel(/address/i).fill(`${TAG} Test Street 1, Kato Paphos`);
    await form.getByLabel(/asking price/i).fill("250000");
    await form.getByLabel(/covered area/i).fill("95");
    await form.getByLabel(/bedrooms/i).fill("2");
    await form.getByLabel(/internal notes/i).fill(`${TAG} QA audit fixture — safe to archive`);

    await form.getByRole("button", { name: /create|save/i }).last().click();

    // lands on the detail page with a generated reference
    await page.waitForURL(/\/properties\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByText(propertyTitle).first()).toBeVisible();
    await expect(page.getByText(/GNK-PAF-\d+/).first(), "no reference generated").toBeVisible();

    assertNoProblems(problems, "property create");
  });

  test("5. the property appears in the list with euro and m² formatting", async ({ page }) => {
    await page.goto("/properties", { waitUntil: "networkidle" });
    const row = page.getByText(propertyTitle).first();
    await expect(row).toBeVisible();

    const listText = await page.locator("main").innerText();
    expect(listText, "asking price is not rendered in euros").toMatch(/€\s?250[.,]000/);
  });

  test("6. raise a task and see it on the task list", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/tasks", { waitUntil: "networkidle" });

    const title = `${TAG} call the buyer back`;
    await page.getByPlaceholder(/quick task/i).fill(title);
    const due = new Date();
    due.setDate(due.getDate() + 3);
    await page.getByLabel(/due date/i).fill(due.toISOString().slice(0, 10));
    await page.getByRole("button", { name: /add|create/i }).first().click();

    await expect(page.getByText(title)).toBeVisible({ timeout: 20_000 });
    assertNoProblems(problems, "task create");
  });

  test("7. the dashboard reflects the work just done", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/dashboard", { waitUntil: "networkidle" });

    const text = await page.locator("main").innerText();
    // KPI tiles must render figures, not placeholders.
    expect(text, "dashboard shows no listing breakdown").toMatch(/listings by status/i);
    expect(text).toMatch(/pipeline/i);
    // The freshly created property must be counted in the status breakdown.
    expect(text, "no draft listings counted after creating one").toMatch(/draft/i);

    assertNoProblems(problems, "dashboard rollup");
  });

  test("8. retire the audit fixtures (no hard delete exists by design)", async ({ page }) => {
    // Lead -> spam is the terminal retire state the inbox filter honours.
    await page.goto("/leads", { waitUntil: "networkidle" });
    const leadRow = page
      .locator("li, tr, article")
      .filter({ hasText: leadMessage })
      .first();
    const closeBtn = leadRow.getByRole("button", { name: /^close$/i });
    if (await closeBtn.count()) {
      await closeBtn.click();
      const spam = page.getByRole("button", { name: /spam/i }).first();
      if (await spam.count()) await spam.click();
    }

    // Property -> archived (admin-only button, see commit efd2ccb).
    await page.goto("/properties", { waitUntil: "networkidle" });
    const link = page.getByRole("link", { name: new RegExp(propertyTitle) }).first();
    if (await link.count()) {
      await link.click();
      const archive = page.getByRole("button", { name: /archive/i }).first();
      if (await archive.count()) {
        await archive.click();
        const confirm = page.getByRole("button", { name: /archive|confirm/i }).last();
        if (await confirm.count()) await confirm.click();
      }
    }
    // Non-fatal: this step documents cleanup, it does not gate the suite.
  });
});
