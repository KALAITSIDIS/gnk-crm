import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * F07: the Details tab is laid out for the kind of property — the whole path:
 * the real form, the real server action, the real database.
 *
 * A plot (PAF0003's shape: a stray bedroom count and residential features
 * beside its planning terms) opens on Location, Plot & planning, Access &
 * utilities, Constraints, Pricing and Features; Building & accommodation and
 * Build & handover follow in native <details> that say what they hold. A
 * density change saved through that form leaves every collapsed value, every
 * feature and both utilities — one recorded, one not — exactly as they were,
 * and the `updated` event names only the density. The Overview shows the
 * planning terms instead of bedrooms. A project opens on Build & handover with
 * its rooms set aside; a flat is unchanged.
 *
 * Isolated rows of the fixture org, private, deleted at the end.
 */
const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seed(admin: SupabaseClient, orgId: string, cols: Record<string, unknown>) {
  const { data: district } = await admin
    .from("districts")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();
  const { data, error } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-LAYOUT-${randomBytes(3).toString("hex")}`,
      status: "available" as const,
      visibility: "private" as const,
      district_id: district!.id,
      ...cols,
    })
    .select("id, reference")
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

const detailsForm = (page: Page) =>
  page.locator("form").filter({ has: page.getByLabel(/^visibility$/i) });

/** Section headings and collapsed-group summaries of the Details form, in order. */
const outline = (page: Page) =>
  detailsForm(page)
    .locator("h3, summary")
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()));

async function openDetails(page: Page, id: string) {
  await page.goto(`/properties/${id}?tab=details`, { waitUntil: "networkidle" });
  await expect(detailsForm(page)).toBeVisible({ timeout: 15_000 });
}

test("a plot opens on its planning, and a density change leaves everything else as it was", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const plot = await seed(admin, orgId, {
    property_type: "land" as const,
    title: { en: "E2E plot" },
    asking_price: 180000,
    plot_area_sqm: 1200,
    planning_zone_code: "Κα6",
    building_density_pct: 60,
    coverage_ratio_pct: 35,
    road_frontage_m: 22.5,
    water_available: true,
    bedrooms: 2,
    features: ["sea_view", "furnished"],
  });
  const stored = async () =>
    (
      await admin
        .from("properties")
        .select(
          "building_density_pct, planning_zone_code, bedrooms, features, water_available, electricity_available, plot_area_sqm, coverage_ratio_pct, road_frontage_m",
        )
        .eq("id", plot.id)
        .single()
    ).data!;
  const updatedEvents = async () =>
    (
      await admin
        .from("events")
        .select("payload")
        .eq("entity_id", plot.id)
        .eq("event_type", "updated")
        .order("occurred_at", { ascending: true })
    ).data!.map((e) => (e.payload as { changed: Record<string, unknown> }).changed);

  try {
    await openDetails(page, plot.id);

    // the order: planning first, the dwelling groups set aside and saying what they hold
    const o = await outline(page);
    const at = (s: string) => o.findIndex((x) => x.startsWith(s));
    for (const [a, b] of [
      ["Location", "Plot & planning"],
      ["Plot & planning", "Access & utilities"],
      ["Access & utilities", "Constraints"],
      ["Constraints", "Pricing"],
      ["Pricing", "Features"],
      ["Features", "Building & accommodation"],
      ["Building & accommodation", "Build & handover"],
    ] as const) {
      expect(at(a), `${a} is on the tab`).toBeGreaterThanOrEqual(0);
      expect(at(a), `${a} before ${b}`).toBeLessThan(at(b));
    }
    expect(o[at("Building & accommodation")]).toContain("not usual for land · 1 recorded: Bedrooms 2");
    expect(o[at("Build & handover")]).toContain("nothing recorded");
    // the one holding a value is open (its bedroom box is visible), the empty one closed
    const form = detailsForm(page);
    await expect(form.locator('details[data-details-group="building_accommodation"]')).toHaveAttribute("open", "");
    await expect(form.locator('details[data-details-group="build_handover"]')).not.toHaveAttribute("open");
    await expect(form.locator('input[name="bedrooms"]')).toBeVisible();
    await expect(form.locator('input[name="delivery_date"]')).toBeHidden();

    // the utilities are three-way answers, showing what is stored
    await expect(form.getByLabel("Water available", { exact: true })).toContainText("Yes");
    await expect(form.getByLabel("Electricity available", { exact: true })).toContainText("Not known");

    // change the density only, and save
    await form.locator('input[name="building_density_pct"]').fill("55");
    const roundTrip = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/properties/${plot.id}`,
    );
    await form.getByRole("button", { name: /^save$/i }).click();
    await roundTrip;
    await expect(page.getByText(/^saved$/i).first()).toBeVisible({ timeout: 15_000 });

    expect(await stored()).toEqual({
      building_density_pct: 55,
      planning_zone_code: "Κα6",
      bedrooms: 2,
      features: ["sea_view", "furnished"],
      water_available: true,
      electricity_available: null,
      plot_area_sqm: 1200,
      coverage_ratio_pct: 35,
      road_frontage_m: 22.5,
    });
    const events = await updatedEvents();
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!)).toEqual(["building_density_pct"]);

    // the Overview: the plot and its planning terms, not bedrooms
    await page.goto(`/properties/${plot.id}`, { waitUntil: "networkidle" });
    // the Overview tab's facts, by name: the A08 summary strip above the tabs
    // is a <dl> too, and now the page's first
    const overview = page.getByTestId("property-overview-facts");
    await expect(overview).toContainText("Planning");
    await expect(overview).toContainText("Κα6 · density 55% · coverage 35%");
    await expect(overview).toContainText("Road frontage");
    await expect(overview).toContainText("Water: Yes · Electricity: not recorded");
    await expect(overview).not.toContainText("Bedrooms / Bathrooms");
  } finally {
    await admin.from("properties").delete().eq("id", plot.id);
  }
});

test("a project opens on Build & handover, its rooms set aside — and a covered area typed there still moves the VAT panel above it; a flat is unchanged", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const project = await seed(admin, orgId, {
    kind: "project" as const,
    property_type: "apartment" as const,
    title: { en: "E2E layout project" },
    plot_area_sqm: 4000,
    construction_status: "under_construction",
    // the VAT panel reads the price and the covered area: here the area sits
    // in the collapsed rooms group, BELOW the panel (vat-treatment.tsx)
    vat_status: "new_vat",
    asking_price: 300000,
    covered_area_sqm: 100,
  });
  const flat = await seed(admin, orgId, {
    property_type: "apartment" as const,
    title: { en: "E2E layout flat" },
    covered_area_sqm: 92,
    bedrooms: 2,
  });
  try {
    await openDetails(page, project.id);
    const p = await outline(page);
    expect(p[0]).toBe("Build & handover");
    const rooms = p.find((x) => x.startsWith("Building & accommodation"));
    expect(rooms).toContain("each unit carries its own · 1 recorded: Covered 100 m²");
    await expect(detailsForm(page).getByRole("link", { name: "Units matrix" })).toHaveAttribute(
      "href",
      `/properties/${project.id}/units`,
    );
    await expect(detailsForm(page).getByLabel("From price (€)")).toBeVisible();

    // live, not saved: 100 m² at €300,000 is the reduced band; 191 m² is over
    // the 190 m² total cap (the seeded config), so the whole price is standard-rated
    // the panel: the heading's row, and the box around it
    const panel = detailsForm(page)
      .getByRole("heading", { name: "VAT treatment", exact: true })
      .locator("xpath=../..");
    await expect(panel).toContainText("€300.000 at 5%");
    await detailsForm(page).locator('input[name="covered_area_sqm"]').fill("191");
    await expect(panel).toContainText("€300.000 at 19%");
    await expect(panel).not.toContainText("at 5%");

    await openDetails(page, flat.id);
    const f = await outline(page);
    expect(f.filter((x) => x !== "VAT treatment")).toEqual([
      "Location",
      "Pricing",
      "Areas & rooms",
      "Build & handover",
      "Features",
      "Internal notes",
    ]);
    await expect(detailsForm(page).locator("details")).toHaveCount(0);
    await expect(detailsForm(page).locator('[name="planning_zone_code"]')).toHaveCount(0);
  } finally {
    await admin.from("properties").delete().in("id", [project.id, flat.id]);
  }
});
