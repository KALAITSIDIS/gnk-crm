import { test, expect } from "@playwright/test";

/**
 * Leads CSV export (IMPROVEMENTS B10). Row rendering is unit-tested in
 * lib/services/lead-export.test.ts and the status scoping in
 * lib/queries/leads-list.test.ts; this covers the data-independent HTTP
 * contract. Anonymous access is covered in security.spec.ts.
 */
test.describe("Leads CSV export", () => {
  test("serves a well-formed, downloadable CSV to a signed-in user", async ({ page }) => {
    const res = await page.request.get("/leads/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");

    const disposition = res.headers()["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    // default scope is "open"
    expect(disposition).toMatch(/filename="leads-open-\d{4}-\d{2}-\d{2}\.csv"/);

    const body = await res.text();
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body.replace(/^﻿/, "")).toMatch(
      /^Received,Status,Source,Channel,Contact,Phone,Property,Message,First response,Agent,Lost reason\r\n/,
    );
  });

  test("the status scope is reflected in the filename", async ({ page }) => {
    const res = await page.request.get("/leads/export?status=closed");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"] ?? "").toMatch(
      /filename="leads-closed-\d{4}-\d{2}-\d{2}\.csv"/,
    );
  });
});
