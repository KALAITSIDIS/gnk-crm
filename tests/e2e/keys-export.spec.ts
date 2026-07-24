import { test, expect } from "@playwright/test";

/**
 * Keys register CSV export (IMPROVEMENTS B10). Row rendering is unit-tested in
 * lib/services/key-export.test.ts and the status/text scoping in
 * lib/queries/keys-list.test.ts; this covers the data-independent HTTP contract.
 * Anonymous access is in security.spec.ts.
 */
test.describe("Keys CSV export", () => {
  test("serves a well-formed, downloadable CSV to a signed-in user", async ({ page }) => {
    const res = await page.request.get("/keys/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");

    const disposition = res.headers()["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/filename="keys-\d{4}-\d{2}-\d{2}\.csv"/);

    const body = await res.text();
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body.replace(/^﻿/, "")).toMatch(/^Key code,Property,Description,Status,Holder\r\n/);
  });

  test("a status filter is accepted (still a valid CSV)", async ({ page }) => {
    const res = await page.request.get("/keys/export?status=checked_out");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
  });
});
