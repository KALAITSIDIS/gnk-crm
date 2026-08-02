import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL, MODULES } from "./helpers";

const baseUrl = () => process.env.E2E_BASE_URL ?? "http://localhost:3000";
const isLocal = () => /localhost|127\.0\.0\.1/.test(baseUrl());

/**
 * Local-stack service key — the standard demo key printed by `supabase status`.
 * Not a secret, only ever reaches 127.0.0.1, and used exactly as nudges.spec.ts
 * uses it: to seed a fixture the UI would otherwise need a whole wizard to make.
 */
const LOCAL_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/**
 * Markers so a crashed run self-heals on the next one rather than leaking rows.
 * `contacts` has a `notes` column; `properties` does not, so its marker is the
 * reference prefix.
 */
const CSP_FIXTURE_TAG = "csp-detail-fixture";
const CSP_FIXTURE_REF = "CSP-FIXTURE-";

function serviceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
    LOCAL_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

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

  test("the policy names a reporting endpoint, and it accepts a report anonymously", async ({
    page,
  }) => {
    // Without this the report-only stage is decorative: violations reach the
    // visitor's console and nobody else, so "let it run in production for a
    // while" cannot be acted on.
    const res = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const headers = res!.headers();
    expect(headers["content-security-policy-report-only"]).toContain(
      "report-uri /api/csp-report",
    );
    expect(headers["reporting-endpoints"] ?? "").toContain("/api/csp-report");

    // Browsers post reports WITHOUT credentials, so the endpoint must be
    // reachable unauthenticated — if the proxy redirects it to /login every
    // report is silently lost.
    const anon = await playwrightRequest.newContext();
    const posted = await anon.post(`${baseUrl()}/api/csp-report`, {
      headers: { "content-type": "application/csp-report" },
      data: JSON.stringify({
        "csp-report": {
          "document-uri": `${baseUrl()}/dashboard`,
          "effective-directive": "script-src",
          "blocked-uri": "eval",
        },
      }),
    });
    expect(posted.status()).toBe(204);
    await anon.dispose();
  });

  test("the policy actually catches a violation the app does not make", async ({ page }) => {
    // Proves the policy has teeth: something it forbids really does raise a
    // violation, with disposition "report" (i.e. observed, not blocked).
    // Without this, "zero violations everywhere" could equally mean the policy
    // is inert.
    await collectViolations(page);
    await page.goto("/dashboard", { waitUntil: "networkidle" });

    // Probe img-src, not script-src: 'strict-dynamic' deliberately TRUSTS
    // scripts inserted by already-trusted code, so an injected <script> is no
    // violation at all. Port 9 (discard) is a different origin from the app and
    // never leaves the machine.
    await page.evaluate(() => {
      const img = document.createElement("img");
      img.src = "http://127.0.0.1:9/csp-probe.png";
      document.body.appendChild(img);
    });

    await expect
      .poll(async () => (await readViolations(page)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    const [v] = await readViolations(page);
    expect(v.directive).toContain("img-src");
    expect(v.blockedURI).toContain("127.0.0.1:9");

    // NOTE: whether the browser then POSTS that report to /api/csp-report is
    // deliberately NOT asserted. Reports are emitted by the browser's network
    // stack rather than the page, so Playwright cannot observe them, and no
    // report reached the dev server even after a 70s wait — headless Chromium
    // over plain http://localhost appears not to deliver them. The endpoint
    // itself is covered by the synthetic POST above. Verify real delivery in
    // production by looking for "[csp]" in the Vercel runtime logs.
  });

  test("the reporting endpoint refuses an oversized body and never 500s", async () => {
    const anon = await playwrightRequest.newContext();

    const huge = await anon.post(`${baseUrl()}/api/csp-report`, {
      headers: { "content-type": "application/csp-report" },
      data: "x".repeat(20_000),
    });
    expect(huge.status()).toBe(413);

    // Garbage from the public internet is expected, not exceptional.
    for (const junk of ["not json at all", "[]", "{}", '{"csp-report":{}}']) {
      const res = await anon.post(`${baseUrl()}/api/csp-report`, {
        headers: { "content-type": "application/csp-report" },
        data: junk,
      });
      expect(res.status(), `body: ${junk}`).toBe(204);
    }
    await anon.dispose();
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
   * tabbed forms, the media grid, the signature canvas, the PDF builder.
   *
   * These used to take the first row of the list and assert it existed, which
   * made them depend on RESIDUE: only happy-path.spec.ts creates a property and
   * a contact, so against a freshly reset database both FAILED on run 1 and
   * passed on run 2 — the exact anti-pattern HANDOVER §4/§5 calls out, and
   * invisible to CI, which runs `checks` + `rls` rather than Playwright.
   *
   * Skipping when the list is empty would have been the cheap fix, but these
   * are the heaviest client routes in the app: losing their CSP evidence
   * silently on a fresh database is the wrong trade. So the spec seeds its own
   * property and contact when the list has none, and removes them afterwards.
   * An existing row is still preferred when one is there — real data exercises
   * media and documents that a bare fixture does not.
   *
   * Seeding needs the service key, so it is local-only; against a deployed base
   * URL the tests still self-skip on an empty list rather than assert falsely.
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

  /** The seeded org the local dev app signs into. */
  async function fixtureOrgId(svc: SupabaseClient): Promise<string> {
    const { data: profile } = await svc
      .from("profiles")
      .select("org_id")
      .eq("email", ADMIN_EMAIL)
      .single();
    expect(profile, `no profile for ${ADMIN_EMAIL} — is the local stack seeded?`).not.toBeNull();
    return profile!.org_id;
  }

  /** Minimal rows: enough for the detail page to render its client code. */
  async function seedDetail(svc: SupabaseClient, kind: "property" | "contact"): Promise<string> {
    const orgId = await fixtureOrgId(svc);
    const tag = Date.now().toString(36);

    if (kind === "property") {
      // `properties` has no `notes` column, so the marker is the reference —
      // which is required anyway, and readable in the UI if a row ever leaks.
      const { data, error } = await svc
        .from("properties")
        .insert({
          org_id: orgId,
          reference: `${CSP_FIXTURE_REF}${tag}`,
          property_type: "villa",
          asking_price: 250000,
        })
        .select("id")
        .single();
      expect(error, `seeding a property: ${error?.message}`).toBeNull();
      return `/properties/${data!.id}`;
    }

    const { data, error } = await svc
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "CSP",
        last_name: `Fixture-${tag}`,
        phone_e164: `+357990${tag.slice(-5)}`,
        notes: CSP_FIXTURE_TAG,
      })
      .select("id")
      .single();
    expect(error, `seeding a contact: ${error?.message}`).toBeNull();
    return `/contacts/${data!.id}`;
  }

  /**
   * Rows this spec created. Marker-based rather than id-based so a crashed run
   * is cleaned up by the next one. Events stay — append-only by design.
   */
  test.afterAll(async () => {
    if (!isLocal()) return;
    const svc = serviceClient();
    await svc.from("properties").delete().like("reference", `${CSP_FIXTURE_REF}%`);
    await svc.from("contacts").delete().eq("notes", CSP_FIXTURE_TAG);
  });

  const DETAIL_ROUTES: {
    name: string;
    list: string;
    hrefPrefix: string;
    kind: "property" | "contact";
  }[] = [
    { name: "property detail", list: "/properties", hrefPrefix: "/properties/", kind: "property" },
    { name: "contact detail", list: "/contacts", hrefPrefix: "/contacts/", kind: "contact" },
  ];

  for (const route of DETAIL_ROUTES) {
    test(`${route.name} reports no CSP violations`, async ({ page }) => {
      await collectViolations(page);
      await page.goto(route.list, { waitUntil: "networkidle" });

      let href = await firstDetailHref(page, route.hrefPrefix);
      if (!href) {
        // Empty list. Seed rather than skip — see the note above the helpers.
        test.skip(
          !isLocal(),
          `no ${route.name} to open and seeding needs the local service key`,
        );
        href = await seedDetail(serviceClient(), route.kind);
      }

      await page.goto(href, { waitUntil: "networkidle" });
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

  /**
   * The PUBLIC routes must carry the policy too.
   *
   * They skip the AUTH gate, and for a while they skipped the CSP with it —
   * which meant the only unauthenticated HTML this app serves was also the only
   * HTML with no `script-src`. That is backwards: the buyer page is the one
   * page a stranger can reach, so it is the one that most needs the policy.
   * Caught by diffing production response headers, not by a test, so this is
   * the guard that stops it coming back.
   */
  test.describe("public routes are not exempt from the policy", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    for (const path of ["/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "/offline"]) {
      test(`${path} carries the report-only policy`, async ({ page }) => {
        const response = await page.goto(path, { waitUntil: "domcontentloaded" });
        expect(response?.status(), `${path} must be reachable anonymously`).toBe(200);

        const policy = response?.headers()["content-security-policy-report-only"];
        expect(policy, `${path} is served with no CSP`).toBeTruthy();
        expect(policy).toContain("script-src");
        expect(policy).toContain("object-src 'none'");
        // clickjacking protection is enforced separately in next.config.ts and
        // must survive on the public routes as well
        expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
      });
    }
  });
});
