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
});
