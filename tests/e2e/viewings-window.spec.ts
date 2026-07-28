import { test, expect } from "@playwright/test";

/**
 * Calendar window follows the anchor (B1 follow-up).
 *
 * The window used to be pinned to the server's `now` while the anchor lived in
 * client state, so stepping past a year ahead left the loaded range and drew an
 * empty week — indistinguishable from "nothing booked". These pin the contract
 * that replaced it: the anchor travels in `?d=`, the server loads around it,
 * and an out-of-window step refetches instead of lying.
 */
test.describe("Viewings calendar window", () => {
  test("loads around the anchor in the URL, not around today", async ({ page }) => {
    await page.goto("/viewings?d=2030-06-15&view=week", { waitUntil: "networkidle" });
    // The week of 2030-06-15 is ~4 years out — far outside a now-anchored
    // window — yet the calendar renders it as a normal week.
    await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
    await expect(page.getByText(/10 – Sunday, 16 Jun/i)).toBeVisible();
  });

  test("a malformed anchor falls back to today rather than erroring", async ({ page }) => {
    const res = await page.goto("/viewings?d=2026-13-45", { waitUntil: "networkidle" });
    expect(res?.status()).toBeLessThan(400);
    await expect(page.getByRole("heading", { name: "Viewings" })).toBeVisible();
  });

  test("stepping beyond the loaded window refetches and keeps the view mode", async ({ page }) => {
    // Land in day view near the far edge of the window, then step past it.
    await page.goto("/viewings?d=2026-07-24&view=day", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "day", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 366 days ahead is outside the +365 window, so this must push a new anchor.
    await page.goto("/viewings?d=2027-07-26&view=day", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/d=2027-07-26/);
    // view survives the refetch — it travels in the URL alongside the anchor
    await expect(page.getByRole("button", { name: "day", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText(/26 Jul/i).first()).toBeVisible();
  });

  test("switching view keeps the anchor", async ({ page }) => {
    await page.goto("/viewings?d=2030-06-15&view=week", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "day", exact: true }).click();
    await expect(page.getByRole("button", { name: "day", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText(/15 Jun/i).first()).toBeVisible();
  });
});
