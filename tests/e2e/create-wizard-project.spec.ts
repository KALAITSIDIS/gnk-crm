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

test("a villa development is created WITH its villas and lands on the units matrix", async ({
  page,
}) => {
  const admin = svc();
  await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");
  const title = `Wizard complex ${tag}`;

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
