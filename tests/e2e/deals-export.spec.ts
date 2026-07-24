import { test, expect } from "@playwright/test";

/**
 * Deals CSV export (IMPROVEMENTS B10). Served from /pipeline/export (the board
 * is the deals view). Row rendering is unit-tested in lib/services/deal-export.
 * test.ts and the deal-type scoping in lib/queries/deals-list.test.ts; this
 * covers the data-independent HTTP contract. Anonymous access is in
 * security.spec.ts.
 */
test.describe("Deals CSV export", () => {
  test("serves a well-formed, downloadable CSV to a signed-in user", async ({ page }) => {
    const res = await page.request.get("/pipeline/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");

    const disposition = res.headers()["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    // default deal-type tab is "sale"
    expect(disposition).toMatch(/filename="deals-sale-\d{4}-\d{2}-\d{2}\.csv"/);

    const body = await res.text();
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body.replace(/^﻿/, "")).toMatch(
      /^Title,Type,Stage,Status,Expected value,Property,Buyer,Seller,Agent,Commission notes,Won,Lost,Lost reason,Created\r\n/,
    );
  });

  test("the deal-type tab is reflected in the filename", async ({ page }) => {
    const res = await page.request.get("/pipeline/export?type=rental");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"] ?? "").toMatch(
      /filename="deals-rental-\d{4}-\d{2}-\d{2}\.csv"/,
    );
  });
});
