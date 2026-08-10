import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { baseUrl, fixtureProfile, isLocal, MODULES, serviceClient } from "./helpers";

/**
 * Markers so a crashed run self-heals on the next one rather than leaking rows.
 * `contacts` has a `notes` column; `properties` does not, so its marker is the
 * reference prefix.
 */
const CSP_FIXTURE_TAG = "csp-detail-fixture";
const CSP_FIXTURE_REF = "CSP-FIXTURE-";
/** Folder in the public `media` bucket holding this spec's uploaded fixtures. */
const CSP_FIXTURE_MEDIA_DIR = "csp-fixture";
const CSP_FIXTURE_MEDIA_PREFIX = `${CSP_FIXTURE_MEDIA_DIR}/`;


/**
 * Content-Security-Policy — **ENFORCED** since 2026-08-10 (IMPROVEMENTS C1).
 *
 * The policy is assembled and unit-tested in lib/services/csp.ts; what only the
 * running app can prove is whether it actually HOLDS. These tests were the
 * evidence for promoting it, and they change meaning now that it has been:
 * a violation reported here used to be a warning about a future decision, and
 * is now a screen that is ALREADY broken in production.
 *
 * CI runs this against a real production build and `next start`, not `next dev`
 * — so `'unsafe-eval'` is absent, prerendering is real, and the policy bites.
 * That is what makes a green run here worth anything.
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

test.describe("Content-Security-Policy (ENFORCED)", () => {
  test("the response carries the ENFORCING policy, and it is OURS", async ({ page }) => {
    const res = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const headers = res!.headers();

    const policy = headers["content-security-policy"] ?? "";
    expect(policy, "enforcing policy missing").toContain("script-src");
    expect(policy).toContain("'strict-dynamic'");

    /**
     * THE collision guard — and it matters MORE now than it did before.
     *
     * It used to assert there was NO enforcing CSP header at all, because a
     * `Content-Security-Policy` key in `next.config.ts` `headers()` lands on the
     * REQUEST under the very name Next reads the nonce from, wins on Vercel, and
     * stamps 0 of 22 scripts. That was production for four days (IMPROVEMENTS
     * C1, root-caused 2026-08-10).
     *
     * There IS an enforcing header now, by design, so "absent" is no longer the
     * property to check. The property is that the enforcing header is the one
     * carrying a NONCE — i.e. ours, not a bare `frame-ancestors 'none'` that has
     * stolen the name. Under report-only that mistake was survivable; under
     * enforcement the same mistake blocks every script on every page.
     */
    expect(
      policy,
      "enforcing CSP carries no nonce — something else has taken the header (see next.config.ts)",
    ).toMatch(/'nonce-[a-f0-9]+'/);

    // Two policies would double-report and double-block; the flip replaces the
    // report-only header rather than adding to it.
    expect(
      headers["content-security-policy-report-only"],
      "report-only must be GONE once enforcing — not served alongside",
    ).toBeUndefined();

    // Framing is now enforced twice over: X-Frame-Options AND the policy's own
    // frame-ancestors. Both are asserted because they have independently
    // regressed before.
    expect(headers["x-frame-options"], "clickjacking guard missing (SEC-1)").toBe("DENY");
    expect(policy, "frame-ancestors must still ship inside the policy").toContain(
      "frame-ancestors 'none'",
    );
  });

  test("the policy names a reporting endpoint, and it accepts a report anonymously", async ({
    page,
  }) => {
    // Without this the report-only stage is decorative: violations reach the
    // visitor's console and nobody else, so "let it run in production for a
    // while" cannot be acted on.
    const res = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const headers = res!.headers();
    // Still asserted under enforcement: `report-uri`/`report-to` stay in the
    // policy so a blocked violation is REPORTED as well as blocked. Dropping
    // them on the flip would have made Sentry go quiet exactly when the policy
    // started biting.
    expect(headers["content-security-policy"]).toContain("report-uri /api/csp-report");
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
    // violation. Under enforcement the disposition is now "enforce" and the
    // probe image is actually BLOCKED rather than merely observed — the
    // `securitypolicyviolation` event fires either way, which is what this
    // reads. Without this, "zero violations everywhere" could equally mean the
    // policy is inert.
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

  test("a real batched report-to payload is accepted, not dropped as oversized", async () => {
    // Found in production 2026-08-03: two genuine browser reports were POSTed
    // and BOTH returned 413, so real violations were collected and thrown away.
    // The old cap was 16 KB on the premise that "reports are small; anything
    // larger is not a browser" — which is wrong for the `report-to` shape.
    // Browsers BATCH violations into one array, and every envelope repeats
    // `originalPolicy`, i.e. this app's entire CSP string. A page with a dozen
    // violations therefore exceeds 16 KB on policy text alone.
    //
    // This asserts the endpoint survives the shape it actually receives. The
    // payload below is built to look like what Chromium sends, not padded with
    // filler, so the size is representative rather than arbitrary.
    const anon = await playwrightRequest.newContext();

    const originalPolicy =
      "default-src 'self'; script-src 'self' 'nonce-abc123def456' 'strict-dynamic' " +
      "'unsafe-inline' https:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: " +
      "https://yjgirvzgoiywdojnpkpd.supabase.co; connect-src 'self' " +
      "https://yjgirvzgoiywdojnpkpd.supabase.co; font-src 'self' data:; object-src 'none'; " +
      "base-uri 'self'; frame-ancestors 'none'; report-uri /api/csp-report";

    const batch = Array.from({ length: 24 }, (_, i) => ({
      type: "csp-violation",
      age: i * 12,
      url: `${baseUrl()}/properties/0e6f3c1a-7b21-4d55-9f0c-2a1b8c4d5e6f`,
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      body: {
        documentURL: `${baseUrl()}/properties/0e6f3c1a-7b21-4d55-9f0c-2a1b8c4d5e6f`,
        referrer: `${baseUrl()}/properties`,
        blockedURL: `https://cdn.example.com/asset-${i}.png`,
        effectiveDirective: "img-src",
        originalPolicy,
        sourceFile: `${baseUrl()}/_next/static/chunks/${i}-a1b2c3d4e5f6.js`,
        sample: "",
        disposition: "report",
        statusCode: 200,
        lineNumber: 1,
        columnNumber: 4096,
      },
    }));

    const payload = JSON.stringify(batch);
    // Guard the guard: if this ever drops below the old 16 KB cap the test stops
    // reproducing the bug and would pass for the wrong reason.
    expect(payload.length, "payload must exceed the old 16 KB cap to be meaningful").toBeGreaterThan(
      16_384,
    );

    const batched = await anon.post(`${baseUrl()}/api/csp-report`, {
      headers: { "content-type": "application/reports+json" },
      data: payload,
    });
    expect(
      batched.status(),
      `a ${payload.length}-byte batched report must be accepted, not 413'd`,
    ).toBe(204);
    await anon.dispose();
  });

  test("the reporting endpoint refuses an oversized body and never 500s", async () => {
    const anon = await playwrightRequest.newContext();

    // Above the raised cap — the flood guard must still exist.
    const huge = await anon.post(`${baseUrl()}/api/csp-report`, {
      headers: { "content-type": "application/csp-report" },
      data: "x".repeat(200_000),
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
    const first = (await page.goto("/dashboard"))!.headers()["content-security-policy"];
    const second = (await page.goto("/contacts"))!.headers()["content-security-policy"];
    const nonceOf = (csp?: string) => csp?.match(/'nonce-([a-f0-9]+)'/)?.[1];

    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(second)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  test("Next stamps the nonce on its own inline scripts", async ({ page }) => {
    // Without this round-trip, 'strict-dynamic' would block Next's bootstrap
    // the moment the policy is enforced.
    const res = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const nonce = res!.headers()["content-security-policy"].match(/'nonce-([a-f0-9]+)'/)![1];

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
    return (await fixtureProfile(svc)).orgId;
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
   * A 1x1 PNG. The codec is irrelevant — what is under test is whether the
   * browser is ALLOWED to fetch `<img>` from the Supabase origin, not whether
   * it can decode it. Kept inline so the fixture needs no binary in the repo.
   */
  const ONE_PIXEL_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  /**
   * A property whose cover thumbnail is a real object in the public `media`
   * bucket, so `/properties` renders an `<img>` at the Supabase origin and
   * `img-src` is actually exercised.
   *
   * `path_thumb` is what the list reads (`publicMediaUrl` in
   * `lib/utils/storage.ts` turns it into
   * `<SUPABASE_URL>/storage/v1/object/public/media/<path>`), and `is_cover`
   * is what makes it the one chosen.
   */
  async function seedPropertyWithCover(svc: SupabaseClient): Promise<void> {
    const orgId = await fixtureOrgId(svc);
    const tag = Date.now().toString(36);
    const path = `${CSP_FIXTURE_MEDIA_PREFIX}${tag}/thumb.png`;

    const up = await svc.storage
      .from("media")
      .upload(path, ONE_PIXEL_PNG, { contentType: "image/png", upsert: true });
    expect(up.error, `uploading the fixture image: ${up.error?.message}`).toBeNull();

    const { data: property, error: propErr } = await svc
      .from("properties")
      .insert({
        org_id: orgId,
        reference: `${CSP_FIXTURE_REF}${tag}`,
        property_type: "villa",
        asking_price: 250000,
      })
      .select("id")
      .single();
    expect(propErr, `seeding a property: ${propErr?.message}`).toBeNull();

    const { error: mediaErr } = await svc.from("property_media").insert({
      org_id: orgId,
      property_id: property!.id,
      kind: "photo",
      path_thumb: path,
      is_cover: true,
    });
    expect(mediaErr, `seeding property_media: ${mediaErr?.message}`).toBeNull();
  }

  /**
   * A viewing in the CURRENT week, with the property and contact it requires.
   *
   * `viewings` has three mandatory foreign keys — property, contact and agent —
   * so this is the one fixture that cannot be a single insert. `agent_id` is the
   * signed-in admin so the slip page's `canSign` is true for the reason it would
   * be in real use, not because admin bypasses it.
   *
   * `scheduled_at` is NOW on purpose: `findViewingHref` walks the calendar back
   * from today, so a viewing dated in the current week is found on the first
   * iteration. Status stays `scheduled` with no `viewing_slips` row, which is
   * what makes the sign page render the signature canvas rather than a receipt.
   */
  async function seedViewing(svc: SupabaseClient): Promise<string> {
    const { id: agentId, orgId } = await fixtureProfile(svc);
    const tag = Date.now().toString(36);

    const { data: property, error: propErr } = await svc
      .from("properties")
      .insert({
        org_id: orgId,
        reference: `${CSP_FIXTURE_REF}V${tag}`,
        property_type: "villa",
        asking_price: 250000,
      })
      .select("id")
      .single();
    expect(propErr, `seeding a property for the viewing: ${propErr?.message}`).toBeNull();

    const { data: contact, error: contactErr } = await svc
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "CSP",
        last_name: `Viewing-${tag}`,
        phone_e164: `+357991${tag.slice(-5)}`,
        notes: CSP_FIXTURE_TAG,
      })
      .select("id")
      .single();
    expect(contactErr, `seeding a contact for the viewing: ${contactErr?.message}`).toBeNull();

    const { data: viewing, error: viewingErr } = await svc
      .from("viewings")
      .insert({
        org_id: orgId,
        property_id: property!.id,
        contact_id: contact!.id,
        agent_id: agentId,
        scheduled_at: new Date().toISOString(),
        status: "scheduled",
      })
      .select("id")
      .single();
    expect(viewingErr, `seeding a viewing: ${viewingErr?.message}`).toBeNull();

    return `/viewings/${viewing!.id}`;
  }

  /**
   * Rows this spec created. Marker-based rather than id-based so a crashed run
   * is cleaned up by the next one. Events stay — append-only by design.
   *
   * `property_media` rows go with the property (`on delete cascade`), but the
   * BYTES in the bucket do not — Storage knows nothing about the foreign key,
   * so an uploaded fixture would accumulate on every run without this.
   */
  test.afterAll(async () => {
    if (!isLocal()) return;
    const svc = serviceClient();

    /**
     * ORDER MATTERS. `viewings.property_id` and `.contact_id` are plain
     * references with NO `on delete cascade`, so deleting the property first
     * fails the foreign key and leaves the whole fixture set behind — which the
     * next run then trips over. Viewings go first, and by property id rather
     * than by a marker, because `viewings` has no free-text column to tag.
     */
    const { data: props } = await svc
      .from("properties")
      .select("id")
      .like("reference", `${CSP_FIXTURE_REF}%`);
    const propIds = (props ?? []).map((p) => p.id);
    if (propIds.length) await svc.from("viewings").delete().in("property_id", propIds);

    await svc.from("properties").delete().like("reference", `${CSP_FIXTURE_REF}%`);
    await svc.from("contacts").delete().eq("notes", CSP_FIXTURE_TAG);

    const { data: dirs } = await svc.storage.from("media").list(CSP_FIXTURE_MEDIA_DIR);
    const stale = (dirs ?? []).map((d) => `${CSP_FIXTURE_MEDIA_DIR}/${d.name}/thumb.png`);
    if (stale.length) await svc.storage.from("media").remove(stale);
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
    let href = await findViewingHref(page);
    if (!href) {
      // A clean seed database has no viewings in this org. This used to skip,
      // which meant a green run was NOT evidence for this route — and it skipped
      // in CI on the run that ENFORCED the policy. Seed instead, same trade the
      // property and contact detail routes above already make.
      test.skip(!isLocal(), "no viewing and seeding needs the local service key");
      href = await seedViewing(serviceClient());
    }

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
    //
    // This used to SKIP on a seed database, because `property_media` is empty
    // there — so the one directive that exists for Storage was the one the
    // suite never checked, and it skipped silently in CI on 2026-08-10 while
    // the policy was being ENFORCED. It now seeds its own cover image, the
    // same trade the detail routes above already make.
    await collectViolations(page);
    const storageHits: string[] = [];
    page.on("response", (r) => {
      if (/\/storage\/v1\/object\/public\//.test(r.url())) storageHits.push(r.url());
    });

    await page.goto("/properties", { waitUntil: "networkidle" });
    await page.waitForTimeout(700);

    if (storageHits.length === 0) {
      test.skip(
        !isLocal(),
        "no property media and seeding needs the local service key",
      );
      await seedPropertyWithCover(serviceClient());
      await page.goto("/properties", { waitUntil: "networkidle" });
      await page.waitForTimeout(700);
    }

    // The point of the test. A clean violations list means nothing if the
    // browser never asked Storage for anything.
    expect(
      storageHits.length,
      "no request reached Supabase Storage — img-src was never exercised",
    ).toBeGreaterThan(0);

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
    let href = await findViewingHref(page);
    if (!href) {
      test.skip(!isLocal(), "no viewing and seeding needs the local service key");
      href = await seedViewing(serviceClient());
    }

    await page.goto(`${href}/sign`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);

    // The canvas is the point: without it this route is an ordinary form and
    // proves nothing about img-src/worker-src. A seeded viewing is `scheduled`
    // with no slip, so the pad renders rather than a signed receipt.
    await expect(page.locator("canvas")).toBeVisible();

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
      test(`${path} carries the ENFORCED policy`, async ({ page }) => {
        const response = await page.goto(path, { waitUntil: "domcontentloaded" });
        expect(response?.status(), `${path} must be reachable anonymously`).toBe(200);

        const policy = response?.headers()["content-security-policy"];
        expect(policy, `${path} is served with no CSP`).toBeTruthy();
        expect(policy).toContain("script-src");
        expect(policy).toContain("object-src 'none'");

        // The public branch of proxy.ts sets the header separately from the
        // authenticated one, which is exactly how they drifted apart before.
        // Assert the nonce here too: it is what proves this is the policy
        // proxy.ts built rather than something else wearing the same name.
        expect(policy, `${path}: enforcing CSP carries no nonce`).toMatch(/'nonce-[a-f0-9]+'/);
        expect(
          response?.headers()["content-security-policy-report-only"],
          `${path} must not be served BOTH policies`,
        ).toBeUndefined();

        // Clickjacking is enforced twice on the public routes too.
        expect(response?.headers()["x-frame-options"]).toBe("DENY");
        expect(policy).toContain("frame-ancestors 'none'");
      });
    }
  });
});
