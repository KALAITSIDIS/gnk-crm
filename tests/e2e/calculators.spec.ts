import { test, expect, type Page } from "@playwright/test";
import { assertNoProblems, watchForProblems } from "./helpers";

/**
 * Calculators end-to-end (audit brief Phase 3 + Phase 6).
 *
 * The unit suite (tests/unit/calculators.audit.test.ts) pins the arithmetic.
 * This spec pins the thing a unit test cannot: that the figures the AGENT
 * ACTUALLY SEES on screen, fed by the real cyprus_config row, match the
 * statutory scale. A wrong number here is quoted to a buyer.
 */

async function priceIn(page: Page, price: string) {
  const input = page.getByLabel(/purchase price/i);
  await input.fill(price);
  // recompute is a synchronous useMemo; give React a tick to paint
  await expect(page.getByText(/enter a price to calculate/i)).toHaveCount(0);
}

/** Reads the "Total" figure out of a calculator card by its heading. */
async function totalOf(page: Page, cardHeading: RegExp) {
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: cardHeading }) });
  const row = card.locator("div").filter({ hasText: /^Total/ }).last();
  return (await row.innerText()).replace(/\s+/g, " ").trim();
}

/** "€8.600" / "€8.600,00" -> 8600 (the app formats money de-DE style). */
function parseEuro(text: string): number {
  const m = text.match(/€\s*([\d.,]+)/);
  if (!m) throw new Error(`no euro amount in: ${text}`);
  const raw = m[1].replace(/\./g, "").replace(",", ".");
  return Number(raw);
}

test.describe("Cyprus purchase-cost calculators", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/calculators", { waitUntil: "networkidle" });
  });

  test("config loads — neither card reports a malformed cyprus_config", async ({ page }) => {
    await expect(page.getByText(/config missing or malformed/i)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /transfer fees/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /stamp duty/i })).toBeVisible();
  });

  test("empty state invites input rather than showing €0", async ({ page }) => {
    await expect(page.getByText(/enter a price to calculate/i).first()).toBeVisible();
  });

  test("€300,000 with relief matches the DLS scale (€8,600)", async ({ page }) => {
    const problems = watchForProblems(page);
    await priceIn(page, "300000");

    // relief defaults ON per doc 02 §C8
    await expect(page.getByRole("checkbox", { name: /50% relief/i })).toBeChecked();

    const transfer = parseEuro(await totalOf(page, /transfer fees/i));
    expect(transfer, "transfer fees for €300,000 with 50% relief").toBe(8600);

    assertNoProblems(problems, "calculators");
  });

  /**
   * F01: whether the sale is subject to VAT is a named scenario. A bare
   * calculator keeps today's default — not subject to VAT — and today's
   * figures; it is now SAID, not silently assumed.
   */
  test("[F01] the bare page opens on 'Not subject to VAT', named, at today's figure", async ({
    page,
  }) => {
    await expect(page.getByRole("group", { name: /VAT on this purchase/i })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Not subject to VAT/i })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^Subject to VAT/i })).not.toBeChecked();
    await expect(page.getByRole("radio", { name: /^Not confirmed/i })).not.toBeChecked();
    // nothing on the page says "VAT was paid" — a different fact
    await expect(page.getByText(/VAT was paid/i)).toHaveCount(0);

    await priceIn(page, "300000");
    expect(parseEuro(await totalOf(page, /transfer fees/i))).toBe(8600);
  });

  test("[F01] 'Not confirmed' shows both branches and keeps relief live", async ({ page }) => {
    await priceIn(page, "300000");
    await page.getByRole("radio", { name: /^Not confirmed/i }).check();
    await expect(page.getByText(/VAT status not confirmed — confirm before quoting/i)).toBeVisible();
    await expect(page.getByText(/subject to VAT, no transfer fees are payable/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /^If not subject to VAT$/i })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /50% relief/i })).toBeEnabled();
    const total = await totalOf(page, /transfer fees/i);
    expect(total).toMatch(/^Total \(if not subject to VAT\)/);
    expect(parseEuro(total)).toBe(8600);
  });

  /**
   * FINDING CALC-1 (fixed 2026-07-22). The DLS scale restarts for each
   * purchaser's share, so the figure an agent quotes a couple must be lower
   * than the sole-purchaser one. This is the assertion that would have caught
   * the original defect on the screen the agent actually reads.
   */
  test("[CALC-1] a joint purchase is assessed per share (€5,800, not €8,600)", async ({
    page,
  }) => {
    await priceIn(page, "300000");
    expect(parseEuro(await totalOf(page, /transfer fees/i))).toBe(8600); // sole purchaser

    await page.getByLabel(/purchasers/i).fill("2");
    await expect(page.getByText(/assessed per purchaser/i)).toBeVisible();
    await expect(page.getByText(/€\s?150[.,]000/).first()).toBeVisible();

    expect(
      parseEuro(await totalOf(page, /transfer fees/i)),
      "joint purchase must be assessed on two shares of €150,000",
    ).toBe(5800);
  });

  /**
   * Law 239(I)/2025 repealed stamp duty for documents signed on or after
   * 2026-01-01 (migration 0070). The panel must EXPLAIN rather than compute —
   * a figure here would be a repealed tax quoted to a buyer. The old scale's
   * arithmetic (per-contract assessment, the €20,000 cap) stays pinned in
   * tests/unit/calculators.audit.test.ts because it still governs contracts
   * signed on or before 2025-12-31.
   */
  test("stamp duty shows the abolition notice, never a figure (Law 239(I)/2025)", async ({
    page,
  }) => {
    const card = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /stamp duty/i }) });

    // the notice renders unconditionally — it does not wait for a price
    await expect(card.getByText(/abolished for documents signed on or after/i)).toBeVisible();
    await expect(card.getByText(/239\(I\)\/2025/)).toBeVisible();
    await expect(card.getByText(/follow the previous bands/i)).toBeVisible();

    // and no price conjures a total — not even one that once engaged the cap
    await priceIn(page, "12000000");
    await expect(card.locator("div").filter({ hasText: /^Total/ })).toHaveCount(0);
  });

  test("[CALC-1] the purchasers field defaults to a sole purchaser", async ({ page }) => {
    await expect(page.getByLabel(/purchasers/i)).toHaveValue("1");
  });

  test("unticking relief doubles the transfer fee to the gross €17,200", async ({ page }) => {
    await priceIn(page, "300000");
    await page.getByRole("checkbox", { name: /50% relief/i }).uncheck();
    expect(parseEuro(await totalOf(page, /transfer fees/i))).toBe(17200);
  });

  test("a purchase subject to VAT shows a nil transfer-fee assessment", async ({ page }) => {
    await priceIn(page, "300000");
    await page.getByRole("radio", { name: /^Subject to VAT/i }).check();
    await expect(page.getByText(/no transfer fees — the transaction is subject to VAT/i)).toBeVisible();
  });

  test("[UX-4] the relief tick is disabled while the purchase is subject to VAT", async ({
    page,
  }) => {
    await priceIn(page, "300000");
    const relief = page.getByRole("checkbox", { name: /50% relief/i });
    const subject = page.getByRole("radio", { name: /^Subject to VAT/i });
    const notSubject = page.getByRole("radio", { name: /^Not subject to VAT/i });

    await expect(relief).toBeEnabled();

    // A purchase subject to VAT carries no transfer fee at all, so relief
    // cannot change the number. Leaving the tick live invites an agent to
    // toggle it mid-conversation and watch nothing happen.
    await subject.check();
    await expect(relief).toBeDisabled();
    await expect(page.getByText(/no relief to apply/i)).toBeVisible();

    // Going back restores it WITH the prior choice intact — the control is
    // disabled, not reset.
    await notSubject.check();
    await expect(relief).toBeEnabled();
    await expect(relief).toBeChecked();
  });

  test("band breakdown is shown, not just a total (agents quote the bands)", async ({ page }) => {
    await priceIn(page, "300000");
    await expect(page.getByText("3%").first()).toBeVisible();
    await expect(page.getByText("5%").first()).toBeVisible();
    await expect(page.getByText("8%").first()).toBeVisible();
  });

  test("the copy summary carries the abolition, not a stamp total", async ({ page }) => {
    // The pasted artifact is what reaches a buyer; it must explain the repeal
    // rather than total a repealed tax. The summary string is built from its
    // own literals, NOT from the card DOM (2026-09-01 review: asserting the
    // card proved nothing about the clipboard) — so read the clipboard
    // itself. The desktop project is Chromium, where the permission works.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const card = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /stamp duty/i }) });
    await card.getByRole("button", { name: /copy summary/i }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip, "the pasted text explains the repeal").toMatch(/abolished for documents signed/i);
    expect(clip, "and names the law").toContain("239(I)/2025");
    expect(clip, "a repealed tax has no total").not.toMatch(/Total:/);
    // F01 binding: every copied summary names the VAT scenario on screen
    expect(clip, "and the scenario it was copied under").toContain("Scenario: not subject to VAT");
    // the on-card belt stays too
    await expect(card.getByText(/^Total/)).toHaveCount(0);
  });

  test("rates are labelled with their verification date (advice liability)", async ({ page }) => {
    await expect(page.getByText(/last verified/i).first()).toBeVisible();
    await expect(page.getByText(/verify current legislation/i).first()).toBeVisible();
    await expect(page.getByText(/indicative, not legal advice/i)).toBeVisible();
  });

  test("a negative or non-numeric price does not produce a fee", async ({ page }) => {
    await page.getByLabel(/purchase price/i).fill("-5000");
    await expect(page.getByText(/enter a price to calculate/i).first()).toBeVisible();
  });

  test("?price= deep link prefills from a property (the linking contract)", async ({ page }) => {
    await page.goto("/calculators?price=170000", { waitUntil: "networkidle" });
    await expect(page.getByLabel(/purchase price/i)).toHaveValue("170000");
    await expect(page.getByRole("radio", { name: /^Not subject to VAT/i })).toBeChecked();
    expect(parseEuro(await totalOf(page, /transfer fees/i))).toBe(3400); // 6,800 less relief
  });

  test("[F01] the transfer summary names its scenario", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await priceIn(page, "300000");
    const card = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /transfer fees/i }) });
    await card.getByRole("button", { name: /copy summary/i }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("Scenario: not subject to VAT");
    expect(clip).toMatch(/^Total: €8\.600$/m);
    expect(clip).toMatch(/Rates verified .* · computed .* — verify current legislation\./);
  });
});
