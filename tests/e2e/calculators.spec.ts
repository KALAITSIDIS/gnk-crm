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

    const stamp = parseEuro(await totalOf(page, /stamp duty/i));
    expect(stamp, "stamp duty for €300,000").toBe(507.5);

    assertNoProblems(problems, "calculators");
  });

  test("unticking relief doubles the transfer fee to the gross €17,200", async ({ page }) => {
    await priceIn(page, "300000");
    await page.getByRole("checkbox", { name: /50% relief/i }).uncheck();
    expect(parseEuro(await totalOf(page, /transfer fees/i))).toBe(17200);
  });

  test("a VAT-paid purchase shows a nil transfer-fee assessment", async ({ page }) => {
    await priceIn(page, "300000");
    await page.getByRole("checkbox", { name: /VAT was paid/i }).check();
    await expect(page.getByText(/no transfer fees/i)).toBeVisible();
  });

  test("band breakdown is shown, not just a total (agents quote the bands)", async ({ page }) => {
    await priceIn(page, "300000");
    await expect(page.getByText("3%").first()).toBeVisible();
    await expect(page.getByText("5%").first()).toBeVisible();
    await expect(page.getByText("8%").first()).toBeVisible();
  });

  test("the stamp-duty cap engages on a very large price", async ({ page }) => {
    await priceIn(page, "12000000");
    expect(parseEuro(await totalOf(page, /stamp duty/i))).toBe(20000);
    await expect(page.getByText(/capped at/i).first()).toBeVisible();
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
    expect(parseEuro(await totalOf(page, /transfer fees/i))).toBe(3400); // 6,800 less relief
  });
});
