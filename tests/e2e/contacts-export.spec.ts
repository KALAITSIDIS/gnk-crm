import { test, expect } from "@playwright/test";

/**
 * CSV export (IMPROVEMENTS B10). The row rendering is unit-tested in
 * lib/services/contact-export.test.ts; this covers the HTTP contract that only
 * the running app can prove — headers, filename, BOM — which is data-independent,
 * so it holds even against an empty local table. Anonymous access to
 * /contacts/export is covered in security.spec.ts alongside the other routes.
 */
test.describe("Contacts CSV export", () => {
  test("serves a well-formed, downloadable CSV to a signed-in user", async ({ page }) => {
    const res = await page.request.get("/contacts/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");

    const disposition = res.headers()["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/filename="contacts-\d{4}-\d{2}-\d{2}\.csv"/);

    const body = await res.text();
    expect(body.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM for Excel
    expect(body.replace(/^﻿/, "")).toMatch(
      /^Name,Kind,Phone,Email,Types,Temperature,Source,Nationality,Languages,Agent,Added\r\n/,
    );
  });

  test("the archived scope produces its own filename", async ({ page }) => {
    const res = await page.request.get("/contacts/export?archived=1");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"] ?? "").toMatch(
      /filename="contacts-archived-\d{4}-\d{2}-\d{2}\.csv"/,
    );
  });
});
