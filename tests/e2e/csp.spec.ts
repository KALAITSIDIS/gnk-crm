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
});
