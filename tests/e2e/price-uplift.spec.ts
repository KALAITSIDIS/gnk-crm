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
 *
 * Since 0141 (T-price-uplift-atomic) both halves are ONE database transaction,
 * and two browser-level promises are pinned here as well: a price that moved
 * after the page was drawn is never overwritten (nothing is written, the page
 * redraws), and a submission whose answer was lost is answered — not applied
 * again — when it is pressed a second time. The database-level proofs (every
 * failure stage, races, roles, parity) are supabase/tests/price-list-version
 * .test.ts and price-uplift-actions.test.ts.
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
  const a101 = (await admin.from("properties").select("id").eq("reference", `${project!.reference}-A101`).single()).data!.id;
  const { data: history } = await admin
    .from("price_history")
    .select("old_price, new_price")
    .eq("property_id", a101);
  expect(history).toHaveLength(1);
  expect(Number(history![0].old_price)).toBe(200000);
  expect(Number(history![0].new_price)).toBe(220000);

  // ONE price_changed line per moved unit — the trigger's — and the version's own (0141;
  // before it the action wrote a second copy of every unit's line)
  expect(await eventCount(admin, a101, "price_changed")).toBe(1);
  expect(await eventCount(admin, project!.id, "price_list_created")).toBe(1);

  await admin.from("properties").delete().eq("parent_id", project!.id);
  await admin.from("properties").delete().eq("id", project!.id);
});

async function eventCount(admin: SupabaseClient, entityId: string, eventType: string): Promise<number> {
  const { count, error } = await admin
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", entityId)
    .eq("event_type", eventType);
  if (error) throw new Error(`events count: ${error.message}`);
  return count ?? 0;
}

/**
 * Fixture projects of the tests below, removed after each test whether or not
 * it passed (units first: parent_id is ON DELETE RESTRICT). Their events stay —
 * the chain is append-only.
 */
const madeProjects: string[] = [];
test.afterEach(async () => {
  const admin = svc();
  for (const id of madeProjects.splice(0)) {
    const units = await admin.from("properties").delete().eq("parent_id", id);
    if (units.error) throw new Error(`cleanup: units of ${id}: ${units.error.message}`);
    const project = await admin.from("properties").delete().eq("id", id);
    if (project.error) throw new Error(`cleanup: project ${id}: ${project.error.message}`);
  }
});

/** A project with one priced unit (A101 at €200.000), for the flows below. */
async function oneUnitProject(admin: SupabaseClient, label: string) {
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");
  const { data: project, error } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-UP-${tag}`,
      kind: "project" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      title: { en: `E2E uplift ${label}` },
    })
    .select("id, reference")
    .single();
  if (error) throw new Error(`project fixture: ${error.message}`);
  madeProjects.push(project!.id);
  const { data: unit, error: unitErr } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `${project!.reference}-A101`,
      kind: "unit" as const,
      parent_id: project!.id,
      property_type: "apartment" as const,
      status: "available" as const,
      block: "A",
      unit_number: "101",
      asking_price: 200000,
    })
    .select("id")
    .single();
  if (unitErr) throw new Error(`unit fixture: ${unitErr.message}`);
  return { project: project!, unitId: unit!.id as string };
}

async function stateOf(admin: SupabaseClient, projectId: string, unitId: string) {
  const { data: unit } = await admin.from("properties").select("asking_price").eq("id", unitId).single();
  const { count: versions } = await admin
    .from("price_lists")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  return { price: Number(unit!.asking_price), versions: versions ?? 0 };
}

test("a project past PostgREST's 1,000 rows: the page reviews every unit, so the database accepts the reprice", async ({
  page,
}) => {
  const admin = svc();
  const { project, unitId } = await oneUnitProject(admin, "1001 units");
  const { orgId } = await fixtureProfile(admin);
  // 1,000 more, unpriced — the database refuses a reprice whose reviewed scope
  // is not the whole scope, so a page that read only the first 1,000 units
  // could never reprice "all units" here; only two units carry a price, so the
  // run writes two price lines, not a thousand
  const more = Array.from({ length: 1000 }, (_, i) => ({
    org_id: orgId,
    reference: `${project.reference}-Z${String(i).padStart(4, "0")}`,
    kind: "unit" as const,
    parent_id: project.id,
    property_type: "apartment" as const,
    status: "available" as const,
    block: "Z",
    unit_number: String(i).padStart(4, "0"),
    asking_price: i === 999 ? 300000 : null,
  }));
  const { error } = await admin.from("properties").insert(more);
  expect(error).toBeNull();

  await page.goto(`/properties/${project.id}/units`);
  await page.locator("#uplift-amount").fill("10");
  await expect(page.getByTestId("uplift-preview")).toContainText("Repricing 2 units");
  await expect(page.getByTestId("uplift-preview")).toContainText("999 unpriced, left alone");
  await page.getByRole("button", { name: /Reprice and record version/ }).click();
  await expect(page.getByText("Prices updated and a new version recorded")).toBeVisible();
  expect(await stateOf(admin, project.id, unitId)).toEqual({ price: 220000, versions: 1 });
});

test("a price edited after the page loaded is never overwritten: refused, nothing changes, the preview redraws", async ({
  page,
}) => {
  const admin = svc();
  const { project, unitId } = await oneUnitProject(admin, "stale");

  await page.goto(`/properties/${project.id}/units`);
  // a block and a fixed amount, not the defaults: a refusal must leave the
  // person's choices exactly as they were (React resets a form after an action
  // it runs from `action`, and the Radix Selects jumped back to "All units ·
  // Percentage" under the typed amount — review of T-price-uplift-atomic)
  await page.locator("#uplift-scope").click();
  await page.getByRole("option", { name: "Block A (1)" }).click();
  await page.locator("#uplift-mode").click();
  await page.getByRole("option", { name: "Fixed amount" }).click();
  await page.locator("#uplift-amount").fill("20000");
  await expect(page.getByTestId("uplift-preview")).toContainText("€220.000");

  // somebody else reprices the unit while this page sits open
  await admin.from("properties").update({ asking_price: 210000 }).eq("id", unitId);

  await page.getByRole("button", { name: /Reprice and record version/ }).click();
  const form = page.locator("form").filter({ has: page.getByTestId("uplift-preview") });
  await expect(form.getByRole("alert")).toContainText("changed since you reviewed them — nothing was changed");
  expect(await stateOf(admin, project.id, unitId)).toEqual({ price: 210000, versions: 0 });

  // the page redrew from the current price — and kept the person's choices: what is
  // shown now is what will be written
  await expect(page.getByTestId("uplift-preview")).toContainText("€210.000 → €230.000");
  await expect(page.locator("#uplift-scope")).toContainText("Block A");
  await expect(page.locator("#uplift-mode")).toContainText("Fixed amount");
  await expect(page.locator("#uplift-amount")).toHaveValue("20000");
  await page.getByRole("button", { name: /Reprice and record version/ }).click();
  await expect(page.getByText("Prices updated and a new version recorded")).toBeVisible();
  expect(await stateOf(admin, project.id, unitId)).toEqual({ price: 230000, versions: 1 });
});

test("an answer lost after the commit: pressing again says it was already saved, and nothing applies twice", async ({
  page,
}) => {
  const admin = svc();
  const { project, unitId } = await oneUnitProject(admin, "lost answer");

  await page.goto(`/properties/${project.id}/units`);
  await page.locator("#uplift-amount").fill("10");
  await expect(page.getByTestId("uplift-preview")).toContainText("€220.000");

  // the server action runs and commits; its answer never reaches the browser
  let dropped = 0;
  await page.route(
    (url) => url.pathname === `/properties/${project.id}/units`,
    async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"] && dropped === 0) {
        dropped += 1;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.fallback();
    },
  );
  await page.getByRole("button", { name: /Reprice and record version/ }).click();
  const form = page.locator("form").filter({ has: page.getByTestId("uplift-preview") });
  await expect(form.getByRole("alert")).toContainText("Could not confirm whether this was saved");
  expect(dropped).toBe(1);
  expect(await stateOf(admin, project.id, unitId), "the first press committed").toEqual({ price: 220000, versions: 1 });

  // the same submission again: answered with the committed version, not applied twice
  await page.unrouteAll({ behavior: "wait" });
  await page.getByRole("button", { name: /Reprice and record version/ }).click();
  await expect(page.getByText("Already saved — this submission recorded price list v1. Nothing was applied twice.")).toBeVisible();
  expect(await stateOf(admin, project.id, unitId)).toEqual({ price: 220000, versions: 1 });
  expect(await eventCount(admin, unitId, "price_changed")).toBe(1);
});
