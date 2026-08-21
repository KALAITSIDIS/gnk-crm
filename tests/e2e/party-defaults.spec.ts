import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * Party defaults (migration 0038) — the operator's opening request: choosing a
 * developer should fill the form rather than leaving somebody to retype what
 * that developer always works on.
 *
 * The behaviour worth pinning is the LAYERING. A value the party set must win,
 * a value they have no opinion on must fall through to the office standard, and
 * the form must say which — a prefilled number that does not explain itself is
 * one people distrust and retype, which would defeat the point.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

test("choosing an owner fills the mandate from their terms, then the office's", async ({
  page,
}) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");

  const { data: developer } = await admin
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_kind: "company",
      company_name: `Partydef ${tag}`,
      contact_types: ["developer"],
      // 2.5% and 12 months are THEIRS; reminder days is not set, so the office's
      // 30 must show through underneath
      party_defaults: { commission_pct: 2.5, mandate_type: "exclusive", mandate_months: 12 },
    })
    .select("id")
    .single();

  const { data: property } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-PD-${tag}`,
      kind: "standalone" as const,
      property_type: "villa" as const,
      status: "available" as const,
      title: { en: "E2E party defaults villa" },
    })
    .select("id")
    .single();

  await page.goto(`/properties/${property!.id}`);
  await page.getByRole("tab", { name: /Mandate/ }).click();
  await page.getByRole("button", { name: "Add mandate" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Owner contact").fill(`Partydef ${tag}`);
  await dialog.getByRole("button", { name: new RegExp(`Partydef ${tag}`) }).click();

  // the party's own terms win
  await expect(dialog.getByLabel("Commission %")).toHaveValue("2.5");
  // …and it says where they came from
  await expect(dialog.getByText(/Terms filled from/)).toBeVisible();
  // a field they have no opinion on falls through to the office
  await expect(dialog.getByLabel(/Renewal reminder/)).toHaveValue("30");

  // every value stays editable — a default is a suggestion, not a lock
  await dialog.getByLabel("Commission %").fill("4");
  await expect(dialog.getByLabel("Commission %")).toHaveValue("4");

  await admin.from("properties").delete().eq("id", property!.id);
  await admin.from("contacts").delete().eq("id", developer!.id);
});

test("editing an EXISTING mandate is never overwritten by defaults", async ({ page }) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");

  const { data: owner } = await admin
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_kind: "person",
      first_name: "Signed",
      last_name: tag,
      contact_types: ["owner"],
      party_defaults: { commission_pct: 9 },
    })
    .select("id")
    .single();

  const { data: property } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-PDE-${tag}`,
      kind: "standalone" as const,
      property_type: "villa" as const,
      status: "available" as const,
      title: { en: "E2E signed mandate villa" },
    })
    .select("id")
    .single();

  // an agreement that was actually signed at 3%, not this owner's usual 9%
  await admin.from("mandates").insert({
    org_id: orgId,
    property_id: property!.id,
    owner_contact_id: owner!.id,
    type: "open" as const,
    status: "active" as const,
    commission_pct: 3,
  });

  await page.goto(`/properties/${property!.id}`);
  await page.getByRole("tab", { name: /Mandate/ }).click();
  await page.getByRole("button", { name: "Edit" }).click();

  // the mandate on screen is what was SIGNED, not what this owner usually signs
  await expect(page.getByRole("dialog").getByLabel("Commission %")).toHaveValue("3");

  await admin.from("mandates").delete().eq("property_id", property!.id);
  await admin.from("properties").delete().eq("id", property!.id);
  await admin.from("contacts").delete().eq("id", owner!.id);
});
