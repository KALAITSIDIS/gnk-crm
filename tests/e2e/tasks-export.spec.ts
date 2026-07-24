import { test, expect } from "@playwright/test";

/**
 * Tasks CSV export (IMPROVEMENTS B10). Row rendering is unit-tested in
 * lib/services/task-export.test.ts; this covers the data-independent HTTP
 * contract. Anonymous access is in security.spec.ts.
 */
test.describe("Tasks CSV export", () => {
  test("serves a well-formed, downloadable CSV to a signed-in user", async ({ page }) => {
    const res = await page.request.get("/tasks/export");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");

    const disposition = res.headers()["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/filename="my-tasks-\d{4}-\d{2}-\d{2}\.csv"/);

    const body = await res.text();
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body.replace(/^﻿/, "")).toMatch(/^Title,Status,Due,Done at,Property,Auto,Created\r\n/);
  });
});
