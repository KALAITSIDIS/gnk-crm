import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The duplicate guard on property creation (BACKLOG audit finding 13).
 *
 * Two things must both hold, and the second is the one people get wrong:
 * it WARNS, and it does NOT BLOCK. Two genuinely different units share a
 * building, and a guard that refuses them is a guard people learn to work
 * around — so the submit button stays enabled and the decision stays with the
 * person entering the record.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

test("warns about an existing property at the same address, and still lets you proceed", async ({
  page,
}) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const tag = randomBytes(3).toString("hex");
  const address = `${tag} Poseidonos Avenue`;

  const { data: district } = await admin
    .from("districts")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();

  const { data: existing } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-DUP-${tag}`,
      kind: "standalone" as const,
      property_type: "villa" as const,
      status: "available" as const,
      district_id: district!.id,
      title: { en: "E2E duplicate villa" },
      address,
    })
    .select("id, reference")
    .single();

  await page.goto("/properties/new");

  await page.getByLabel("Property type").click();
  await page.getByRole("option", { name: "Villa", exact: true }).click();
  await page.getByLabel("District").click();
  await page.getByRole("option", { name: (district!.name as { en?: string }).en! }).click();
  await page.getByRole("button", { name: /Continue/ }).click();

  // the same address written differently — punctuation and "Ave" are noise
  await page.getByLabel("Address").fill(`${tag}, poseidonos ave.`);

  const warning = page.getByText("is already at this address");
  await expect(warning).toBeVisible();
  await expect(page.getByRole("link", { name: existing!.reference })).toBeVisible();

  // WARN, NOT BLOCK — the whole point of the finding
  await expect(page.getByRole("button", { name: /Create property/ })).toBeEnabled();

  // a different house number on the same street is a different property
  await page.getByLabel("Address").fill(`${tag}9 Poseidonos Avenue`);
  await expect(warning).toBeHidden();

  await admin.from("properties").delete().eq("id", existing!.id);
});
