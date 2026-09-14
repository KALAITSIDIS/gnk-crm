import { test, expect, request as pwRequest } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertNoHorizontalOverflow,
  assertNoProblems,
  baseUrl,
  fixtureProfile,
  isLocal,
  runTag,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * Enable a portal → select a listing → the feed carries it → remove → gone.
 * The whole loop the spec promises, through the two UI surfaces and the
 * public route, with the anonymous fetch a portal's crawler would make.
 * Runs in the desktop AND mobile projects; the two overflow assertions are
 * the only measurement these two routes get at phone width.
 */
test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seedPublicListing(svc: SupabaseClient, orgId: string, tag: string) {
  const { data: district } = await svc.from("districts").select("id").eq("org_id", orgId).eq("code", "PAF").single();
  const reference = `E2EPRT${tag}`.slice(0, 20).toUpperCase();
  const { data: prop, error } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference,
      property_type: "villa",
      transaction_type: "sale",
      status: "available",
      visibility: "public",
      published_at: new Date().toISOString(),
      district_id: district!.id,
      asking_price: 450000,
      currency: "EUR",
      bedrooms: 3,
      bathrooms: 2,
      covered_area_sqm: 180,
      title: { en: "E2E portal villa" },
      public_description: { en: "Portal e2e listing." },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const { error: mErr } = await svc.from("property_media").insert([
    { org_id: orgId, property_id: prop.id, kind: "photo", path_full: `e2e/${tag}_1_full.webp`, path_jpeg: `e2e/${tag}_1_jpeg.jpg`, is_cover: true, sort_order: 0, alt: {} },
    { org_id: orgId, property_id: prop.id, kind: "photo", path_full: `e2e/${tag}_2_full.webp`, path_jpeg: `e2e/${tag}_2_jpeg.jpg`, is_cover: false, sort_order: 1, alt: {} },
  ]);
  if (mErr) throw new Error(mErr.message);
  return { id: prop.id as string, reference };
}

test("enable → select → feed → remove → gone", async ({ page }) => {
  const svc = serviceClient();
  const { orgId } = await fixtureProfile(svc);
  const tag = runTag().replace(/-/g, "");
  const listing = await seedPublicListing(svc, orgId, tag);
  const problems = watchForProblems(page);

  try {
    // 1. Settings → Portals: enable JamesEdition (idempotent across runs)
    await page.goto("/settings/portals");
    await expect(page.getByTestId("portal-card-jamesedition")).toBeVisible();
    await assertNoHorizontalOverflow(page, "settings/portals");
    const toggle = page.getByTestId("portal-toggle-jamesedition");
    if ((await toggle.textContent())?.trim() === "Enable") {
      await toggle.click();
    }
    await expect(toggle).toHaveText("Disable");
    const feedInput = page.getByTestId("portal-feed-url-jamesedition");
    await expect(feedInput).toHaveValue(/\/api\/portals\/jamesedition\/[0-9a-f]{64}$/);
    const feedUrl = await feedInput.inputValue();
    const feedPath = feedUrl.replace(/^https?:\/\/[^/]+/, "");
    // a pending portal shows the badge and no toggle
    await expect(page.getByTestId("portal-card-bazaraki")).toContainText("Not available yet");
    await expect(page.getByTestId("portal-toggle-bazaraki")).toHaveCount(0);

    // 2. The listing's Marketing tab: select the portal
    await page.goto(`/properties/${listing.id}`);
    const marketingTab = page.getByRole("tab", { name: "Marketing" });
    await marketingTab.click();
    if (!(await page.getByTestId("portals-card").isVisible().catch(() => false))) {
      await marketingTab.dispatchEvent("mousedown"); // the Radix quirk (HANDOFF §7)
    }
    await expect(page.getByTestId("portals-card")).toBeVisible();
    await assertNoHorizontalOverflow(page, "property Marketing tab");
    const select = page.getByTestId("portal-select-jamesedition");
    await expect(select).toHaveText("Select");
    await expect(select).toBeEnabled();
    await select.click();
    await expect(select).toHaveText("Remove");

    // 3. The portal's view: anonymous, no cookies
    const api = await pwRequest.newContext({ baseURL: baseUrl() });
    const res = await api.get(feedPath);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain(`<ref>${listing.reference}</ref>`);
    expect(xml).toContain(`/media/e2e/${tag}_1_jpeg.jpg`);
    expect(xml).not.toContain("<el>");

    // 4. The timeline names the portal, not its id
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByText("Selected for portal JamesEdition")).toBeVisible();

    // 5. Remove → gone
    await marketingTab.click();
    await expect(select).toHaveText("Remove");
    await select.click();
    await expect(select).toHaveText("Select");
    const after = await api.get(feedPath);
    expect(after.status()).toBe(200);
    expect(await after.text()).not.toContain(`<ref>${listing.reference}</ref>`);

    // 6. The wrong token is a 404, not a hint
    const bad = await api.get(`/api/portals/jamesedition/${"0".repeat(64)}`);
    expect(bad.status()).toBe(404);

    assertNoProblems(problems, "portals loop");
  } finally {
    await svc.from("properties").delete().eq("id", listing.id); // media and selection cascade
  }
});
