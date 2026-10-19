import { expect, test, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  assertNoHorizontalOverflow,
  assertNoProblems,
  fixtureProfile,
  isLocal,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * The admin dashboard's Inventory card (F04-C) on the running app: every
 * number opens a properties list whose header shows the same number.
 *
 * The component's rules — each chip equal to its list's row count through the
 * list's own filter builder, totals equal to postgres' count(*), saleable =
 * listings + units, the function's RLS and grants — are pinned against a real
 * database by supabase/tests/dashboard-inventory.test.ts. This spec proves the
 * clicks:
 *
 *  - the "Available" total opens /properties?status=available&kind=all and the
 *    list's header count equals it (kind=all — every kind — is the list's
 *    stream-L option; this spec belongs on the integrated branch);
 *  - the units chip opens ?status=available&kind=unit with the same count;
 *  - an archived unit and a withdrawn listing are not in any number, and the
 *    "Withdrawn & archived" link opens ?scope=archived&kind=all;
 *  - the card does not scroll sideways at 380px.
 *
 * Seeds a project with two available units, an archived available unit and a
 * withdrawn listing in the local seeded org through the service role; local
 * only, deleted afterwards (units first: parent_id is ON DELETE RESTRICT).
 */

const PREFIX = "E2EINV";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  await svc.from("properties").delete().like("reference", `${PREFIX}%`).eq("kind", "unit");
  await svc.from("properties").delete().like("reference", `${PREFIX}%`);
}

const inventoryCard = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Inventory by status" }) });

/** The number the properties list's header leads with ("13 properties"). */
async function listHeaderCount(page: Page): Promise<number> {
  const header = page.getByRole("heading", { level: 1, name: "Properties" }).locator("xpath=following-sibling::p[1]");
  await expect(header).toHaveText(/^\d+\b/);
  return Number.parseInt((await header.innerText()).trim(), 10);
}

test.describe("dashboard: the Inventory card (F04-C)", () => {
  test.beforeEach(async () => {
    test.skip(!isLocal(), "seeds properties — local only, never production");
    const svc = serviceClient();
    await removeFixture(svc);
    const { orgId } = await fixtureProfile(svc);
    const tag = Date.now().toString(36).slice(-6).toUpperCase();
    const { data: project, error } = await svc
      .from("properties")
      .insert({ org_id: orgId, reference: `${PREFIX}P${tag}`, property_type: "building", kind: "project", status: "available" })
      .select("id")
      .single();
    expect(error).toBeNull();
    // EVERY row names the same columns: a bulk insert sends the union of the
    // rows' keys, and a key one row lacks goes as NULL, not the column default
    // (`visibility` is NOT NULL DEFAULT 'private' — 23502 when only U3 set it).
    const { error: rowsErr } = await svc.from("properties").insert([
      { org_id: orgId, reference: `${PREFIX}U1${tag}`, property_type: "apartment", kind: "unit", parent_id: project!.id, status: "available", visibility: "private" },
      { org_id: orgId, reference: `${PREFIX}U2${tag}`, property_type: "apartment", kind: "unit", parent_id: project!.id, status: "available", visibility: "private" },
      { org_id: orgId, reference: `${PREFIX}U3${tag}`, property_type: "apartment", kind: "unit", parent_id: project!.id, status: "available", visibility: "archived" },
      { org_id: orgId, reference: `${PREFIX}S${tag}`, property_type: "apartment", kind: "standalone", parent_id: null, status: "withdrawn", visibility: "private" },
    ]);
    expect(rowsErr).toBeNull();
  });

  test.afterEach(async () => {
    if (!isLocal()) return;
    await removeFixture(serviceClient());
  });

  test("the Available total and the units chip each open a list with the same count", async ({ page }) => {
    const problems = watchForProblems(page);
    const svc = serviceClient();
    const { orgId } = await fixtureProfile(svc);
    // the documented SQL, as the service role sees the seeded org
    const { count: dbAvailable, error } = await svc
      .from("properties")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "available")
      .neq("visibility", "archived");
    expect(error).toBeNull();

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    const card = inventoryCard(page);
    const total = card.getByRole("link", { name: /^Available: \d+ live records? — open the list$/ });
    const shown = Number.parseInt((await total.innerText()).trim(), 10);
    expect(shown).toBe(dbAvailable);
    await total.click();
    await page.waitForURL(/\/properties\?status=available&kind=all$/);
    expect(await listHeaderCount(page)).toBe(shown);

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    // the available row's units chip (the saleable line links the same list)
    const units = inventoryCard(page).locator('a[href="/properties?status=available&kind=unit"]').last();
    await expect(units).toHaveText(/^\d+ units?$/);
    const unitCount = Number.parseInt((await units.innerText()).trim(), 10);
    expect(unitCount).toBeGreaterThanOrEqual(2); // the two seeded live units; not the archived one
    await units.click();
    await page.waitForURL(/\/properties\?status=available&kind=unit$/);
    expect(await listHeaderCount(page)).toBe(unitCount);
    assertNoProblems(problems, "inventory card links");
  });

  test("withdrawn and archived records are in no number, and one link away", async ({ page }) => {
    const svc = serviceClient();
    const { orgId } = await fixtureProfile(svc);
    const { count: liveUnits } = await svc
      .from("properties")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("kind", "unit")
      .eq("status", "available")
      .neq("visibility", "archived");

    await page.goto("/dashboard", { waitUntil: "networkidle" });
    const card = inventoryCard(page);
    await expect(card.locator('a[href="/properties?status=available&kind=unit"]').first()).toHaveText(
      new RegExp(`^${liveUnits} units?$`),
    );
    // no withdrawn row in a live card
    await expect(card).not.toContainText(/withdrawn\s*\d/i);
    await expect(card).toContainText("Live records: not archived and not withdrawn");
    await card.getByRole("link", { name: "Withdrawn & archived →" }).click();
    await page.waitForURL(/\/properties\?scope=archived&kind=all$/);
    await expect(page.getByRole("heading", { level: 1, name: "Properties" })).toBeVisible();
  });

  test("the card does not scroll sideways at 380px", async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    await inventoryCard(page).scrollIntoViewIfNeeded();
    await expect(inventoryCard(page)).toBeVisible();
    await assertNoHorizontalOverflow(page, "inventory card at 380px");
  });
});
