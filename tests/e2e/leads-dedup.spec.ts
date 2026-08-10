import { test, expect } from "@playwright/test";
import { isLocal } from "./helpers";

/**
 * Lead duplicate detection (IMPROVEMENTS B6 / doc 02 §C4). Capturing a lead can
 * create a new contact; the §C3 dedup check must fire first so the same buyer's
 * history never forks. This exercises the write flow end-to-end: create a
 * contact via the lead form, then a second lead with the same phone must warn
 * and offer to link the existing contact instead.
 *
 * A unique phone per run keeps the shared local dev DB from making an older
 * fixture contact collide with this test.
 */
test.beforeEach(async () => {
  test.skip(
    !isLocal(),
    "write flows are local-only — never run against production data",
  );
});

test.describe("Lead capture — duplicate contact detection", () => {
  test("warns on a duplicate phone and links the existing contact instead", async ({ page }) => {
    const suffix = String(Date.now()).slice(-6); // 6 digits → valid CY mobile tail
    const phone = `99 ${suffix}`;
    const firstName = `Dedup Buyer ${suffix}`;

    const openDialog = async () => {
      await page.goto("/leads", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Add lead" }).first().click();
      await expect(page.getByRole("dialog").getByText("New lead")).toBeVisible();
    };
    const dialog = () => page.getByRole("dialog");

    // 1. First lead creates a brand-new contact.
    await openDialog();
    await dialog().getByLabel("Name").fill(firstName);
    await dialog().getByLabel("Phone").fill(phone);
    await dialog().getByRole("button", { name: /add lead/i }).click();
    await expect(page.getByText("New lead")).toBeHidden(); // dialog closed = success

    // 2. Second lead, same phone under a different name → duplicate warning.
    await openDialog();
    await dialog().getByLabel("Name").fill("Someone Else Entirely");
    await dialog().getByLabel("Phone").fill(phone);
    await dialog().getByRole("button", { name: /add lead/i }).click();

    const warning = dialog().getByRole("alert");
    await expect(warning).toContainText(/already exists/i);
    await expect(warning).toContainText(firstName); // it names the existing contact

    // 3. Link the existing contact instead, then submit → lead links, dialog closes.
    await dialog().getByRole("button", { name: new RegExp(`link ${firstName}`, "i") }).click();
    await expect(dialog().getByRole("alert")).toBeHidden(); // warning cleared once linked
    await dialog().getByRole("button", { name: /add lead/i }).click();
    await expect(page.getByText("New lead")).toBeHidden();
  });
});
