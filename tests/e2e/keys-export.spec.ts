import { test, expect } from "@playwright/test";
import { KEY_SEARCH_MAX, KEY_SEARCH_NOTHING, KEY_SEARCH_TOO_LONG } from "@/lib/validators/keys";

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

  // The search is one request whose select must name the embed its reference
  // filter uses; a drift is a 400 from PostgREST, i.e. a 500 refusal here
  // (T-key-reference-search). The DB suite proves which keys it finds.
  test("a search, alone or with a status, is accepted (still a valid CSV)", async ({ page }) => {
    for (const qs of ["q=PAF", "q=paf&status=in_office"]) {
      const res = await page.request.get(`/keys/export?${qs}`);
      expect(res.status(), qs).toBe(200);
      expect(res.headers()["content-type"], qs).toContain("text/csv");
    }
  });

  // A search the register cannot run as asked — longer than the box allows, or
  // nothing but characters a search leaves out — is refused in words: never
  // the bare 500 it used to be, never the unfiltered register as this search's
  // file. supabase/tests/keys-search-length.test.ts proves no key is read and
  // nothing audited. T-keys-search-length
  test("a search over the limit, or with nothing to search, is refused in words; one at the limit is a CSV", async ({ page }) => {
    for (const [q, error] of [
      ["x".repeat(KEY_SEARCH_MAX + 1), KEY_SEARCH_TOO_LONG],
      ["(,)", KEY_SEARCH_NOTHING],
    ]) {
      const refused = await page.request.get(`/keys/export?q=${encodeURIComponent(q)}`);
      expect(refused.status(), q).toBe(400);
      expect(refused.headers()["content-type"], q).toContain("application/json");
      expect(refused.headers()["cache-control"], q).toContain("no-store");
      expect(await refused.json(), q).toEqual({ error, reason: "invalid" });
    }

    const atLimit = await page.request.get(`/keys/export?q=${"x".repeat(KEY_SEARCH_MAX)}`);
    expect(atLimit.status()).toBe(200);
    expect(atLimit.headers()["content-type"]).toContain("text/csv");
  });
});

test.describe("Keys register search length", () => {
  // (No Export assertion here: the e2e organisation holds no keys, so Export
  // is hidden on every /keys URL — the DB test pins "no Export on a refusal".)
  test("a linked search over the limit says so in the register's place, and the box holds 100", async ({ page }) => {
    await page.goto(`/keys?q=${"x".repeat(KEY_SEARCH_MAX + 1)}`);
    await expect(page.getByText(KEY_SEARCH_TOO_LONG)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search keys" })).toHaveAttribute(
      "maxlength",
      String(KEY_SEARCH_MAX),
    );
  });
});
