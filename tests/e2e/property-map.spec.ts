import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { serviceClient } from "./helpers";

/**
 * The property map (IMPROVEMENTS B5).
 *
 * THE CSP ASSERTION IS THE POINT OF THIS FILE. The policy has been ENFORCED
 * since 2026-08-10, so a missing tile origin does not warn — it renders a blank
 * map in production with nothing in the UI to explain it, and
 * `npm run check:csp-nonce` cannot catch it because it only measures nonces.
 *
 * The empty-state assertion is the second half of the same problem: a map with
 * no pins looks identical whether the resolver is broken or the data is
 * genuinely absent, so the two are asserted separately and explicitly.
 *
 * F08 — WHEN THE MAP CANNOT DRAW. A browser without WebGL2, a style that will
 * not load and a basemap whose tiles never come used to look exactly like this
 * file's original fear: an empty box. The last four tests make each one happen
 * on purpose and assert what the page says instead. WebGL is taken away by
 * stubbing `HTMLCanvasElement.prototype.getContext` in an init script, NOT with
 * GPU launch flags: deterministic, and playwright.config.ts records why
 * GPU-disabling flags were added and reverted. That proves OUR handling, not a
 * real GPU-less Chrome — for that, launch Chrome once by hand with
 * `--disable-3d-apis`.
 */

type Seeded = { id: string; reference: string };

/** One fixture listing in the admin's organisation, placed by the Paphos
 *  district centre unless the overrides say otherwise. Delete it in `finally`. */
async function seedProperty(prefix: string, overrides: Record<string, unknown> = {}): Promise<Seeded> {
  const admin = serviceClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, org_id")
    .eq("email", "admin@gnk.local")
    .single();
  const { data: district } = await admin
    .from("districts")
    .select("id")
    .eq("org_id", profile!.org_id)
    .eq("code", "PAF")
    .single();
  const reference = `${prefix}-${randomBytes(3).toString("hex")}`;
  const { data, error } = await admin
    .from("properties")
    .insert({
      org_id: profile!.org_id,
      reference,
      property_type: "villa",
      visibility: "public",
      status: "available",
      district_id: district!.id,
      asking_price: 450000,
      title: { en: "E2E map fallback villa" },
      ...overrides,
    })
    .select("id")
    .single();
  expect(error, `seed failed: ${error?.message}`).toBeNull();
  return { id: data!.id as string, reference };
}

async function deleteProperties(...seeded: Seeded[]) {
  await serviceClient()
    .from("properties")
    .delete()
    .in("id", seeded.map((s) => s.id));
}

/** Uncaught exceptions AND unhandled rejections — the latter is how a missing
 *  WebGL2 context used to surface, and the only place it surfaced. */
function collectPageErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));
  return errors;
}

/** Collect `securitypolicyviolation` events — more reliable than console text,
 *  matching the pattern already used in tests/e2e/csp.spec.ts. */
async function collectCspViolations(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} blocked ${e.blockedURI}`,
      );
    });
  });
}

/**
 * THE TILE ASSERTION — AND THE INSTRUMENT IT HAS TO USE.
 *
 * This test has now been wrong twice, in opposite directions, and both times the
 * instrument was the problem rather than the map.
 *
 *  1. It counted ANY `.pbf`. Font glyphs are `.pbf`, so it passed on the strength
 *     of 11 glyph requests and would have passed with the map completely blank.
 *  2. It was "fixed" to count `/planet/*.pbf` from
 *     `performance.getEntriesByType("resource")` INSIDE THE PAGE. That can never
 *     pass: vector tiles are fetched by MapLibre's WORKER, and a worker's fetches
 *     never appear in the WINDOW's resource timeline. It then failed CI against a
 *     perfectly working map, and the Map link was hidden from users because of it.
 *
 * Measured on 2026-08-20 against a working map, same page, same moment:
 *     network level (page.on("request")):        9 tiles
 *     window performance timeline:               0 tiles
 *     any .pbf in the window timeline (glyphs):  11
 *
 * So the tiles MUST be counted at the network level, where Playwright sees worker
 * requests too. Do not move this back into page.evaluate().
 *
 * (The map also renders nothing at all when the tab is HIDDEN — MapLibre requests
 * tiles from inside its rAF render loop, and `requestAnimationFrame` does not run
 * in a background tab. Every "blank map" observation that started this was taken
 * through automation on a hidden tab, which cannot render any map, working or not.
 * Playwright pages report `visibilityState: "visible"`, headless included, so this
 * test is fine — but a manual check through a background tab proves nothing.)
 */
test("the map actually loads vector tiles, not just a background", async ({ page }) => {
  // Registered BEFORE goto so no request is missed.
  const tiles: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/planet/") && u.includes(".pbf")) tiles.push(u);
  });

  await page.goto("/properties/map", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("property-map")).toBeVisible();

  await expect
    .poll(() => tiles.length, {
      timeout: 20_000,
      message:
        "MapLibre requested zero MAP TILES (/planet/*.pbf) at the network level — " +
        "the map is blank even though the container is visible",
    })
    .toBeGreaterThan(0);

  // F08: a working map never shows the fallback or the slow notice, and its
  // own state says it drew — the instrument the slow-map watchdog relies on
  const map = page.getByTestId("property-map");
  await expect(map).toHaveAttribute("data-status", "ready");
  await expect(map).toHaveAttribute("data-pins", "drawn", { timeout: 20_000 });
  await expect(page.getByTestId("property-map-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("property-map-slow")).toHaveCount(0);
});

test("the map renders and provokes no CSP violation", async ({ page }) => {
  await collectCspViolations(page);

  // NOT `networkidle`: MapLibre streams vector tiles continuously, so the page
  // may never go 500ms quiet and the wait times out having proved nothing.
  await page.goto("/properties/map", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("property-map")).toBeVisible();

  // Give the map long enough to actually REQUEST tiles — a CSP check that runs
  // before any request to the tile origin would pass vacuously.
  await page.waitForTimeout(3_000);

  const violations = await page.evaluate(
    () => (window as unknown as { __csp: string[] }).__csp,
  );

  // If this fails, the reported directive names the missing origin. Fix
  // lib/services/csp.ts — do NOT weaken this assertion.
  expect(violations, `CSP blocked: ${violations.join(" | ")}`).toEqual([]);
});

test("a property with a district resolves to a pin rather than the empty state", async ({
  page,
}) => {
  // SEEDS ITS OWN FIXTURE, deliberately. An earlier version asserted against
  // whatever happened to be in the database and passed or failed depending on
  // residue — the same trap RLS test 24 documents. The database is legitimately
  // empty most of the time, and "no pins" is then CORRECT, so the only way this
  // test means anything is to create the row it is asserting about.
  const admin = serviceClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, org_id")
    .eq("email", "admin@gnk.local")
    .single();

  const { data: district } = await admin
    .from("districts")
    .select("id")
    .eq("org_id", profile!.org_id)
    .eq("code", "PAF")
    .single();

  const reference = `E2E-MAP-${randomBytes(3).toString("hex")}`;
  const { data: property, error } = await admin
    .from("properties")
    .insert({
      org_id: profile!.org_id,
      reference,
      property_type: "villa",
      visibility: "public",
      status: "available",
      district_id: district!.id,
      title: { en: "E2E map villa" },
      // NO location on purpose: this fixture exists to exercise the
      // district-centroid FALLBACK, which is the path every real property
      // takes today because nobody enters coordinates by hand.
    })
    .select("id")
    .single();
  expect(error, `seed failed: ${error?.message}`).toBeNull();

  try {
    await page.goto("/properties/map", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("property-map")).toBeVisible();

    // If the empty state shows, the fallback produced no feature — which is
    // exactly how this feature would ship useless while every unit test passed.
    await expect(page.getByTestId("property-map-empty")).toHaveCount(0);
  } finally {
    await admin.from("properties").delete().eq("id", property!.id);
  }
});

test("the filters survive the trip from list to map", async ({ page }) => {
  // A REAL filter set (A03): with none, this could not fail on a lost filter.
  // The map ignores the sort and the view but carries them back to the list.
  const filters = { type: "villa", transaction: "sale", plot_min: "100", sort: "price_desc", view: "table" };
  await page.goto(`/properties?${new URLSearchParams(filters)}`, { waitUntil: "domcontentloaded" });

  await page.getByRole("link", { name: /^map$/i }).click();
  await expect(page).toHaveURL(/\/properties\/map/);
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(filters);
  // the map names the filters it applies (not the sort: it has no order)
  await expect(page.getByTestId("properties-view-description")).toHaveText("Villa · For sale · plot ≥ 100 m²");
  await expect(page).toHaveTitle("Properties map · Villa · For sale · plot ≥ 100 m²");
  // and the tab remembers the map as the last list view
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("gnk:properties:last")))
    .toBe(`/properties/map?${new URLSearchParams(filters)}`);

  await page.getByRole("link", { name: /^list$/i }).click();
  await expect(page).toHaveURL(/\/properties(\?|$)/);
  expect(new URL(page.url()).pathname).toBe("/properties");
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(filters);
});

test("clicking a pin opens a popup that leads to the property", async ({ page }) => {
  // Seeds and FILTERS TO one property on purpose. With a single feature the map
  // fitBounds() onto a degenerate box, so the pin lands dead centre of the
  // canvas and the click below is deterministic rather than a guess at pixels.
  const admin = serviceClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, org_id")
    .eq("email", "admin@gnk.local")
    .single();

  const { data: district } = await admin
    .from("districts")
    .select("id")
    .eq("org_id", profile!.org_id)
    .eq("code", "PAF")
    .single();

  const reference = `E2E-PIN-${randomBytes(3).toString("hex")}`;
  const { data: property, error } = await admin
    .from("properties")
    .insert({
      org_id: profile!.org_id,
      reference,
      property_type: "villa",
      visibility: "public",
      status: "available",
      district_id: district!.id,
      asking_price: 450000,
      title: { en: "E2E pin villa" },
    })
    .select("id")
    .single();
  expect(error, `seed failed: ${error?.message}`).toBeNull();

  try {
    await page.goto(`/properties/map?q=${reference}`, { waitUntil: "domcontentloaded" });
    const canvas = page.getByTestId("property-map");
    await expect(canvas).toBeVisible();

    // Let the style load and fitBounds settle before aiming at the centre.
    await page.waitForTimeout(6_000);
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    const popup = page.locator(".maplibregl-popup");
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toContainText(reference);

    // The whole point of the popup: it has to actually get you to the property.
    await popup.getByRole("button", { name: new RegExp(reference) }).click();
    await expect(page).toHaveURL(new RegExp(`/properties/${property!.id}`));
  } finally {
    await admin.from("properties").delete().eq("id", property!.id);
  }
});

test("without WebGL the map says so and lists the properties", async ({ page }) => {
  // what "take the area centre" saves (0054): a stored point that is NOT surveyed
  const approx = await seedProperty("E2E-NOGL", {
    location: "SRID=4326;POINT(32.39 34.82)",
    location_approx: true,
  });
  const exact = await seedProperty("E2E-NOGL", { location: "SRID=4326;POINT(32.4012 34.7511)" });
  const pageErrors = collectPageErrors(page);
  // No WebGL of any version: the shape of a remote desktop, a VM, or a browser
  // with hardware acceleration off. Every other context (2d) still works.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof original;
  });

  try {
    await page.goto(`/properties/map?q=${approx.reference}`, { waitUntil: "domcontentloaded" });

    const alert = page.getByTestId("property-map-unavailable");
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toHaveAttribute("data-reason", "unsupported");
    await expect(alert).toContainText(/WebGL2/);
    // no advice to weaken the browser
    await expect(alert).not.toContainText(/flag|disable|security/i);
    // no empty box, and no legend for pins that do not exist
    await expect(page.getByTestId("property-map")).toBeHidden();
    await expect(page.getByText("Exact location")).toHaveCount(0);

    // the properties it would have shown, each with the way to its record
    const list = page.getByTestId("property-map-list");
    await expect(list.getByRole("link", { name: approx.reference, exact: true })).toHaveAttribute(
      "href",
      `/properties/${approx.id}`,
    );
    await expect(list.getByRole("listitem").filter({ hasText: approx.reference })).toContainText(
      "Approximate — area/district centre",
    );

    // and to its point, without the CRM URL travelling as the Referer
    // the whole name is on the anchor: an sr-only span inside it came out as
    // "Open in Google Maps : REF" and matched nothing (F08 review)
    const maps = list.getByRole("link", {
      name: `Open in Google Maps: ${approx.reference} (opens in a new tab)`,
      exact: true,
    });
    await expect(maps).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=34.820000%2C32.390000");
    await expect(maps).toHaveAttribute("target", "_blank");
    await expect(maps).toHaveAttribute("rel", /\bnoopener\b/);
    await expect(maps).toHaveAttribute("rel", /\bnoreferrer\b/);

    // the list under the SAME filters — and it works
    const asList = alert.getByRole("link", { name: "Open as list" });
    await expect(asList).toHaveAttribute("href", `/properties?q=${approx.reference}`);
    await asList.click();
    await expect(page).toHaveURL(/\/properties\?/);
    expect(new URL(page.url()).pathname).toBe("/properties");
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ q: approx.reference });
    await expect(page.getByRole("link", { name: approx.reference }).first()).toBeVisible();

    // both fixtures through the same stub: only the stored centre says "Approximate"
    await page.goto("/properties/map?q=E2E-NOGL", { waitUntil: "domcontentloaded" });
    const rows = page.getByTestId("property-map-list").getByRole("listitem");
    await expect(rows.filter({ hasText: approx.reference })).toContainText("Approximate");
    await expect(rows.filter({ hasText: exact.reference })).toBeVisible();
    await expect(rows.filter({ hasText: exact.reference })).not.toContainText("Approximate");

    // it used to surface ONLY as an unhandled rejection
    expect(pageErrors, "no uncaught exception or unhandled rejection").toEqual([]);
  } finally {
    await deleteProperties(approx, exact);
  }
});

test("a base map that cannot load says so instead of staying blank", async ({ page }) => {
  const seeded = await seedProperty("E2E-NOSTYLE");
  const pageErrors = collectPageErrors(page);
  // OpenFreeMap unreachable — an outage, or a CSP that lost its origin
  await page.route("https://tiles.openfreemap.org/**", (route) => route.abort());

  try {
    await page.goto(`/properties/map?q=${seeded.reference}`, { waitUntil: "domcontentloaded" });
    const alert = page.getByTestId("property-map-unavailable");
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toHaveAttribute("data-reason", "failed");
    await expect(alert).toContainText(/couldn't load/);
    await expect(page.getByTestId("property-map")).toBeHidden();
    await expect(
      page.getByTestId("property-map-list").getByRole("link", { name: seeded.reference, exact: true }),
    ).toHaveAttribute("href", `/properties/${seeded.id}`);
    expect(pageErrors, "no uncaught exception or unhandled rejection").toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await deleteProperties(seeded);
  }
});

test("the pins draw even when the base map's tiles never arrive", async ({ page }) => {
  // The pins used to be added on `load`, which waits for EVERY basemap tile:
  // a tile outage hid the local pins too. The style and glyphs load here; the
  // vector tiles (and their TileJSON) never do.
  const seeded = await seedProperty("E2E-NOTILES");
  const blocked: string[] = [];
  await page.route(
    (url) => url.hostname === "tiles.openfreemap.org" && url.pathname.startsWith("/planet"),
    (route) => {
      blocked.push(route.request().url());
      return route.abort();
    },
  );

  try {
    await page.goto(`/properties/map?q=${seeded.reference}`, { waitUntil: "domcontentloaded" });
    const canvas = page.getByTestId("property-map");
    await expect(canvas).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await expect(canvas).toHaveAttribute("data-pins", "drawn", { timeout: 20_000 });
    await expect(page.getByTestId("property-map-unavailable")).toHaveCount(0);
    // the basemap really was cut off (its TileJSON, at least) — or this proves nothing
    expect(blocked.length, "no /planet request was blocked").toBeGreaterThan(0);

    // one feature → fitBounds onto a degenerate box → the pin is dead centre
    await page.waitForTimeout(1_000);
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const popup = page.locator(".maplibregl-popup");
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toContainText(seeded.reference);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await deleteProperties(seeded);
  }
});

test("a map that draws nothing says so after 15 s of VISIBLE time — and a hidden tab never does", async ({ page }) => {
  test.setTimeout(120_000);
  const seeded = await seedProperty("E2E-SLOW");
  // The tab reports itself hidden until the test says otherwise. A hidden tab
  // never runs requestAnimationFrame, so a working map draws nothing there —
  // a wall-clock watchdog would call it slow (BACKLOG, the withdrawn "blank
  // map" of 2026-08-20). This one counts visible time only.
  await page.addInitScript(() => {
    const w = window as unknown as { __e2eHidden: boolean };
    w.__e2eHidden = true;
    Object.defineProperty(Document.prototype, "visibilityState", {
      configurable: true,
      get: () => (w.__e2eHidden ? "hidden" : "visible"),
    });
  });
  // a style request that never answers: the silent stall — nothing errors
  await page.route("https://tiles.openfreemap.org/styles/**", () => {});

  try {
    await page.goto(`/properties/map?q=${seeded.reference}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("property-map")).toHaveAttribute("data-status", "loading");

    // well past the threshold, hidden: no notice
    await page.waitForTimeout(18_000);
    await expect(page.getByTestId("property-map-slow")).toHaveCount(0);
    await expect(page.getByTestId("property-map-unavailable")).toHaveCount(0);

    // visible: the notice comes, the map is NOT taken away, and the list is offered
    await page.evaluate(() => {
      (window as unknown as { __e2eHidden: boolean }).__e2eHidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const slow = page.getByTestId("property-map-slow");
    await expect(slow).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("property-map")).toBeVisible();
    await slow.getByRole("button", { name: "Show as a list" }).click();
    await expect(
      page.getByTestId("property-map-list").getByRole("link", { name: seeded.reference, exact: true }),
    ).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await deleteProperties(seeded);
  }
});
