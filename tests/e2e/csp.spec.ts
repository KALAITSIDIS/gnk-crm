import { test, expect, type Page } from "@playwright/test";
import { MODULES } from "./helpers";

/**
 * Content-Security-Policy, staged report-only (IMPROVEMENTS C1).
 *
 * The policy is assembled and unit-tested in lib/services/csp.ts; what only the
 * running app can prove is whether it actually HOLDS — i.e. whether promoting
 * it from Report-Only to enforced would break a screen. Every violation the
 * browser reports here is something that would be blocked on the day it is
 * enforced, so these tests are the evidence for that decision.
 */

interface Violation {
  directive: string;
  blockedURI: string;
  /** which bundle triggered it — the only way to find an eval() in vendor code */
  sourceFile?: string;
  lineNumber?: number;
}

/** Collect `securitypolicyviolation` events — more reliable than console text. */
async function collectViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __csp: Violation[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: Violation[] }).__csp.push({
        directive: e.effectiveDirective || e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
      });
    });
  });
}

async function readViolations(page: Page): Promise<Violation[]> {
  return page.evaluate(() => (window as unknown as { __csp: Violation[] }).__csp ?? []);
}

test.describe("Content-Security-Policy (report-only)", () => {
  test("the response carries the report-only policy, and framing stays ENFORCED", async ({
    page,
  }) => {
    const res = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const headers = res!.headers();

    const reportOnly = headers["content-security-policy-report-only"] ?? "";
    expect(reportOnly, "report-only policy missing").toContain("script-src");
    expect(reportOnly).toContain("'strict-dynamic'");
    expect(reportOnly).toMatch(/'nonce-[a-f0-9]+'/);

    // The enforced header must still forbid framing — staging the big policy
    // must not quietly drop the clickjacking protection shipped in SEC-1..4.
    expect(headers["content-security-policy"] ?? "").toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  test("a fresh nonce is issued per request — a fixed nonce is no protection", async ({ page }) => {
    const first = (await page.goto("/dashboard"))!.headers()["content-security-policy-report-only"];
    const second = (await page.goto("/contacts"))!.headers()["content-security-policy-report-only"];
    const nonceOf = (csp?: string) => csp?.match(/'nonce-([a-f0-9]+)'/)?.[1];

    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(second)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  test("Next stamps the nonce on its own inline scripts", async ({ page }) => {
    // Without this round-trip, 'strict-dynamic' would block Next's bootstrap
    // the moment the policy is enforced.
    const res = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const nonce = res!
      .headers()
      ["content-security-policy-report-only"].match(/'nonce-([a-f0-9]+)'/)![1];

    // NB: the browser deliberately blanks the `nonce` CONTENT attribute in the
    // DOM (so injected script cannot read it back out) and exposes the value
    // only through the `.nonce` IDL property — a `script[nonce="…"]` selector
    // finds nothing even when it is applied correctly.
    const scriptsWithNonce = await page.evaluate(
      (n) => [...document.querySelectorAll("script")].filter((s) => s.nonce === n).length,
      nonce,
    );
    expect(scriptsWithNonce, "Next did not apply the nonce to any script").toBeGreaterThan(0);
  });

  // Deep routes carry the heavier client code (uploads, signature canvas, PDF
  // builder), so they are the likeliest place for an eval/blob surprise.
  const DEEP_ROUTES = [
    "/security",
    "/settings/retention",
    "/settings/users",
    "/reports/commission-evidence",
    "/properties/new",
    "/contacts/new",
    "/route-sheet",
  ];

  for (const mod of [
    ...MODULES.map((m) => ({ name: m.name, path: m.path })),
    ...DEEP_ROUTES.map((path) => ({ name: path, path })),
  ]) {
    test(`${mod.name} reports no CSP violations`, async ({ page }) => {
      await collectViolations(page);
      await page.goto(mod.path, { waitUntil: "networkidle" });
      // let late resources (fonts, images, hydration) settle
      await page.waitForTimeout(500);

      const violations = await readViolations(page);
      expect(
        violations,
        `${mod.name} would break under an enforced CSP: ${JSON.stringify(violations)}`,
      ).toEqual([]);
    });
  }

  /**
   * Entity DETAIL pages carry the heavy client code the list pages do not —
   * tabbed forms, the media grid, the signature canvas, the PDF builder. They
   * are reached by clicking through from a list so the test uses real ids
   * rather than fixtures, and it fails loudly if a list is empty rather than
   * passing vacuously.
   */
  /** First href on the page whose id has a UUID shape (never /new or /export). */
  async function firstDetailHref(page: Page, prefix: string): Promise<string | null> {
    return page.evaluate((p) => {
      const detail = new RegExp(`^${p}[0-9a-f-]{36}$`);
      return (
        [...document.querySelectorAll("a")]
          .map((a) => a.getAttribute("href") ?? "")
          .find((h) => detail.test(h)) ?? null
      );
    }, prefix);
  }

  /**
   * The calendar's list view shows only UPCOMING viewings, so on a database
   * whose bookings are in the past it is empty. Walk the calendar backwards a
   * few weeks using the `?d=` anchor until a real viewing turns up.
   */
  async function findViewingHref(page: Page): Promise<string | null> {
    for (let weeksBack = 0; weeksBack <= 10; weeksBack++) {
      const day = new Date(Date.now() - weeksBack * 7 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await page.goto(`/viewings?d=${day}&view=week`, { waitUntil: "networkidle" });
      const href = await firstDetailHref(page, "/viewings/");
      if (href) return href;
    }
    return null;
  }

  const DETAIL_ROUTES: { name: string; list: string; hrefPrefix: string }[] = [
    { name: "property detail", list: "/properties", hrefPrefix: "/properties/" },
    { name: "contact detail", list: "/contacts", hrefPrefix: "/contacts/" },
  ];

  for (const route of DETAIL_ROUTES) {
    test(`${route.name} reports no CSP violations`, async ({ page }) => {
      await collectViolations(page);
      await page.goto(route.list, { waitUntil: "networkidle" });

      const href = await firstDetailHref(page, route.hrefPrefix);
      expect(href, `no ${route.name} to open — this assertion would be vacuous`).toBeTruthy();

      await page.goto(href!, { waitUntil: "networkidle" });
      await page.waitForTimeout(700); // tabs/hydration settle

      const violations = await readViolations(page);
      expect(
        violations,
        `${route.name} (${href}) would break under an enforced CSP: ${JSON.stringify(violations)}`,
      ).toEqual([]);
    });
  }

  test("viewing detail reports no CSP violations", async ({ page }) => {
    await collectViolations(page);
    const href = await findViewingHref(page);
    // A clean seed database has no viewings in this org, so skip rather than
    // assert nothing: a green run here is NOT evidence for this route unless a
    // viewing exists. (Same self-skip convention as [PERF-2] paging.)
    test.skip(!href, "no viewing visible to this org — nothing to open");

    await page.goto(href!, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);

    const violations = await readViolations(page);
    expect(
      violations,
      `viewing detail (${href}) would break under an enforced CSP: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  test("property images served from Supabase Storage satisfy img-src", async ({ page }) => {
    // img-src carries the Supabase origin specifically because Storage serves
    // property renditions. Without an actual image request this directive would
    // never be exercised, so assert the request happened before trusting the
    // clean result.
    await collectViolations(page);
    const storageHits: string[] = [];
    page.on("response", (r) => {
      if (/\/storage\/v1\/object\/public\//.test(r.url())) storageHits.push(r.url());
    });

    await page.goto("/properties", { waitUntil: "networkidle" });
    await page.waitForTimeout(700);

    test.skip(
      storageHits.length === 0,
      "no property media in this database — img-src from Storage is unexercised",
    );

    const violations = await readViolations(page);
    expect(
      violations.filter((v) => v.directive.includes("img")),
      `Storage images would be blocked: ${JSON.stringify(violations)}`,
    ).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("the slip-signing canvas reports no CSP violations", async ({ page }) => {
    // The signature pad draws to <canvas> and exports a data: URL — exactly the
    // sort of thing img-src/worker-src can silently break.
    await collectViolations(page);
    const href = await findViewingHref(page);
    test.skip(!href, "no viewing visible to this org — nothing to sign");

    await page.goto(`${href}/sign`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);

    const violations = await readViolations(page);
    expect(
      violations,
      `sign page would break under an enforced CSP: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });
});
