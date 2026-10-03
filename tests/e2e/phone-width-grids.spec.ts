import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { assertNoHorizontalOverflow, assertShellRendered, fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * Phone width, forced: no page is wider than a 390 px screen, and the deal
 * page's Won dialog can be submitted there (BACKLOG "On a phone, a deal with
 * an offer cannot be closed from its page").
 *
 * A CSS grid with `sm:` / `lg:` / `xl:grid-cols-N` and NO base template has
 * one implicit `auto` column below its breakpoint, and an auto column grows to
 * its content's min-content width: the deal page's offers table — and, inside
 * it, the Details form's pickers, whose labels are `truncate` (nowrap) spans
 * as wide as an ordinary property title or an e-mail address — widened the
 * whole page past the screen, so every dialog on it (they centre in the
 * widened layout viewport) opened partly off it. `grid-cols-1`
 * (minmax(0, 1fr)) keeps the column at the screen's width; a table scrolls
 * inside its own wrapper and a picker label truncates.
 *
 * The fixtures carry REALISTIC text — a long English title, an e-mail
 * sublabel — because the first version of this spec used a bare reference and
 * no sublabel, and passed while the Details grid still overflowed (found by
 * its review). Every check first waits for the content under test, so an
 * empty page cannot pass. CI runs the DESKTOP project only, so the viewport
 * is set here.
 */

const PHONE = { width: 390, height: 844 };
const REF_PROP = "E2EPHONE01";
const REF_PROJECT = "E2EPHONEPJ";
const DEAL_TITLE = "E2E phone-width fixture deal";
const LONG_TITLE = "Two-bedroom sea-view apartment in Germasogeia, Limassol";
const LONG_EMAIL = "e2e.phone.buyer.with.a.long.address@example.invalid";

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

/** Waits for the content under test, then measures. */
async function fits(page: Page, landmark: ReturnType<Page["getByText"]>, context: string) {
  await assertShellRendered(page);
  await expect(landmark.first(), `${context}: the content under test rendered`).toBeVisible();
  await assertNoHorizontalOverflow(page, context);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(PHONE);
});

test.describe("seeded fixtures", () => {
  test.beforeEach(() => {
    test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
  });

  /** A property with a long title, owned by a buyer contact with a long e-mail, and a deal with an accepted offer. */
  async function seedDeal(svc: SupabaseClient, orgId: string) {
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
    const { data: buyer, error: buyerErr } = await svc
      .from("contacts")
      .insert({
        org_id: orgId,
        contact_kind: "person",
        first_name: "E2EPhoneBuyer",
        last_name: "Wideoffer-Papadopoulou",
        email: LONG_EMAIL,
        company_name: "Germasogeia Seafront Investments Limited",
      })
      .select("id")
      .single();
    expect(buyerErr).toBeNull();
    const { data: prop, error: propErr } = await svc
      .from("properties")
      .insert({
        org_id: orgId,
        reference: REF_PROP,
        property_type: "apartment",
        status: "available",
        title: { en: LONG_TITLE },
        owner_contact_id: buyer!.id,
      })
      .select("id")
      .single();
    expect(propErr).toBeNull();
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
    return { dealId: deal!.id as string, propertyId: prop!.id as string, buyerId: buyer!.id as string };
  }

  test("a deal with an offer, a titled property and a buyer with an e-mail fits a phone, and its Won dialog can be submitted there", async ({ page }) => {
    const svc = serviceClient();
    await removeFixture(svc);
    const { orgId } = await fixtureProfile(svc);
    try {
      const { dealId } = await seedDeal(svc, orgId);
      await page.goto(`/deals/${dealId}`, { waitUntil: "networkidle" });
      // the offers table and the Details pickers' long labels are both on the page
      await expect(page.getByRole("heading", { name: "Offers" })).toBeVisible();
      await fits(page, page.getByText(LONG_TITLE), "a deal with an offer");
      await expect(page.getByText(LONG_EMAIL).first()).toBeAttached();

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

  test("the contact page and the property page of the same long-text records fit a phone", async ({ page }) => {
    const svc = serviceClient();
    await removeFixture(svc);
    const { orgId } = await fixtureProfile(svc);
    try {
      const { propertyId, buyerId } = await seedDeal(svc, orgId);
      await page.goto(`/contacts/${buyerId}`, { waitUntil: "networkidle" });
      await fits(page, page.getByText("Wideoffer-Papadopoulou"), "a contact with a long e-mail and company");
      await page.goto(`/properties/${propertyId}`, { waitUntil: "networkidle" });
      await fits(page, page.getByText(LONG_TITLE), "a titled property with an owner");
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
        .insert({
          org_id: orgId,
          reference: REF_PROJECT,
          kind: "project",
          property_type: "apartment",
          status: "available",
          title: { en: LONG_TITLE },
        })
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
      await fits(page, page.getByRole("heading", { name: new RegExp(`Units — ${LONG_TITLE}`) }), "a project's units page");
    } finally {
      await removeFixture(svc);
    }
  });
});

for (const [path, landmark] of [
  ["/dashboard", /won this month/i],
  ["/settings/locations", /paphos/i],
  ["/settings/stages", /^sale$/i],
  ["/calculators", /transfer fees \(dls\)/i],
] as const) {
  test(`${path} fits a phone`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await fits(page, page.getByText(landmark), path);
  });
}
