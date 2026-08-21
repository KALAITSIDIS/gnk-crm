import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * Price list versions you can read (BACKLOG audit finding 4).
 *
 * `list_price` was written by every snapshot since 0001 and selected by nothing:
 * the UI could say "v3 covers 40 units" and could not show one price in it. The
 * assertion that matters is therefore that a stored price REACHES THE SCREEN,
 * and that the diff against the previous version is arithmetic somebody could
 * check by hand.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

test("a version shows its prices and how they moved", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");

  const { data: project } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-PL-${tag}`,
      kind: "project" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      title: { en: "E2E price list project" },
    })
    .select("id, reference")
    .single();

  await admin.from("properties").insert(
    [1, 2].map((n) => ({
      org_id: orgId,
      reference: `${project!.reference}-A10${n}`,
      kind: "unit" as const,
      parent_id: project!.id,
      property_type: "apartment" as const,
      status: "available" as const,
      unit_number: `10${n}`,
      block: "A",
      asking_price: 200000,
    })),
  );

  await page.goto(`/properties/${project!.id}/units`);
  await page.getByLabel("Notes for new version").fill("baseline");
  await page.getByRole("button", { name: "New version" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // one unit moves, the other holds
  await admin
    .from("properties")
    .update({ asking_price: 220000 })
    .eq("reference", `${project!.reference}-A101`);

  await page.reload();
  await page.getByLabel("Notes for new version").fill("A101 up");
  await page.getByRole("button", { name: "New version" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.reload();

  // the collapsed row already answers "what is it worth and what moved"
  await expect(page.getByText("2 units · 1 repriced")).toBeVisible();

  // and the prices themselves reach the screen — the whole of finding 4
  await page.getByRole("button", { expanded: false }).filter({ hasText: "v2" }).click();
  const table = page.locator("table").filter({ hasText: "A101" }).last();
  await expect(table.getByRole("row", { name: /A101/ })).toContainText("€220.000");
  await expect(table.getByRole("row", { name: /A101/ })).toContainText("€200.000"); // was
  await expect(table.getByRole("row", { name: /A101/ })).toContainText("10.0%");
  // the unchanged one reads 0, not blank — "we held the price" is a statement
  await expect(table.getByRole("row", { name: /A102/ })).toContainText("0");

  await admin.from("properties").delete().eq("parent_id", project!.id);
  await admin.from("properties").delete().eq("id", project!.id);
});
