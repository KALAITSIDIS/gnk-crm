import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type BrowserContext, type Page, type Response } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { clearFactors, enrolAndVerify } from "@/lib/testing/mfa";
import {
  fixtureProfile,
  isLocal,
  login,
  opTimeout,
  serviceClient,
  LOCAL_ANON_KEY,
  LOCAL_SUPABASE_URL,
} from "./helpers";

/**
 * The service worker keeps nothing a session or a share link can see
 * (DECISIONS T-sw-no-private-cache, 2026-10-05).
 *
 * Until then the worker stored every page a user loaded in `gnk-pages-v1` and
 * replayed it whenever the network failed — after the session had ended, to
 * the next account on the device, and for a proposal whose link had been
 * withdrawn. This spec drives the REAL worker in Chromium and reads Cache
 * Storage itself; the source of public/sw.js is never inspected. Its simulated
 * twin is tests/unit/service-worker.test.ts.
 *
 * What it is NOT about: the HTTP cache (one control below: private pages are
 * served no-store, and with no worker an offline navigation to one fails), the
 * back-forward cache, or a page still open in a tab. Those are separate kinds
 * of persistence, and nothing here claims them.
 *
 * Needs a PRODUCTION server: the worker registers only in a production build
 * (components/features/shared/pwa.tsx). CI serves `next start`, so it runs
 * there; against `next dev` locally it skips. Locally:
 *   SENTRY_AUTH_TOKEN= npx next build && SENTRY_AUTH_TOKEN= RESEND_API_KEY= npx next start -p 3217
 *   E2E_BASE_URL=http://localhost:3217 npx playwright test --project=setup --project=desktop pwa-offline-privacy
 *
 * Traps measured while writing it (Playwright 1.61, Chromium):
 *  - `navigator.serviceWorker.ready` and `controllerchange` fire while the new
 *    worker is still ACTIVATING — before its activate handler (the cleanup)
 *    has run. Wait for state "activated" by polling, as below.
 *  - `page.waitForFunction(async …)` does not await the predicate; it resolves
 *    at once. Hence `expect.poll`.
 *  - `context.setOffline` alone does not reach a worker version installed
 *    after the call; a route abort alone does not reach a restarted worker.
 *    Offline is both, and every offline check starts with a never-visited
 *    canary URL that must get the generic page.
 *  - A worker's update check cannot be intercepted by a route, so the v1
 *    worker is installed under another script URL (/sw-legacy.js) and the
 *    app's own /sw.js is held back until the upgrade.
 */

// Playwright runs from the repo root (as server-health.ts's readBuildId assumes).
const LEGACY_WORKER = readFileSync(path.join(process.cwd(), "tests/fixtures/sw-legacy-v1.js"), "utf8");
const CURRENT_CACHES = ["gnk-shell-v2", "gnk-static-v2"];
const OFFLINE_HEADING = { name: "You are offline" } as const;

const sha = (token: string) => createHash("sha256").update(token).digest("hex");

/** The worker only exists in a production build; `next dev`'s CSP is the tell (lib/services/csp.ts). */
async function servesProductionBuild(page: Page): Promise<boolean> {
  const res = await page.request.get("/login");
  return !(res.headers()["content-security-policy"] ?? "").includes("'unsafe-eval'");
}

/** An ACTIVATED worker at `scriptPath` controls the page — its activate handler has finished. */
async function waitForActivatedWorker(page: Page, scriptPath = "/sw.js") {
  await expect
    .poll(
      () =>
        page.evaluate(async (script) => {
          const registration = await navigator.serviceWorker.getRegistration();
          const controller = navigator.serviceWorker.controller;
          return (
            !!registration &&
            !!controller &&
            controller === registration.active &&
            controller.state === "activated" &&
            !registration.installing &&
            !registration.waiting &&
            new URL(controller.scriptURL).pathname === script
          );
        }, scriptPath),
      { timeout: opTimeout(30_000), intervals: [100] },
    )
    .toBe(true);
}

async function goOffline(context: BrowserContext) {
  await context.setOffline(true);
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
}

async function goOnline(context: BrowserContext) {
  await context.unroute("**/*");
  await context.setOffline(false);
}

type Entry = { cache: string; url: string; body: string };

/** Every entry in this origin's Cache Storage, with its body — what someone holding the phone could read. */
async function cacheStorage(page: Page): Promise<Entry[]> {
  return page.evaluate(async () => {
    const out: { cache: string; url: string; body: string }[] = [];
    for (const name of await caches.keys()) {
      if (!(await caches.has(name))) continue; // open() would re-create a cache deleted meanwhile
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const url = new URL(request.url);
        out.push({ cache: name, url: url.pathname + url.search, body: response ? await response.text() : "" });
      }
    }
    return out;
  });
}

/**
 * None of `secrets` anywhere in Cache Storage, only allowlisted entries, only
 * this version's caches — in that order, and listing every violation, so a
 * failure names what leaked rather than the first cache it tripped over.
 */
async function expectNothingPrivateStored(page: Page, secrets: string[]) {
  const stored = await cacheStorage(page);
  const leaks = stored.flatMap((entry) =>
    secrets.filter((secret) => entry.body.includes(secret)).map((secret) => `${entry.cache} ${entry.url} holds "${secret}"`),
  );
  expect(leaks, "private content in Cache Storage").toEqual([]);
  const outside = stored
    .filter((entry) => entry.url !== "/offline" && !entry.url.startsWith("/_next/static/"))
    .map((entry) => `${entry.cache} ${entry.url}`);
  expect(outside, "entries outside the allowlist").toEqual([]);
  const foreign = [...new Set(stored.map((entry) => entry.cache))].filter((name) => !CURRENT_CACHES.includes(name));
  expect(foreign, "caches the current worker does not own").toEqual([]);
  return stored;
}

/** A full page load answered by the generic offline page, and nothing of `secrets`. */
async function expectGenericOfflinePage(page: Page, target: string, secrets: string[]) {
  const res = await page.goto(target);
  expect(res?.fromServiceWorker(), `${target} was not answered by the worker`).toBe(true);
  await expect(page.getByRole("heading", OFFLINE_HEADING)).toBeVisible();
  const html = await page.content();
  for (const secret of secrets) expect(html, `${target} offline shows "${secret}"`).not.toContain(secret);
}

/** Offline, and proven offline: a URL never visited must get the generic page, not live HTML. */
async function goOfflineWithCanary(context: BrowserContext, page: Page) {
  await goOffline(context);
  await expectGenericOfflinePage(page, `/sw-canary-${randomBytes(4).toString("hex")}`, []);
}

/** A plain link to an export, as reports/performance renders them: a navigation that becomes a download. */
async function downloadViaPlainLink(page: Page, href: string) {
  const download = page.waitForEvent("download");
  await page.evaluate((target) => {
    const a = document.createElement("a");
    a.href = target;
    document.body.append(a);
    a.click();
  }, href);
  return download;
}

interface Fixture {
  tag: string;
  contactId: string;
  contactName: string;
  propertyId: string;
  links: { id: string; token: string; title: string }[];
}

async function seed(svc: SupabaseClient): Promise<Fixture> {
  const { id: adminId, orgId } = await fixtureProfile(svc);
  const tag = randomBytes(4).toString("hex").toUpperCase();

  const { data: contact, error: contactErr } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: "SWPRIV", last_name: `Client-${tag}` })
    .select("id, display_name")
    .single();
  expect(contactErr).toBeNull();

  const { data: property, error: propertyErr } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `SWPRIV-${tag}`,
      property_type: "villa",
      visibility: "private",
      status: "available",
      title: { en: `SWPRIV villa ${tag}` },
      asking_price: 123456,
    })
    .select("id")
    .single();
  expect(propertyErr).toBeNull();

  const links: Fixture["links"] = [];
  for (const purpose of ["agent", "buyer"]) {
    const token = randomBytes(32).toString("base64url");
    const title = `SWPRIV proposal ${purpose} ${tag}`;
    const { data: link, error: linkErr } = await svc
      .from("share_links")
      .insert({
        org_id: orgId,
        token_sha256: sha(token),
        locale: "en",
        title,
        contact_id: contact!.id,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        created_by: adminId,
      })
      .select("id")
      .single();
    expect(linkErr).toBeNull();
    const { error: slpErr } = await svc
      .from("share_link_properties")
      .insert({ share_link_id: link!.id, property_id: property!.id, sort_order: 0 });
    expect(slpErr).toBeNull();
    links.push({ id: link!.id, token, title });
  }

  return {
    tag,
    contactId: contact!.id,
    contactName: contact!.display_name as string,
    propertyId: property!.id,
    links,
  };
}

/** Fixtures go; their events stay — the chain is append-only. */
async function unseed(svc: SupabaseClient, fx: Fixture | undefined) {
  if (!fx) return;
  for (const link of fx.links) await svc.from("share_links").delete().eq("id", link.id);
  await svc.from("properties").delete().eq("id", fx.propertyId);
  await svc.from("contacts").delete().eq("id", fx.contactId);
}

/** A throwaway signed-in account with its own factor — never the seed admin, whose session the run shares. */
async function dedicatedUser(svc: SupabaseClient, orgId: string, label: string) {
  const email = `sw-privacy-${label}-${randomBytes(4).toString("hex")}@gnk.local`;
  const password = `sw-privacy-${randomBytes(8).toString("hex")}`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
  expect(error).toBeNull();
  const id = created!.user!.id;
  const { error: profileErr } = await svc
    .from("profiles")
    .insert({ id, org_id: orgId, role: "agent", full_name: `SW Privacy ${label}`, email });
  expect(profileErr).toBeNull();
  await clearFactors(svc, id);
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_ANON_KEY, { auth: { persistSession: false } });
  expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
  const factor = await enrolAndVerify(client);
  return { id, email, password, secret: factor.secret };
}

async function removeUser(svc: SupabaseClient, id: string | undefined) {
  if (!id) return;
  await svc.from("profiles").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id);
}

test.describe("Offline privacy — the service worker keeps nothing private", () => {
  const svc = serviceClient();
  let fx: Fixture;

  test.beforeAll(async () => {
    if (!isLocal()) return;
    fx = await seed(svc);
  });
  test.afterAll(async () => unseed(svc, fx));

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isLocal(), "seeds through the local stack's service key — never a deployed target");
    test.skip(testInfo.project.name === "mobile", "the desktop project covers the worker");
    // In CI this never skips: CI serves `next start`, and a worker that fails
    // to register there must fail the run, not skip it.
    test.skip(
      !process.env.CI && !(await servesProductionBuild(page)),
      "the service worker registers only in a production build (next build + next start)",
    );
  });

  test("a fresh install serves a signed-in user's pages live, stores none of them, and offline shows only the generic page", async ({
    page,
    context,
  }) => {
    const secrets = [fx.contactName, fx.links[0].title, "admin@gnk.local"];
    await page.goto("/dashboard");
    await waitForActivatedWorker(page);

    const contact = await page.goto(`/contacts/${fx.contactId}`);
    expect(contact?.fromServiceWorker(), "the worker is in the path of a page load").toBe(true);
    await expect(page.getByRole("heading", { name: fx.contactName })).toBeVisible();
    await page.goto(`/p/${fx.links[0].token}`);
    await expect(page.getByRole("heading", { name: fx.links[0].title })).toBeVisible();
    await page.goto(`/contacts?q=${encodeURIComponent(fx.contactName)}`);
    await page.goto("/dashboard");
    const csv = await downloadViaPlainLink(page, "/contacts/export");
    expect(await csv.failure()).toBeNull();

    const stored = await expectNothingPrivateStored(page, secrets);
    // Positive controls: the allowlist is in use, not merely empty.
    expect(stored.some((e) => e.cache === "gnk-static-v2" && e.url.startsWith("/_next/static/"))).toBe(true);
    const offlinePage = stored.find((e) => e.cache === "gnk-shell-v2" && e.url === "/offline");
    expect(offlinePage?.body).toContain("You are offline");

    try {
      await goOfflineWithCanary(context, page);
      await expectGenericOfflinePage(page, `/contacts/${fx.contactId}`, secrets);
      await expectGenericOfflinePage(page, `/p/${fx.links[0].token}`, secrets);
      await expectGenericOfflinePage(page, `/contacts?q=${encodeURIComponent(fx.contactName)}`, secrets);

      // Not a navigation: an RSC payload or an API call fails as a network
      // error — the generic HTML is for page loads only.
      const outcomes = await page.evaluate(async (contactPath) => {
        const attempt = (url: string, init?: RequestInit) =>
          fetch(url, init).then(
            async (r) => `answered ${r.status} ${(await r.text()).slice(0, 40)}`,
            (e: unknown) => `network error: ${String(e)}`,
          );
        return [
          await attempt(`${contactPath}?_rsc=sw`, { headers: { RSC: "1" } }),
          await attempt("/api/public/listings"),
        ];
      }, `/contacts/${fx.contactId}`);
      for (const outcome of outcomes) expect(outcome).toMatch(/^network error/);
    } finally {
      await goOnline(context);
    }
  });

  test("upgrading from the v1 worker in the same browser context removes everything it stored", async ({
    page,
    context,
  }) => {
    const secrets = [fx.contactName, fx.links[0].title];
    // v1 under another script URL; the app's own /sw.js held back until the upgrade.
    await context.route("**/sw-legacy.js", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: LEGACY_WORKER }),
    );
    await context.route("**/sw.js", (route) => route.abort());
    await page.goto("/dashboard");
    await page.evaluate(() => navigator.serviceWorker.register("/sw-legacy.js", { scope: "/" }).then(() => undefined));
    await waitForActivatedWorker(page, "/sw-legacy.js");

    await page.goto(`/contacts/${fx.contactId}`);
    await page.goto(`/p/${fx.links[0].token}`);
    await page.goto("/dashboard");
    await downloadViaPlainLink(page, "/contacts/export");

    // Positive control — the audit's finding, reproduced in this browser: v1
    // stores the private pages (and the export) and replays them offline.
    await expect
      .poll(async () => (await cacheStorage(page)).filter((e) => e.cache === "gnk-pages-v1").map((e) => e.url))
      .toEqual(expect.arrayContaining([`/contacts/${fx.contactId}`, `/p/${fx.links[0].token}`, "/contacts/export"]));
    const v1 = await cacheStorage(page);
    expect(v1.find((e) => e.url === `/contacts/${fx.contactId}`)?.body).toContain(fx.contactName);
    expect(v1.find((e) => e.url === "/contacts/export")?.body).toContain(fx.contactName);
    try {
      await goOffline(context);
      await page.goto(`/contacts/${fx.contactId}`);
      await expect(page.getByRole("heading", { name: fx.contactName })).toBeVisible();
    } finally {
      await goOnline(context);
    }

    // The deploy reaches this device: the next page load registers /sw.js over v1.
    await context.unroute("**/sw.js");
    await page.goto("/dashboard");
    await waitForActivatedWorker(page, "/sw.js");

    // Read before any further navigation: activation itself must have cleaned up.
    const after = await expectNothingPrivateStored(page, secrets);
    expect(after.map((e) => e.cache)).not.toContain("gnk-pages-v1");

    try {
      await goOfflineWithCanary(context, page);
      await expectGenericOfflinePage(page, `/contacts/${fx.contactId}`, secrets);
      await expectGenericOfflinePage(page, `/p/${fx.links[0].token}`, secrets);
    } finally {
      await goOnline(context);
    }
    await expectNothingPrivateStored(page, secrets);
  });

  test.describe("a buyer's device", () => {
    test.use({
      storageState: { cookies: [], origins: [] },
      // Its own share-link miss budget (0081): a shared one blanks every /p/ page once spent.
      extraHTTPHeaders: { "x-forwarded-for": `2001:db8:${randomBytes(2).toString("hex")}::1` },
    });

    test("a withdrawn proposal shows the neutral page online and the generic page offline — never the proposal", async ({
      page,
      context,
    }) => {
      const buyerLink = fx.links[1];
      await page.goto(`/p/${buyerLink.token}`);
      await waitForActivatedWorker(page);
      await page.goto(`/p/${buyerLink.token}`); // a controlled load — the one v1 stored
      await expect(page.getByRole("heading", { name: buyerLink.title })).toBeVisible();
      await expectNothingPrivateStored(page, [buyerLink.title]);

      // No session: a CRM page answers with the gate's redirect, live.
      await page.goto(`/contacts/${fx.contactId}`);
      await expect(page).toHaveURL(/\/login/);

      await svc.from("share_links").update({ revoked_at: new Date().toISOString() }).eq("id", buyerLink.id);
      await page.goto(`/p/${buyerLink.token}`);
      await expect(page.getByRole("heading", { name: "This link is no longer available" })).toBeVisible();
      expect(await page.content()).not.toContain(buyerLink.title);

      try {
        await goOfflineWithCanary(context, page);
        await expectGenericOfflinePage(page, `/p/${buyerLink.token}`, [buyerLink.title]);
      } finally {
        await goOnline(context);
      }
    });
  });

  test.describe("one device, several sessions", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("session expiry, a second account and sign-out leave nothing of the first account readable offline", async ({
      page,
      context,
    }) => {
      const { orgId } = await fixtureProfile(svc);
      let first: Awaited<ReturnType<typeof dedicatedUser>> | undefined;
      let second: Awaited<ReturnType<typeof dedicatedUser>> | undefined;
      try {
        first = await dedicatedUser(svc, orgId, "first");
        second = await dedicatedUser(svc, orgId, "second");
        const secrets = [fx.contactName, first.email];

        await login(page, first.email, first.password, first.secret);
        await waitForActivatedWorker(page);
        await page.goto(`/contacts/${fx.contactId}`);
        await expect(page.getByRole("heading", { name: fx.contactName })).toBeVisible();
        await expectNothingPrivateStored(page, secrets);

        // The session ends without anyone signing out (expiry, a ban, a global sign-out elsewhere).
        await context.clearCookies();
        await page.goto(`/contacts/${fx.contactId}`);
        await expect(page).toHaveURL(/\/login/);
        try {
          await goOfflineWithCanary(context, page);
          await expectGenericOfflinePage(page, `/contacts/${fx.contactId}`, secrets);
        } finally {
          await goOnline(context);
        }

        // The next person signs in on the same device.
        await login(page, second.email, second.password, second.secret);
        await expectNothingPrivateStored(page, secrets);
        try {
          await goOfflineWithCanary(context, page);
          await expectGenericOfflinePage(page, `/contacts/${fx.contactId}`, secrets);
        } finally {
          await goOnline(context);
        }

        // And signs out with the header button. Sign-out is a client-side
        // navigation — no page load follows — so the purge must leave the
        // anonymous offline page in place (v1's purge lost it for good).
        await page.goto("/dashboard");
        await page.getByRole("button", { name: "Log out" }).click();
        await page.waitForURL(/\/login/, { timeout: opTimeout(30_000) });
        const afterSignOut = await expectNothingPrivateStored(page, [...secrets, second.email]);
        expect(afterSignOut.map((e) => `${e.cache} ${e.url}`)).toContain("gnk-shell-v2 /offline");
        try {
          await goOfflineWithCanary(context, page);
          await expectGenericOfflinePage(page, `/contacts/${fx.contactId}`, [...secrets, second.email]);
        } finally {
          await goOnline(context);
        }
      } finally {
        await removeUser(svc, first?.id);
        await removeUser(svc, second?.id);
      }
    });
  });

  test.describe("control: no worker at all", () => {
    test.use({ serviceWorkers: "block" });

    test("with no worker, the HTTP cache does not replay a private page either — it is served no-store", async ({
      page,
      context,
    }) => {
      const live = await page.goto(`/contacts/${fx.contactId}`);
      await expect(page.getByRole("heading", { name: fx.contactName })).toBeVisible();
      expect(live?.headers()["cache-control"] ?? "").toContain("no-store");
      // Leave the page, then come back to it offline by an ordinary navigation —
      // not a reload, which revalidates and so would fail whatever the cache held.
      await page.goto("/login");
      let offlineLoad: Response | null | Error = null;
      try {
        await context.setOffline(true);
        offlineLoad = await page.goto(`/contacts/${fx.contactId}`).catch((e: Error) => e);
      } finally {
        await context.setOffline(false);
      }
      expect(offlineLoad, "with no worker, an offline navigation must fail, not replay the page").toBeInstanceOf(Error);
    });
  });
});
