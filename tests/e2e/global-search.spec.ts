import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The topbar's global search (doc 05: ⌘K) — a regression guard (A03). It
 * worked and nothing exercised it through the keyboard: the shortcut, typing
 * a reference, Enter opening the first match, Escape closing and clearing.
 * `lib/actions/entity-search.test.ts` covers only the server action.
 *
 * Desktop: the trigger button is hidden below the `sm` breakpoint (the
 * shortcut still works there, but a phone has no keyboard to press it with).
 */
test.describe("global search (⌘K)", () => {
  test.skip(({ isMobile }) => isMobile, "desktop: a keyboard shortcut");

  let fixture: { id: string; reference: string } | null = null;

  test.beforeEach(async () => {
    test.skip(!isLocal(), "seeding a listing needs the local service key");
    const svc = serviceClient();
    const { orgId } = await fixtureProfile(svc);
    // a reference no seeded record contains, so it is the first (only) match
    const reference = `E2E-GS-${randomBytes(3).toString("hex").toUpperCase()}`;
    const { data, error } = await svc
      .from("properties")
      .insert({
        org_id: orgId,
        reference,
        property_type: "villa",
        status: "available",
        visibility: "private",
        title: { en: `Global search villa ${reference}` },
      })
      .select("id")
      .single();
    expect(error, `seeding a listing: ${error?.message}`).toBeNull();
    fixture = { id: data!.id, reference };
  });

  test.afterEach(async () => {
    if (!fixture) return;
    const { error } = await serviceClient().from("properties").delete().eq("id", fixture.id);
    expect(error, `fixture delete: ${error?.message}`).toBeNull();
    fixture = null;
  });

  test("Control+K opens it; a reference typed and Enter open the property", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const box = dialog.getByPlaceholder(/search properties, contacts/i);
    await expect(box).toBeFocused();
    await box.fill(fixture!.reference);
    // the match is listed before Enter is pressed (250 ms debounce + the action)
    await expect(dialog.getByRole("button", { name: new RegExp(fixture!.reference) })).toBeVisible();
    await box.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/properties/${fixture!.id}$`));
    await expect(dialog).toBeHidden();
  });

  test("a click on a match opens it too", async ({ page }) => {
    await page.goto("/properties", { waitUntil: "networkidle" });
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/search properties, contacts/i).fill(fixture!.reference);
    await dialog.getByRole("button", { name: new RegExp(fixture!.reference) }).click();
    await expect(page).toHaveURL(new RegExp(`/properties/${fixture!.id}$`));
  });

  test("Escape closes it, and it opens empty the next time", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    const box = dialog.getByPlaceholder(/search properties, contacts/i);
    await box.fill(fixture!.reference);
    await expect(dialog.getByRole("button", { name: new RegExp(fixture!.reference) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder(/search properties, contacts/i)).toHaveValue("");
    await expect(dialog.getByRole("button", { name: new RegExp(fixture!.reference) })).toHaveCount(0);
  });

  test("text that matches nothing says so, and Enter goes nowhere", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    const box = dialog.getByPlaceholder(/search properties, contacts/i);
    await box.fill(`zz-${fixture!.reference}-none`);
    await expect(dialog.getByText("No matches.")).toBeVisible();
    await box.press("Enter");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(dialog).toBeVisible();
  });
});
