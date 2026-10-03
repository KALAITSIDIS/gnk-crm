import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { assertNoHorizontalOverflow, fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * Phone width, forced: no page with a two- or three-column grid is wider
 * than a 390 px screen, and the deal page's Won dialog can be submitted there
 * (BACKLOG "On a phone, a deal with an offer cannot be closed from its page").
 *
 * A CSS grid with `lg:grid-cols-N` and NO base template has one implicit
 * `auto` column below the breakpoint, and an auto column grows to its
 * content's min-content width: the deal page's offers table widened the whole
 * page past the screen, so every dialog on it (they centre in the widened
 * layout viewport) opened partly off it, and Playwright's mobile project could
 * not click "Mark won". `grid-cols-1` (minmax(0, 1fr)) keeps the column at the
 * screen's width; a table scrolls inside its own wrapper.
 *
 * CI runs the DESKTOP project only (phone-layout.spec.ts measures each
 * project at its own width), so this spec sets the 390 × 844 viewport itself.
 */

const PHONE = { width: 390, height: 844 };
const REF_PROP = "E2EPHONE01";
const REF_PROJECT = "E2EPHONEPJ";
const DEAL_TITLE = "E2E phone-width fixture deal";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: deals } = await svc.from("deals").select("id").eq("title", DEAL_TITLE);
  for (const d of deals ?? []) {
    await svc.from("offers").delete().eq("deal_id", d.id);
    await svc.from("deals").delete().eq("id", d.id);
  }
  for (const ref of [`${REF_PROJECT}-U1`, REF_PROJECT, REF_PROP]) {
    const { data: props } = await svc.from("properties").select("id").eq("reference", ref);
    for (const p of props ?? []) await svc.from("properties").delete().eq("id", p.id);
  }
  await svc.from("contacts").delete().eq("first_name", "E2EPhoneBuyer");
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(PHONE);
});

test.describe("seeded fixtures", () => {
  test.beforeEach(() => {
    test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
  });

  test("a deal with an offer fits a phone, and its Won dialog can be submitted there", async ({ page }) => {
    const svc = serviceClient();
    await removeFixture(svc);
    const { orgId } = await fixtureProfile(svc);
    try {
      const { data: stage } = await svc
        .from("deal_stages")
        .select("id")
        .eq("org_id", orgId)
        .eq("deal_type", "sale")
        .eq("is_won", false)
        .eq("is_lost", false)
        .order("sort_order")
        .limit(1)
        .single();
      const { data: prop, error: propErr } = await svc
        .from("properties")
        .insert({ org_id: orgId, reference: REF_PROP, property_type: "apartment", status: "available" })
        .select("id")
        .single();
      expect(propErr).toBeNull();
      const { data: buyer, error: buyerErr } = await svc
        .from("contacts")
        .insert({ org_id: orgId, contact_kind: "person", first_name: "E2EPhoneBuyer", last_name: "Wideoffer" })
        .select("id")
        .single();
      expect(buyerErr).toBeNull();
      const { data: deal, error: dealErr } = await svc
        .from("deals")
        .insert({
          org_id: orgId,
          stage_id: stage!.id,
          deal_type: "sale",
          title: DEAL_TITLE,
          property_id: prop!.id,
          buyer_contact_id: buyer!.id,
          expected_value: 250000,
        })
        .select("id")
        .single();
      expect(dealErr).toBeNull();
      const { error: offerErr } = await svc.from("offers").insert({
        org_id: orgId,
        deal_id: deal!.id,
        property_id: prop!.id,
        contact_id: buyer!.id,
        amount: 250000,
        status: "accepted",
      });
      expect(offerErr).toBeNull();

      await page.goto(`/deals/${deal!.id}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { name: "Offers" })).toBeVisible();
      await assertNoHorizontalOverflow(page, "a deal with an offer");

      await page.getByRole("button", { name: /mark won/i }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const submit = dialog.getByRole("button", { name: /mark won/i });
      await expect(submit).toBeInViewport({ ratio: 1 });
      // actionable — visible, stable, enabled and NOT covered by the overlay — without submitting
      await submit.click({ trial: true });
      await page.keyboard.press("Escape");
    } finally {
      await removeFixture(svc);
    }
  });

  test("a project's units page fits a phone", async ({ page }) => {
    const svc = serviceClient();
    await removeFixture(svc);
    const { orgId } = await fixtureProfile(svc);
    try {
      const { data: project, error: projErr } = await svc
        .from("properties")
        .insert({ org_id: orgId, reference: REF_PROJECT, kind: "project", property_type: "apartment", status: "available" })
        .select("id")
        .single();
      expect(projErr).toBeNull();
      const { error: unitErr } = await svc.from("properties").insert({
        org_id: orgId,
        reference: `${REF_PROJECT}-U1`,
        kind: "unit",
        parent_id: project!.id,
        property_type: "apartment",
        status: "available",
        unit_number: "101",
        asking_price: 199000,
      });
      expect(unitErr).toBeNull();
      await page.goto(`/properties/${project!.id}/units`, { waitUntil: "networkidle" });
      await assertNoHorizontalOverflow(page, "a project's units page");
    } finally {
      await removeFixture(svc);
    }
  });
});

for (const path of ["/dashboard", "/settings/locations", "/settings/stages", "/calculators"]) {
  test(`${path} fits a phone`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await assertNoHorizontalOverflow(page, path);
  });
}
