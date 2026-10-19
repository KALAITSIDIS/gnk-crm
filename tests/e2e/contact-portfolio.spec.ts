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
      // a "from" price: F04 — it must NOT be added on top of the units
      asking_price: 150000,
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
  // F04 review: an archived unit of the project. Its units page lists no
  // archived unit, so the contact page must name it — and count it nowhere else
  const { data: archivedUnit } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `${project!.reference}-U9`,
      kind: "unit" as const,
      parent_id: project!.id,
      property_type: "apartment" as const,
      status: "available" as const,
      visibility: "archived" as const,
      asking_price: 990000,
      developer_contact_id: contact!.id,
    })
    .select("id, reference")
    .single();

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

  // F04: the total is the units' 8 × 200,000 — not that plus the project's
  // 150,000 "from" price (which read 1,750,000)
  const total = panel
    .locator("dt", { hasText: "Asking total (listings + units)" })
    .locator("xpath=following-sibling::dd[1]");
  await expect(total).toHaveText("€1.600.000");

  // the archived unit: outside the 8 and the total above, but named and linked
  const archived = panel.locator("details", { hasText: "Archived — not counted" });
  await expect(archived.locator("summary")).toHaveText("Archived — not counted (1)");
  await archived.locator("summary").click();
  const group = archived.getByTestId("portfolio-archived-units");
  await expect(group).toContainText(`1 archived unit of ${project!.reference}`);
  await expect(group.getByRole("link", { name: archivedUnit!.reference, exact: true })).toHaveAttribute(
    "href",
    `/properties/${archivedUnit!.id}`,
  );

  await admin.from("properties").delete().eq("parent_id", project!.id);
  await admin.from("properties").delete().eq("id", project!.id);
  await admin.from("contacts").delete().eq("id", contact!.id);
});

test("a landlord's rentals are not 'without an asking price' (F04 review)", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");

  const { data: contact } = await admin
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_kind: "person",
      first_name: "Landlord",
      last_name: tag,
      contact_types: ["owner"],
    })
    .select("id")
    .single();

  const { data: rentals } = await admin
    .from("properties")
    .insert(
      [0, 1].map((i) => ({
        org_id: orgId,
        reference: `E2E-RNT-${tag}-${i}`,
        kind: "standalone" as const,
        property_type: "apartment" as const,
        transaction_type: "rent" as const,
        status: "available" as const,
        rent_price_month: 1200,
        owner_contact_id: contact!.id,
      })),
    )
    .select("id");

  try {
    await page.goto(`/contacts/${contact!.id}`);
    await expect(page.getByRole("tab", { name: "Properties (2)" })).toBeVisible();
    await page.getByRole("tab", { name: /Properties/ }).click();

    const total = page
      .getByRole("tabpanel")
      .locator("dt", { hasText: "Asking total (listings + units)" })
      .locator("xpath=following-sibling::dd[1]");
    // a rental asks a monthly rent: nothing is missing, and the total says it leaves them out
    await expect(total).toContainText("2 for rent only, not in this total");
    await expect(total).not.toContainText("without an asking price");
  } finally {
    await admin
      .from("properties")
      .delete()
      .in("id", (rentals ?? []).map((r) => r.id));
    await admin.from("contacts").delete().eq("id", contact!.id);
  }
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
