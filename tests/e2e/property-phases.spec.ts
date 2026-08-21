import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * Project → phase → unit (BACKLOG audit finding 11).
 *
 * `phase` sat in the enum since 0001 with three read paths branching on it and
 * nothing able to create one. What is worth pinning is not the form but the two
 * properties that make phases worth having at all:
 *
 *   * a phase carries ITS OWN delivery date, and does not follow the project's
 *     — staged handover is the entire reason phases exist; and
 *   * its units inherit the PHASE, not the grandparent project.
 *
 * Plus the boundary: a phase cannot contain a phase.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

test("a phase keeps its own delivery date and its units inherit it", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");

  const { data: district } = await admin
    .from("districts")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();

  const { data: project } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-PH-${tag}`,
      kind: "project" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      district_id: district!.id,
      title: { en: "E2E phased project" },
      vat_status: "new_vat" as const,
      delivery_date: "2028-03-31",
    })
    .select("id, reference")
    .single();

  await page.goto(`/properties/${project!.id}/units`);

  // by id: "Name" and "Expected delivery" also match the payment-plan and
  // details forms on this page
  await page.locator("#phase-code").fill("P1");
  await page.locator("#phase-name").fill("Phase 1");
  await page.locator("#phase-delivery").fill("2027-06-30");
  await page.getByRole("button", { name: /Add phase/ }).click();
  await expect(page.getByText("Phase created")).toBeVisible();

  const { data: phase } = await admin
    .from("properties")
    .select("id, reference, kind, delivery_date, vat_status, property_type, inherited_fields")
    .eq("parent_id", project!.id)
    .eq("kind", "phase")
    .single();

  expect(phase!.reference).toBe(`${project!.reference}-P1`);
  // its OWN date, not the project's
  expect(phase!.delivery_date).toBe("2027-06-30");
  // …and severed, so a project-side sync cannot overwrite it
  expect(phase!.inherited_fields).not.toContain("delivery_date");
  // everything else still follows the project
  expect(phase!.vat_status).toBe("new_vat");
  expect(phase!.property_type).toBe("apartment");
  expect(phase!.inherited_fields).toContain("vat_status");

  // units under the phase inherit the PHASE, not the grandparent
  await page.goto(`/properties/${phase!.id}/units`);
  await expect(page.getByText("A project that hands over in stages")).toHaveCount(0); // no nesting
  await page.locator("#gen-floor-to").fill("1");
  await page.locator("#gen-per-floor").fill("2");
  await page.getByRole("button", { name: /^Generate \d+ units$/ }).click();
  await expect(page.getByText("Units generated")).toBeVisible();

  const { data: units } = await admin
    .from("properties")
    .select("reference, delivery_date")
    .eq("parent_id", phase!.id);

  expect(units).toHaveLength(2);
  for (const u of units!) {
    expect(u.reference).toContain(`${project!.reference}-P1-`);
    expect(u.delivery_date).toBe("2027-06-30"); // the phase's, not 2028
  }

  await admin.from("properties").delete().eq("parent_id", phase!.id);
  await admin.from("properties").delete().eq("id", phase!.id);
  await admin.from("properties").delete().eq("id", project!.id);
});
