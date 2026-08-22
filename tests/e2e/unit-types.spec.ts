import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * Unit type templates (migration 0039).
 *
 * The behaviour worth pinning is what a STAMP means, because the surprising
 * alternative is a merge: applying "A1" must make a unit an A1, not an A1 still
 * carrying the previous layout's bathroom count. And the one exception — a type
 * with no €/m² rate leaves an existing price ALONE, because a layout template
 * says what the flat is, not what it is worth today.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seed(admin: SupabaseClient, orgId: string, tag: string) {
  const { data: project } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-UT-${tag}`,
      kind: "project" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      title: { en: "E2E unit types project" },
    })
    .select("id, reference")
    .single();

  await admin.from("properties").insert(
    ["A101", "A102", "B201"].map((n) => ({
      org_id: orgId,
      reference: `${project!.reference}-${n}`,
      kind: "unit" as const,
      parent_id: project!.id,
      property_type: "apartment" as const,
      status: "available" as const,
      block: n[0],
      unit_number: n.slice(1),
      // a stale layout the stamp must fully replace
      bedrooms: 9,
      bathrooms: 9,
      covered_area_sqm: 999,
      asking_price: 111111,
    })),
  );
  return project!;
}

test("a type stamps a whole block and replaces the layout completely", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");
  const project = await seed(admin, orgId, tag);

  await page.goto(`/properties/${project.id}/units`);

  await page.locator("#ut-code").fill("A1");
  await page.locator("#ut-name").fill("Two-bed corner");
  await page.locator("#ut-beds").fill("2");
  await page.locator("#ut-area").fill("85");
  await page.locator("#ut-rate").fill("3000");
  // bathrooms deliberately LEFT BLANK — the stamp must clear the units' 9
  await page.getByRole("button", { name: /Add type/ }).click();
  await expect(page.getByText("Unit type saved")).toBeVisible();

  await page.reload();
  await page.getByLabel("Apply a type").click();
  await page.getByRole("option", { name: /A1/ }).click();
  await page.getByLabel("To", { exact: true }).click();
  await page.getByRole("option", { name: "Block A" }).click();
  await page.getByRole("button", { name: /Stamp onto units/ }).click();
  await expect(page.getByText("Layout applied to the units")).toBeVisible();

  const { data: units } = await admin
    .from("properties")
    .select("reference, block, bedrooms, bathrooms, covered_area_sqm, asking_price")
    .eq("parent_id", project.id)
    .order("reference");

  const blockA = units!.filter((u) => u.block === "A");
  expect(blockA).toHaveLength(2);
  for (const u of blockA) {
    expect(u.bedrooms).toBe(2);
    expect(Number(u.covered_area_sqm)).toBe(85);
    expect(Number(u.asking_price)).toBe(255000); // 85 × 3000
    // A STAMP, NOT A MERGE — the blank on the type clears the unit's 9
    expect(u.bathrooms).toBeNull();
  }

  // block B is out of scope and keeps everything
  const blockB = units!.find((u) => u.block === "B")!;
  expect(blockB.bedrooms).toBe(9);
  expect(Number(blockB.asking_price)).toBe(111111);

  await admin.from("unit_types").delete().eq("project_id", project.id);
  await admin.from("properties").delete().eq("parent_id", project.id);
  await admin.from("properties").delete().eq("id", project.id);
});

test("a type with no rate leaves existing prices alone", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");
  const project = await seed(admin, orgId, tag);

  await page.goto(`/properties/${project.id}/units`);
  await page.locator("#ut-code").fill("NOR");
  await page.locator("#ut-beds").fill("3");
  await page.locator("#ut-area").fill("100");
  // no €/m² rate at all
  await page.getByRole("button", { name: /Add type/ }).click();
  await expect(page.getByText("Unit type saved")).toBeVisible();

  await page.reload();
  await page.getByLabel("Apply a type").click();
  await page.getByRole("option", { name: /NOR/ }).click();
  await page.getByRole("button", { name: /Stamp onto units/ }).click();
  await expect(page.getByText("Layout applied to the units")).toBeVisible();

  const { data: units } = await admin
    .from("properties")
    .select("bedrooms, asking_price")
    .eq("parent_id", project.id);

  for (const u of units!) {
    expect(u.bedrooms).toBe(3); // layout applied
    // a template says what the flat IS, not what it is worth — wiping a price
    // nobody asked to change would be destructive
    expect(Number(u.asking_price)).toBe(111111);
  }

  await admin.from("unit_types").delete().eq("project_id", project.id);
  await admin.from("properties").delete().eq("parent_id", project.id);
  await admin.from("properties").delete().eq("id", project.id);
});
