import { expect, test } from "@playwright/test";

/**
 * Audit 2026-09-13, CRM-06: what a phone gets.
 *
 * The properties list with no `?view=` is AUTO — cards below the tablet
 * breakpoint, the table above it, both in the DOM and one hidden by CSS
 * (the page is a server component and cannot know the viewport). The lead
 * card keeps its five working actions on a phone and folds the other five
 * behind "More…". Runs under BOTH projects: the desktop assertions are the
 * inverse of the mobile ones, so a change that leaks one layout into the
 * other fails somewhere.
 *
 * Verified on production by hand? No — Claude in Chrome could not shrink a
 * maximised window on 2026-09-13, which is why this spec exists.
 */
const isPhone = (width: number) => width < 768;

test.describe("phone layouts (CRM-06)", () => {
  test("the properties list is cards on a phone and the table above it", async ({ page }, testInfo) => {
    await page.goto("/properties", { waitUntil: "networkidle" });
    const phone = isPhone(testInfo.project.use.viewport?.width ?? 1280);
    const table = page.getByRole("table").first();
    if (phone) {
      await expect(table, "no twelve-column table on a phone").toBeHidden();
      // a card carries the reference as a link; the table's links are hidden with it
      await expect(page.getByRole("link", { name: /PAF\d{4}/ }).first()).toBeVisible();
    } else {
      await expect(table).toBeVisible();
    }
    // an explicit choice is honoured everywhere
    await page.goto("/properties?view=table", { waitUntil: "networkidle" });
    await expect(page.getByRole("table").first()).toBeVisible();
    await page.goto("/properties?view=cards", { waitUntil: "networkidle" });
    await expect(page.getByRole("table")).toHaveCount(0);
  });

  test("a lead card folds its secondary actions behind More… on a phone only", async ({ page }, testInfo) => {
    await page.goto("/leads", { waitUntil: "networkidle" });
    const phone = isPhone(testInfo.project.use.viewport?.width ?? 1280);
    const card = page.locator("li, article, div").filter({ has: page.getByRole("button", { name: /^Log$/ }) }).first();
    test.skip(!(await page.getByRole("button", { name: /^Log$/ }).count()), "no open lead on this database");
    const more = card.getByRole("button", { name: /More…|Less/ }).first();
    const secondary = card.getByRole("button", { name: /^Close$/ }).first();
    if (phone) {
      await expect(more).toBeVisible();
      await expect(secondary, "Close waits behind More… on a phone").toBeHidden();
      await more.click();
      await expect(secondary).toBeVisible();
      await expect(card.getByRole("button", { name: "Less" }).first()).toBeVisible();
    } else {
      await expect(more, "no fold on a desktop").toBeHidden();
      await expect(secondary).toBeVisible();
    }
  });
});
