import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The contact Properties tab (BACKLOG audit finding 9).
 *
 * The thing worth pinning is the SHAPING, not that a tab renders. A developer
 * with a 60-unit project must produce one row and a rollup, not sixty rows —
 * the same call the properties list makes about units by default. And a contact
 * who both owns and built something must be shown as both, counted once.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

test("a developer's project is one row with its units rolled up", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");

  const { data: contact } = await admin
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_kind: "company",
      company_name: `E2E Developer ${tag}`,
      contact_types: ["developer"],
    })
    .select("id")
    .single();

  const { data: project } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-POR-${tag}`,
      kind: "project" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      title: { en: "E2E portfolio project" },
      developer_contact_id: contact!.id,
      // also the owner, which a developer is on everything unsold
      owner_contact_id: contact!.id,
    })
    .select("id, reference")
    .single();

  await admin.from("properties").insert(
    Array.from({ length: 8 }, (_, i) => ({
      org_id: orgId,
      reference: `${project!.reference}-U${i}`,
      kind: "unit" as const,
      parent_id: project!.id,
      property_type: "apartment" as const,
      status: i < 3 ? ("sold" as const) : ("available" as const),
      asking_price: 200000,
      developer_contact_id: contact!.id,
    })),
  );

  await page.goto(`/contacts/${contact!.id}`);

  // ONE property, not nine — the tab count is the promise the panel keeps
  await expect(page.getByRole("tab", { name: "Properties (1)" })).toBeVisible();
  await page.getByRole("tab", { name: /Properties/ }).click();

  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText(project!.reference, { exact: true })).toBeVisible();
  await expect(panel.getByText("8 units")).toBeVisible();
  await expect(panel.getByText(/3 sold/)).toBeVisible();
  await expect(panel.getByText(/5 available/)).toBeVisible();

  // owner AND developer on the same property, named as both and counted once
  await expect(panel.getByText(/Owns & Built/)).toBeVisible();

  await admin.from("properties").delete().eq("parent_id", project!.id);
  await admin.from("properties").delete().eq("id", project!.id);
  await admin.from("contacts").delete().eq("id", contact!.id);
});

test("a contact with nothing says so rather than showing an empty table", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);

  const { data: contact } = await admin
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_kind: "person",
      first_name: "Empty",
      last_name: randomBytes(3).toString("hex"),
      contact_types: ["buyer"],
    })
    .select("id")
    .single();

  await page.goto(`/contacts/${contact!.id}`);
  await expect(page.getByRole("tab", { name: "Properties (0)" })).toBeVisible();
  await page.getByRole("tab", { name: /Properties/ }).click();
  await expect(page.getByText("Nothing recorded against this contact yet")).toBeVisible();

  await admin.from("contacts").delete().eq("id", contact!.id);
});
