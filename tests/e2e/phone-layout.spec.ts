import { expect, test } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  fixtureProfile,
  isLocal,
  runTag,
  serviceClient,
} from "./helpers";

/**
 * Audit 2026-09-13, CRM-06: what a phone gets.
 *
 * The properties list with no `?view=` is AUTO — cards below the tablet
 * breakpoint, the table above it, both in the DOM and one hidden by CSS
 * (the page is a server component and cannot know the viewport). The lead
 * card keeps its five working actions on a phone and folds the other five
 * behind "More…". Runs under BOTH projects: the desktop assertions are the
 * inverse of the mobile ones, so a change that leaks one layout into the
 * other fails somewhere.
 *
 * Verified on production by hand? No — Claude in Chrome could not shrink a
 * maximised window on 2026-09-13, which is why this spec exists.
 *
 * The contact detail page joined 2026-09-14: its header action group ran to
 * x=631 in a 390px viewport, and nothing measured that route at phone width.
 */
const isPhone = (width: number) => width < 768;

test.describe("phone layouts (CRM-06)", () => {
  test("the properties list is cards on a phone and the table above it", async ({ page }, testInfo) => {
    await page.goto("/properties", { waitUntil: "networkidle" });
    const phone = isPhone(testInfo.project.use.viewport?.width ?? 1280);
    const table = page.getByRole("table").first();
    if (phone) {
      await expect(table, "no twelve-column table on a phone").toBeHidden();
      // a card carries the reference as a link; the table's links are hidden with it
      await expect(page.getByRole("link", { name: /PAF\d{4}/ }).first()).toBeVisible();
    } else {
      await expect(table).toBeVisible();
    }
    // an explicit choice is honoured everywhere
    await page.goto("/properties?view=table", { waitUntil: "networkidle" });
    await expect(page.getByRole("table").first()).toBeVisible();
    await page.goto("/properties?view=cards", { waitUntil: "networkidle" });
    await expect(page.getByRole("table")).toHaveCount(0);
  });

  /**
   * A03: the table's twelve columns sat in a horizontal scroller from the
   * tablet breakpoint up, so at 1024 px everything right of the title was off
   * screen. The columns now appear by priority in a fixed layout; at a small
   * laptop's width the table fits its container with nothing to scroll —
   * measured on the table's own scroller, not only the page.
   *
   * The land table (Plot m² and Density in place of Area and Beds) needs a
   * land listing to draw a row at all, and the seed database has none — the
   * empty state has no table, so nothing was measured. Locally the test plants
   * one plot with every land figure and a long title (the cells that could
   * widen the table) and deletes it; elsewhere it measures the land on file.
   */
  test("the properties table fits a 1024 px window without a sideways scroll", async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project.use.viewport?.width ?? 1280), "desktop widths");
    let plotId: string | null = null;
    const svc = isLocal() ? serviceClient() : null;
    if (svc) {
      const { orgId } = await fixtureProfile(svc);
      const { data, error } = await svc
        .from("properties")
        .insert({
          org_id: orgId,
          reference: `E2E-PLOT-${runTag().slice(-6)}`,
          property_type: "land",
          transaction_type: "sale",
          status: "available",
          visibility: "private",
          title: { en: "Phone layout plot with a long title that has to truncate in its cell" },
          plot_area_sqm: 125000,
          building_density_pct: 120,
          asking_price: 12500000,
        })
        .select("id")
        .single();
      expect(error, `seeding a land listing: ${error?.message}`).toBeNull();
      plotId = data!.id as string;
    }
    try {
      // 1536: Score and Visibility join as columns there (A03 review) and must fit too
      for (const width of [1024, 1280, 1536]) {
        await page.setViewportSize({ width, height: 800 });
        for (const path of ["/properties?view=table", "/properties?view=table&type=land"]) {
          await page.goto(path, { waitUntil: "networkidle" });
          await expect(page.getByRole("table").first()).toBeVisible();
          const scrollers = await page.evaluate(() =>
            [...document.querySelectorAll('main [data-slot="table-container"]')].map((el) => ({
              scroll: el.scrollWidth,
              client: el.clientWidth,
            })),
          );
          expect(scrollers.length, `${path} at ${width}px: a table`).toBeGreaterThan(0);
          for (const s of scrollers) {
            expect(s.scroll - s.client, `${path} at ${width}px: the table scrolls sideways (${s.scroll} in ${s.client})`).toBeLessThanOrEqual(1);
          }
          await assertNoHorizontalOverflow(page, `${path} at ${width}px`);
        }
      }
    } finally {
      if (svc && plotId) {
        const removed = await svc.from("properties").delete({ count: "exact" }).eq("id", plotId);
        expect(removed.error, `fixture delete: ${removed.error?.message}`).toBeNull();
        expect(removed.count, "the fixture plot is gone").toBe(1);
      }
    }
  });

  test("a lead card folds its secondary actions behind More… on a phone only", async ({ page }, testInfo) => {
    await page.goto("/leads", { waitUntil: "networkidle" });
    const phone = isPhone(testInfo.project.use.viewport?.width ?? 1280);
    const card = page.locator("li, article, div").filter({ has: page.getByRole("button", { name: /^Log$/ }) }).first();
    test.skip(!(await page.getByRole("button", { name: /^Log$/ }).count()), "no open lead on this database");
    const more = card.getByRole("button", { name: /More…|Less/ }).first();
    const secondary = card.getByRole("button", { name: /^Close$/ }).first();
    if (phone) {
      await expect(more).toBeVisible();
      await expect(secondary, "Close waits behind More… on a phone").toBeHidden();
      await more.click();
      await expect(secondary).toBeVisible();
      await expect(card.getByRole("button", { name: "Less" }).first()).toBeVisible();
    } else {
      await expect(more, "no fold on a desktop").toBeHidden();
      await expect(secondary).toBeVisible();
    }
  });

  /**
   * The header of `/contacts/<id>` holds every action an admin gets on a live
   * contact — Log contact · Add task · Archive · Merge · Erase personal data —
   * 607px of buttons in a group that did not wrap, so the page was 631px wide
   * in a 390px viewport (measured 2026-09-14). That five-button case is the
   * widest the page has, so the fixture is a live, unerased contact opened by
   * the admin the harness signs in as, and the test first proves the fifth
   * button is on the page: a narrower header would pass without measuring
   * anything. The desktop run is the same measurement at a width where the
   * group fits beside the name.
   *
   * Seeded through the service role rather than found: the local database
   * may hold no live contact, and one that exists may be archived, which
   * drops three of the five buttons.
   */
  test("a contact detail page does not scroll sideways on a phone", async ({ page }) => {
    test.skip(!isLocal(), "seeding a contact needs the local service key");
    const svc = serviceClient();
    const { orgId } = await fixtureProfile(svc);
    const tag = runTag();
    const { data: contact, error } = await svc
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "Phone",
        last_name: `Layout-${tag}`,
        // digits only: the tag is base36 and a letter is not a phone number
        phone_e164: `+35799${Date.now().toString().slice(-6)}`,
        notes: `phone-layout fixture ${tag}`,
      })
      .select("id")
      .single();
    expect(error, `seeding a contact: ${error?.message}`).toBeNull();
    try {
      await page.goto(`/contacts/${contact!.id}`, { waitUntil: "networkidle" });
      await expect(
        page.getByRole("button", { name: "Erase personal data" }),
        "the widest header — all five admin actions — is what gets measured",
      ).toBeVisible();
      await assertNoHorizontalOverflow(page, "contact detail");
    } finally {
      const removed = await svc.from("contacts").delete({ count: "exact" }).eq("id", contact!.id);
      expect(removed.error, `fixture delete: ${removed.error?.message}`).toBeNull();
      expect(removed.count, "the fixture contact is gone").toBe(1);
    }
  });

  /**
   * A05: a unit's breadcrumb — Properties › project › phase › unit, with
   * development references — wraps rather than widening the page, and a phased
   * project's availability table stays inside the viewport, scrolling inside
   * itself as the matrix does.
   */
  test("a unit's breadcrumb and a phased project's availability table do not widen a phone page", async ({ page }) => {
    test.skip(!isLocal(), "seeding the hierarchy needs the local service key");
    const svc = serviceClient();
    const { orgId } = await fixtureProfile(svc);
    // about as long as a real development reference (PAF0002-P1-A101): the
    // heading is the unbroken reference and the breadcrumb is what is measured
    const ref = `E2E-PH-${runTag().slice(-6)}`;
    const insert = async (row: Record<string, unknown>) => {
      const { data, error } = await svc
        .from("properties")
        .insert({ org_id: orgId, property_type: "apartment", status: "available", ...row })
        .select("id")
        .single();
      expect(error, `seeding ${String(row.reference)}: ${error?.message}`).toBeNull();
      return data!.id as string;
    };
    const project = await insert({ reference: ref, kind: "project", title: { en: "Phone layout development" } });
    const phase = await insert({ reference: `${ref}-P1`, kind: "phase", parent_id: project, delivery_date: "2027-06-30" });
    const unit = await insert({ reference: `${ref}-P1-A101`, kind: "unit", parent_id: phase, block: "A", unit_number: "101" });
    try {
      await page.goto(`/properties/${unit}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
      await assertNoHorizontalOverflow(page, "unit detail with its breadcrumb");
      await page.goto(`/properties/${project}/units`, { waitUntil: "networkidle" });
      const overview = page.getByTestId("availability-overview");
      await expect(overview).toBeVisible();
      // the new table's own box, measured: it scrolls inside, it never pushes
      // the page wider (the rest of this page is not measured at phone width)
      const box = await overview.boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      expect(box, "the availability table has a box").not.toBeNull();
      expect(box!.x + box!.width, "the availability table ends inside the viewport").toBeLessThanOrEqual(width + 1);
    } finally {
      await svc.from("properties").delete().eq("id", unit);
      await svc.from("properties").delete().eq("id", phase);
      await svc.from("properties").delete().eq("id", project);
    }
  });

  /**
   * A04 put a tick, chips and a Viewing button on every match row, and a
   * Create proposal bar under the list. The widest case is a row carrying all
   * of them — so the fixture is a buyer whose search matches a reserved,
   * off-market listing, opened straight on the Preferences tab
   * (`?tab=preferences`), with that row ticked so the caveat and the
   * off-market confirmation are on the page too.
   */
  test("a buyer's matches with their row actions do not scroll sideways on a phone", async ({ page }) => {
    test.skip(!isLocal(), "seeding a buyer and a listing needs the local service key");
    const svc = serviceClient();
    const { orgId } = await fixtureProfile(svc);
    const tag = runTag();
    const ref = `E2EPL${tag.slice(-5).toUpperCase()}`;
    const { data: district } = await svc.from("districts").select("id").eq("org_id", orgId).eq("code", "PAF").single();
    const { data: buyer, error: bErr } = await svc
      .from("contacts")
      .insert({ org_id: orgId, first_name: "Phone", last_name: `Matches-${tag}`, contact_types: ["buyer"] })
      .select("id")
      .single();
    expect(bErr, `seeding a buyer: ${bErr?.message}`).toBeNull();
    const { data: listing, error: pErr } = await svc
      .from("properties")
      .insert({
        org_id: orgId,
        reference: ref,
        kind: "standalone",
        property_type: "villa",
        transaction_type: "sale",
        status: "reserved",
        visibility: "off_market",
        district_id: district!.id,
        asking_price: 450000,
        bedrooms: 3,
        title: { en: `A rather long listing title for the phone layout check ${tag}` },
      })
      .select("id")
      .single();
    expect(pErr, `seeding a listing: ${pErr?.message}`).toBeNull();
    const { error: rErr } = await svc.from("buyer_requirements").insert({
      org_id: orgId,
      contact_id: buyer!.id,
      label: `Phone layout ${tag}`,
      transaction_type: "sale",
      property_types: ["villa"],
      district_ids: [district!.id],
      area_ids: [],
      features_required: [],
      title_deed_required: false,
    });
    expect(rErr, `seeding a search: ${rErr?.message}`).toBeNull();
    try {
      await page.goto(`/contacts/${buyer!.id}?tab=preferences`, { waitUntil: "networkidle" });
      await expect(
        page.getByRole("button", { name: new RegExp(`^Viewing — ${ref}`) }),
        "the widest row — tick, chips, Viewing — is what gets measured",
      ).toBeVisible();
      await page.getByRole("checkbox", { name: `Include ${ref} in the proposal` }).check();
      await expect(page.getByRole("checkbox", { name: /this buyer may see off-market listings/i })).toBeVisible();
      await assertNoHorizontalOverflow(page, "contact preferences with match actions");
    } finally {
      await svc.from("buyer_requirements").delete().eq("contact_id", buyer!.id);
      await svc.from("events").delete().eq("entity_id", buyer!.id);
      await svc.from("contacts").delete().eq("id", buyer!.id);
      await svc.from("events").delete().eq("entity_id", listing!.id);
      await svc.from("properties").delete().eq("id", listing!.id);
    }
  });
});
