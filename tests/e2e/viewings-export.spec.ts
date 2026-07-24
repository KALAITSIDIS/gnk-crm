import { test, expect } from "@playwright/test";

/**
 * Viewings CSV export (IMPROVEMENTS B10). Row rendering is unit-tested in
 * lib/services/viewing-export.test.ts; this covers the data-independent HTTP
 * contract. Anonymous access is in security.spec.ts.
 */
test.describe("Viewings CSV export", () => {
  test("serves a well-formed, downloadable CSV to a signed-in user", async ({ page }) => {
    const res = await page.request.get("/viewings/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");

    const disposition = res.headers()["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/filename="viewings-\d{4}-\d{2}-\d{2}\.csv"/);

    const body = await res.text();
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body.replace(/^﻿/, "")).toMatch(
      /^Scheduled,Status,Duration \(min\),Property,Attendee,Agent,Signed by,Signed at,Route date\r\n/,
    );
  });
});
