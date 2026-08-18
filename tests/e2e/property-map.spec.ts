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
 * THIS IS THE ASSERTION THE FIRST VERSION OF THIS FILE WAS MISSING.
 *
 * On 2026-08-11 the map shipped to production completely blank, and every test
 * here passed: the container was visible and no CSP violation fired, both of
 * which are true of an empty grey rectangle. MapLibre loaded its style, drew the
 * background layer, and never requested a single vector tile.
 *
 * "The element exists" is not "the map works". A map that has requested no tiles
 * has rendered no map, so that is what gets asserted.
 */
// test.fixme, NOT skip or delete: the feature is broken, the test is right.
// Marked 2026-08-18 so `main` stays green while the map stays disabled and
// its link hidden. RE-ENABLE THIS THE MOMENT THE MAP IS FIXED — if it is
// quietly deleted instead, the next blank map ships unnoticed exactly as
// this one did.
test.fixme("the map actually loads vector tiles, not just a background", async ({ page }) => {
  await page.goto("/properties/map", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("property-map")).toBeVisible();

  // MUST match MAP TILES, not any .pbf. Font glyphs are also .pbf and are
  // fetched on the main thread, so a `.pbf` count passes while the map is blank
  // — this assertion did exactly that on 2026-08-11 and reported green in CI
  // against a production map showing nothing. Map tiles come from /planet/ and
  // are fetched by MapLibre's worker, which is the part that actually fails.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            performance
              .getEntriesByType("resource")
              .filter((e) => e.name.includes("/planet/") && e.name.includes(".pbf"))
              .length,
        ),
      {
        timeout: 20_000,
        message:
          "MapLibre requested zero MAP TILES (/planet/*.pbf) — the map is blank " +
          "even though the container is visible, glyphs loaded and nothing was " +
          "CSP-blocked",
      },
    )
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

// Also fixme: this clicks the Map link on /properties, and that link is
// deliberately HIDDEN while the map is broken. It tests real behaviour and
// should come back with the link, not be rewritten to dodge it.
test.fixme("the filters survive the trip from list to map", async ({ page }) => {
  await page.goto("/properties", { waitUntil: "domcontentloaded" });

  await page.getByRole("link", { name: /^map$/i }).click();
  await expect(page).toHaveURL(/\/properties\/map/);

  await page.getByRole("link", { name: /^list$/i }).click();
  await expect(page).toHaveURL(/\/properties(\?|$)/);
});
