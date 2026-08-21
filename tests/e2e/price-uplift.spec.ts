import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * Repricing a block (BACKLOG audit finding 4, the other half).
 *
 * The action does TWO things — changes the units and mints the version — and
 * both halves have to be true together. A version recording prices the units do
 * not hold would be a lie in the record, and the snapshot exists precisely to
 * be quoted from later.
 *
 * The other rule worth pinning: an unpriced unit is SKIPPED, never treated as
 * zero. Applying +3% to "not priced yet" would invent a number nobody chose.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

test("repricing changes the units, skips the unpriced, and records a version", async ({
  page,
}) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");

  const { data: project } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-UP-${tag}`,
      kind: "project" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      title: { en: "E2E uplift project" },
    })
    .select("id, reference")
    .single();

  await admin.from("properties").insert([
    {
      org_id: orgId,
      reference: `${project!.reference}-A101`,
      kind: "unit" as const,
      parent_id: project!.id,
      property_type: "apartment" as const,
      status: "available" as const,
      block: "A",
      unit_number: "101",
      asking_price: 200000,
    },
    {
      org_id: orgId,
      reference: `${project!.reference}-A102`,
      kind: "unit" as const,
      parent_id: project!.id,
      property_type: "apartment" as const,
      status: "available" as const,
      block: "A",
      unit_number: "102",
      asking_price: null, // must be left alone
    },
  ]);

  await page.goto(`/properties/${project!.id}/units`);
  await page.locator("#uplift-amount").fill("10");

  await expect(page.getByTestId("uplift-preview")).toContainText("Repricing 1 unit");
  await expect(page.getByTestId("uplift-preview")).toContainText("1 unpriced, left alone");

  await page.getByRole("button", { name: /Reprice and record version/ }).click();
  await expect(page.getByText("Prices updated and a new version recorded")).toBeVisible();

  const { data: units } = await admin
    .from("properties")
    .select("reference, asking_price")
    .eq("parent_id", project!.id)
    .order("reference");

  expect(Number(units![0].asking_price)).toBe(220000); // +10%, rounded
  expect(units![1].asking_price).toBeNull(); // untouched

  // the version records what the units now hold — both halves, or neither
  const { data: lists } = await admin
    .from("price_lists")
    .select("id, version, price_list_items(list_price)")
    .eq("project_id", project!.id);
  expect(lists).toHaveLength(1);
  const items = lists![0].price_list_items as { list_price: number | string }[];
  expect(items).toHaveLength(1); // only the priced unit is snapshotted
  expect(Number(items[0].list_price)).toBe(220000);

  // each unit keeps its own trail
  const { data: history } = await admin
    .from("price_history")
    .select("old_price, new_price")
    .eq("property_id", (await admin.from("properties").select("id").eq("reference", `${project!.reference}-A101`).single()).data!.id);
  expect(history).toHaveLength(1);
  expect(Number(history![0].old_price)).toBe(200000);
  expect(Number(history![0].new_price)).toBe(220000);

  await admin.from("properties").delete().eq("parent_id", project!.id);
  await admin.from("properties").delete().eq("id", project!.id);
});
