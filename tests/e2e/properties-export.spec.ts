import { test, expect } from "@playwright/test";

/**
 * Properties CSV export (IMPROVEMENTS B10). Row rendering is unit-tested in
 * lib/services/property-export.test.ts and the shared filter logic in
 * lib/queries/properties-list.test.ts; this covers the HTTP contract only the
 * running app proves, which is data-independent. Anonymous access is covered in
 * security.spec.ts.
 */
test.describe("Properties CSV export", () => {
  test("serves a well-formed, downloadable CSV to a signed-in user", async ({ page }) => {
    const res = await page.request.get("/properties/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");

    const disposition = res.headers()["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/filename="properties-\d{4}-\d{2}-\d{2}\.csv"/);

    const body = await res.text();
    expect(body.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    expect(body.replace(/^﻿/, "")).toMatch(
      /^Reference,Type,Transaction,Status,Visibility,Title,District,Area,Address,Bedrooms,Bathrooms,Covered m²,Plot m²,Asking price,Rent\/month,Mandate,Quality\r\n/,
    );
  });

  test("the archived scope produces its own filename", async ({ page }) => {
    const res = await page.request.get("/properties/export?scope=archived");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"] ?? "").toMatch(
      /filename="properties-archived-\d{4}-\d{2}-\d{2}\.csv"/,
    );
  });
});
