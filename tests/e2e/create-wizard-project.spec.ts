import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The wizard learns what a project is (2026-09-02).
 *
 * The incident: a development was entered through this wizard, which asked
 * it for a villa's bedrooms, never mentioned units, and dropped it on the
 * overview page — where it scored 100/100 and went public with nothing in
 * it. Now step 2 for a project asks how it is LAID OUT, creates the units in
 * the same submit, and lands on the units matrix.
 *
 * The write path is shared with the units-matrix generator
 * (lib/services/unit-writer.ts), so this pins the WIZARD's half: the branch,
 * the preview, the landing, and that the units really arrived.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function pick(page: import("@playwright/test").Page, label: string, option: RegExp) {
  await page.getByLabel(label).click();
  await page.getByRole("option", { name: option }).click();
}

/**
 * Every project this file may create, by its EN title, registered BEFORE the
 * submit. `afterEach` deletes by title, so a test that died between "Create"
 * and learning the id still leaves nothing behind. Units go first —
 * `properties.parent_id` is ON DELETE RESTRICT. The inline deletes in the
 * tests stay: this is the safety net, not the happy path.
 */
const createdTitles: string[] = [];

test.afterEach(async () => {
  if (createdTitles.length === 0) return;
  const admin = svc();
  for (const title of createdTitles.splice(0)) {
    const { data: rows } = await admin.from("properties").select("id").eq("title->>en", title);
    for (const row of rows ?? []) {
      await admin.from("properties").delete().eq("parent_id", row.id);
      await admin.from("properties").delete().eq("id", row.id);
    }
  }
});

/** Step 1 for a development of the given type, through to the layout step. */
async function beginDevelopment(page: import("@playwright/test").Page, propertyType: RegExp) {
  await page.goto("/properties/new", { waitUntil: "networkidle" });
  await pick(page, "Kind", /A development with units/);
  await expect(page.getByText(/asks how it is laid out/i)).toBeVisible();
  await pick(page, "Property type", propertyType);
  await pick(page, "District", /Paphos/);
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByText(/2\. Development layout/)).toBeVisible();
}

test("a villa development is created WITH its villas and lands on the units matrix", async ({
  page,
}) => {
  const admin = svc();
  await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");
  const title = `Wizard complex ${tag}`;
  createdTitles.push(title);

  await page.goto("/properties/new", { waitUntil: "networkidle" });

  // step 1: choose the development kind directly — its label says what comes next
  await pick(page, "Kind", /A development with units/);
  await expect(page.getByText(/asks how it is laid out/i)).toBeVisible();
  await pick(page, "Property type", /^Villa$/);
  await pick(page, "District", /Paphos/);
  await page.getByRole("button", { name: /Continue/ }).click();

  // step 2 is the DEVELOPMENT's step 2: no bedrooms for the container, and a
  // layout section that defaults to villas for a villa project
  await expect(page.getByText(/2\. Development layout/)).toBeVisible();
  await expect(page.getByLabel(/^Bedrooms$/)).toHaveCount(0);
  await expect(page.getByLabel(/^Covered area/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Villas$/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByLabel("Title (EN)").fill(title);
  await page.locator("#gen_villa_count").fill("3");
  await page.locator("#gen_villa_prefix").fill("V");
  await page.locator("#gen_bedrooms").fill("4");
  await page.locator("#gen_plot_area_sqm").fill("520");
  await page.locator("#gen_base_price").fill("800000");
  await page.locator("#gen_price_step").fill("25000");

  // the preview is the same function the action writes with
  const preview = page.getByTestId("wizard-units-preview");
  await expect(preview).toContainText("Creates 3 villas");
  await expect(preview).toContainText("V01");
  await expect(preview).toContainText("V03");

  await page.getByRole("button", { name: /Create project \+ 3 villas/ }).click();

  // lands on the matrix, not the overview
  await page.waitForURL(/\/properties\/[0-9a-f-]{36}\/units$/);
  const projectId = page.url().match(/properties\/([0-9a-f-]{36})\/units/)![1];

  const { data: project } = await admin
    .from("properties")
    .select("kind, reference, bedrooms, covered_area_sqm")
    .eq("id", projectId)
    .single();
  expect(project!.kind).toBe("project");
  // the container carries no dwelling fields — those went to the units
  expect(project!.bedrooms).toBeNull();
  expect(project!.covered_area_sqm).toBeNull();

  const { data: villas } = await admin
    .from("properties")
    .select("reference, unit_number, floor_number, bedrooms, plot_area_sqm, asking_price, kind")
    .eq("parent_id", projectId)
    .order("unit_number");
  expect(villas!.map((v) => v.reference)).toEqual([
    `${project!.reference}-V01`,
    `${project!.reference}-V02`,
    `${project!.reference}-V03`,
  ]);
  expect(villas!.every((v) => v.kind === "unit")).toBe(true);
  expect(villas!.every((v) => v.floor_number === null), "villas have no floor").toBe(true);
  expect(villas!.every((v) => v.bedrooms === 4)).toBe(true);
  expect(villas!.every((v) => Number(v.plot_area_sqm) === 520)).toBe(true);
  expect(villas!.map((v) => Number(v.asking_price))).toEqual([800000, 825000, 850000]);

  // the matrix shows them, and the empty-state warning is gone
  await expect(page.getByText(`${project!.reference}-V01`)).toBeVisible();
  await expect(page.getByText(/Not a listing until it has units/)).toHaveCount(0);

  await admin.from("properties").delete().eq("parent_id", projectId);
  await admin.from("properties").delete().eq("id", projectId);
});

test("one property still lands on its own page — the project branch is not a regression", async ({
  page,
}) => {
  const admin = svc();
  await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");
  const title = `Wizard single ${tag}`;
  createdTitles.push(title);

  await page.goto("/properties/new", { waitUntil: "networkidle" });
  await expect(page.getByLabel("Kind")).toContainText("One property");
  await pick(page, "Property type", /^Apartment$/);
  await pick(page, "District", /Paphos/);
  await page.getByRole("button", { name: /Continue/ }).click();

  await expect(page.getByText(/2\. Core details/)).toBeVisible();
  // a single property IS asked for its rooms; no layout section appears
  await expect(page.getByLabel(/^Bedrooms$/)).toBeVisible();
  await expect(page.getByTestId("wizard-units-preview")).toHaveCount(0);

  await page.getByLabel("Title (EN)").fill(title);
  await page.getByRole("button", { name: /^Create property$/ }).click();
  await page.waitForURL(/\/properties\/[0-9a-f-]{36}$/);

  const { data: created } = await admin
    .from("properties")
    .select("id")
    .eq("title->>en", title)
    .single();
  await admin.from("properties").delete().eq("id", created!.id);
});

/**
 * The floors branch — the one an apartment block takes. Labels compose as
 * block + floor + two-digit index (A101 … A302), every unit carries its floor,
 * and the price climbs a floor at a time from the base. The floor range and
 * the toggle have their own tests below because both failed silently once:
 * a half-filled range produced no units and still submitted, and switching
 * to villas carried the "floors to" value into the plot area, since both
 * inputs sat in the same slot of the grid.
 */
test("an apartment block is created WITH its floors", async ({ page }) => {
  const admin = svc();
  await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");
  const title = `Wizard block ${tag}`;
  createdTitles.push(title);

  await beginDevelopment(page, /^Apartment$/);

  // an apartment project stacks, so the layout defaults to floors
  await expect(page.getByRole("button", { name: /^Floors$/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: /^Villas$/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.getByLabel("Title (EN)").fill(title);
  await page.locator("#gen_block").fill("A");
  await page.locator("#gen_floor_from").fill("1");
  await page.locator("#gen_floor_to").fill("3");
  await page.locator("#gen_per_floor").fill("2");
  await page.locator("#gen_bedrooms").fill("2");
  await page.locator("#gen_base_price").fill("200000");
  await page.locator("#gen_price_step").fill("5000");

  // the preview is the same function the action writes with
  const preview = page.getByTestId("wizard-units-preview");
  await expect(preview).toContainText("Creates 6 units");
  await expect(preview).toContainText("A101");
  await expect(preview).toContainText("A302");
  // base on floor 1, two steps up by floor 3 (formatMoney's separator is not the point)
  await expect(preview).toContainText(/€200[.,]000 to €210[.,]000/);

  await page.getByRole("button", { name: /^Create project \+ 6 units$/ }).click();

  // lands on the matrix, not the overview
  await page.waitForURL(/\/properties\/[0-9a-f-]{36}\/units$/);
  const projectId = page.url().match(/properties\/([0-9a-f-]{36})\/units/)![1];

  const { data: project } = await admin
    .from("properties")
    .select("kind, reference, bedrooms, covered_area_sqm")
    .eq("id", projectId)
    .single();
  expect(project!.kind).toBe("project");
  // the container carries no dwelling fields — those went to the units
  expect(project!.bedrooms).toBeNull();
  expect(project!.covered_area_sqm).toBeNull();

  const { data: units } = await admin
    .from("properties")
    .select("reference, floor_number, bedrooms, asking_price, kind, visibility")
    .eq("parent_id", projectId)
    .order("reference");
  expect(units!.map((u) => u.reference)).toEqual([
    `${project!.reference}-A101`,
    `${project!.reference}-A102`,
    `${project!.reference}-A201`,
    `${project!.reference}-A202`,
    `${project!.reference}-A301`,
    `${project!.reference}-A302`,
  ]);
  expect(units!.map((u) => u.floor_number)).toEqual([1, 1, 2, 2, 3, 3]);
  expect(units!.every((u) => u.bedrooms === 2)).toBe(true);
  expect(units!.map((u) => Number(u.asking_price))).toEqual([
    200000, 200000, 205000, 205000, 210000, 210000,
  ]);
  expect(units!.every((u) => u.kind === "unit")).toBe(true);
  expect(units!.every((u) => u.visibility === "private")).toBe(true);

  // the matrix shows them (as links — the generator form below previews the
  // same label text, so the row's link is the unambiguous locator), and the
  // empty-state warning is gone
  await expect(page.getByRole("link", { name: `${project!.reference}-A101` })).toBeVisible();
  await expect(page.getByText(/Not a listing until it has units/)).toHaveCount(0);

  await admin.from("properties").delete().eq("parent_id", projectId);
  await admin.from("properties").delete().eq("id", projectId);
});

/**
 * A unit's TYPE follows the layout, not what the development calls itself:
 * a "building" is a development of apartments, and stamping "building" on
 * every flat (which the first cut did) mis-typed them for matching and for
 * every list (2026-09-02 review, critic pass).
 */
test("a building's units are apartments, not buildings", async ({ page }) => {
  const admin = svc();
  await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");
  const title = `Wizard building ${tag}`;
  createdTitles.push(title);

  await beginDevelopment(page, /^Building$/);
  await page.getByLabel("Title (EN)").fill(title);
  // a building is not an apartment, so the layout does not default to floors
  // by type — say so explicitly, then describe one floor
  await page.getByRole("button", { name: /^Floors$/ }).click();
  await page.locator("#gen_block").fill("B");
  await page.locator("#gen_floor_from").fill("1");
  await page.locator("#gen_floor_to").fill("1");
  await page.locator("#gen_per_floor").fill("2");
  await expect(page.getByTestId("wizard-units-preview")).toContainText("Creates 2 units");
  await page.getByRole("button", { name: /^Create project \+ 2 units$/ }).click();
  await page.waitForURL(/\/properties\/[0-9a-f-]{36}\/units$/);
  const projectId = page.url().match(/properties\/([0-9a-f-]{36})\/units/)![1];

  const { data: project } = await admin
    .from("properties")
    .select("property_type")
    .eq("id", projectId)
    .single();
  expect(project!.property_type, "the development keeps its own type").toBe("building");

  const { data: units } = await admin
    .from("properties")
    .select("property_type")
    .eq("parent_id", projectId);
  expect(units!.length).toBe(2);
  expect(units!.every((u) => u.property_type === "apartment"), "its units are flats").toBe(true);

  await admin.from("properties").delete().eq("parent_id", projectId);
  await admin.from("properties").delete().eq("id", projectId);
});

test("toggling Floors → Villas does not carry a floor into the plot area", async ({ page }) => {
  await beginDevelopment(page, /^Apartment$/);

  // The floors grid and the villas grid put a number input in the same slot:
  // "floors to" on one side, "plot m²" on the other. An uncontrolled input
  // there kept its DOM value across the switch, so a 5-floor block became a
  // 5 m² plot without anyone typing it.
  await page.locator("#gen_floor_to").fill("5");
  await page.getByRole("button", { name: /^Villas$/ }).click();
  await expect(page.getByRole("button", { name: /^Villas$/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await expect(page.locator("#gen_plot_area_sqm")).toHaveValue("");
  await expect(page.locator("#gen_villa_count")).toHaveValue("");
  await expect(page.getByTestId("wizard-units-preview")).not.toContainText(/Creates \d+/);
  // nothing submitted, nothing to clean up
});

test("a half-filled floor range is refused before submit", async ({ page }) => {
  await beginDevelopment(page, /^Apartment$/);

  // "Floors from" alone is neither "no units" (blank means add them later)
  // nor a range: the wizard must say so and hold the submit, rather than
  // create an empty project that lands on the units page looking finished.
  await page.locator("#gen_floor_from").fill("1");

  await expect(page.getByTestId("wizard-units-preview")).toContainText(
    "That floor range produces no units",
  );
  await expect(page.getByRole("button", { name: /Create project/ })).toBeDisabled();
  // nothing submitted, nothing to clean up
});
