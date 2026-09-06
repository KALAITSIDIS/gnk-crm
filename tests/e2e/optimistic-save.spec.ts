import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * A section save refuses when the row moved since the page rendered (the
 * audit's A06, lib/services/optimistic-save.ts).
 *
 * Two people share this desk. Until 2026-09-06 the second of two overlapping
 * edits silently undid the first, and the timeline recorded both as ordinary
 * updates. The page now carries the row's own updated_at into the form; the
 * action refuses — before it does anything — when the row is not where the
 * page left it, and the person is told to reload. This is the whole path,
 * through the real form and the real trigger.
 */
const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seedProperty(admin: SupabaseClient, orgId: string) {
  const { data: district } = await admin
    .from("districts")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();
  const { data } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-STALE-${randomBytes(3).toString("hex")}`,
      kind: "standalone" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      visibility: "private" as const,
      district_id: district!.id,
      title: { en: "E2E optimistic save" },
    })
    .select("id, reference, updated_at")
    .single();
  return data!;
}

const detailsForm = (page: import("@playwright/test").Page) =>
  page.locator("form").filter({ has: page.getByLabel(/^visibility$/i) });

/** Change visibility to public and submit — the details section's save. */
async function savePublic(page: import("@playwright/test").Page, propertyId: string) {
  await page.getByLabel(/^visibility$/i).click();
  await page.getByRole("option", { name: /^public$/i }).click();
  const roundTrip = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === `/properties/${propertyId}`,
  );
  await detailsForm(page).getByRole("button", { name: /^save$/i }).click();
  await roundTrip;
}

test("a save from a page the row has moved under is refused, and goes through after a reload", async ({
  page,
}) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const property = await seedProperty(admin, orgId);

  try {
    await page.goto(`/properties/${property.id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^details$/i }).click();

    // the form carries the row's own timestamp, verbatim
    const carried = await detailsForm(page)
      .locator('input[name="expected_updated_at"]')
      .inputValue();
    expect(carried, "the hidden expectation is the row's updated_at").toBe(property.updated_at);

    // somebody else saves the row while this page is open (the trigger moves updated_at)
    await admin
      .from("properties")
      .update({ amenities_notes: "edited by the other desk" })
      .eq("id", property.id);
    const { data: moved } = await admin
      .from("properties")
      .select("updated_at")
      .eq("id", property.id)
      .single();
    expect(moved!.updated_at).not.toBe(property.updated_at);

    // 1. refused — and refused BEFORE the publish gate, which would otherwise
    //    have answered "below 70" for this thin listing
    await savePublic(page, property.id);
    await expect(page.getByRole("alert")).toContainText(/changed since you opened it/i, {
      timeout: 15_000,
    });
    await expect(page.getByText(/below 70/i)).toHaveCount(0);
    const { data: untouched } = await admin
      .from("properties")
      .select("visibility, amenities_notes")
      .eq("id", property.id)
      .single();
    expect(untouched!.visibility, "the stale save wrote nothing").toBe("private");
    expect(untouched!.amenities_notes, "and the other desk's edit survived").toBe(
      "edited by the other desk",
    );

    // 2. reloaded, the page carries the new timestamp and the save proceeds —
    //    into the publish gate, which is the next thing that can refuse it
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^details$/i }).click();
    await expect(detailsForm(page).locator('input[name="expected_updated_at"]')).toHaveValue(
      moved!.updated_at,
    );
    await savePublic(page, property.id);
    await expect(page.getByText(/below 70/i)).toBeVisible({ timeout: 15_000 });
  } finally {
    await admin.from("properties").delete().eq("id", property.id);
  }
});
