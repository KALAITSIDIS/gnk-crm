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
 */

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
  await page.goto("/properties", { waitUntil: "domcontentloaded" });

  await page.getByRole("link", { name: /^map$/i }).click();
  await expect(page).toHaveURL(/\/properties\/map/);

  await page.getByRole("link", { name: /^list$/i }).click();
  await expect(page).toHaveURL(/\/properties(\?|$)/);
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
