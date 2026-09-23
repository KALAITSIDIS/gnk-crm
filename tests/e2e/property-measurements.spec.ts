import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The Details form refuses an impossible measurement, names the field, and
 * writes nothing (LST-07; audit 2026-09-23). The whole path: the real form,
 * the real server action, the real database with migration 0113.
 *
 * Reproduced against a321de5, this same form saved floor 9 of a 3-floor
 * building and a 0 m² covered area — while the create wizard refused 0 m².
 * The legitimate cases the rule must not break are saved through the same
 * form afterwards: a basement, blank (unknown) areas, and the zeros that mean
 * something.
 */
const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seedFlat(admin: SupabaseClient, orgId: string) {
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
      reference: `E2E-MEAS-${randomBytes(3).toString("hex")}`,
      kind: "standalone" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      visibility: "private" as const,
      district_id: district!.id,
      title: { en: "E2E measurements" },
      covered_area_sqm: 92,
      floor_number: 2,
      total_floors: 4,
    })
    .select("id, reference")
    .single();
  return data!;
}

const detailsForm = (page: Page) =>
  page.locator("form").filter({ has: page.getByLabel(/^visibility$/i) });

async function saveDetails(page: Page, propertyId: string, values: Record<string, string>) {
  const form = detailsForm(page);
  for (const [name, value] of Object.entries(values)) {
    await form.locator(`input[name="${name}"]`).fill(value);
  }
  const roundTrip = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === `/properties/${propertyId}`,
  );
  await form.getByRole("button", { name: /^save$/i }).click();
  await roundTrip;
}

test("the Details form refuses floor 9 of 3 and a 0 m² area, names the field, and saves the legitimate cases", async ({
  page,
}) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const flat = await seedFlat(admin, orgId);
  const stored = async () =>
    (
      await admin
        .from("properties")
        .select("covered_area_sqm, plot_area_sqm, floor_number, total_floors, bedrooms, parking_spaces, veranda_sqm, updated_at")
        .eq("id", flat.id)
        .single()
    ).data!;
  const eventCount = async () =>
    (
      await admin
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("entity_id", flat.id)
    ).count ?? 0;

  try {
    await page.goto(`/properties/${flat.id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^details$/i }).click();
    const before = await stored();
    const eventsBefore = await eventCount();

    // 1. floor 9 of a 3-floor building — refused on the Floor field's words
    await saveDetails(page, flat.id, { floor_number: "9", total_floors: "3" });
    // scoped to the form: Next's route announcer is a second role="alert"
    await expect(detailsForm(page).getByRole("alert")).toContainText(
      /Floor 9 is above the building's total floors \(3\)/,
      { timeout: 15_000 },
    );
    expect(await stored(), "the refused save wrote nothing").toEqual(before);

    // 2. a 0 m² covered area — refused, with the way out ("leave it blank")
    await saveDetails(page, flat.id, { floor_number: "2", total_floors: "4", covered_area_sqm: "0" });
    await expect(detailsForm(page).getByRole("alert")).toContainText(
      /Covered area must be greater than 0 m² — leave it blank/,
      { timeout: 15_000 },
    );
    expect(await stored(), "the refused save wrote nothing").toEqual(before);
    expect(await eventCount(), "and no event claims it").toBe(eventsBefore);

    // 3. the legitimate cases through the same form: a basement flat, the
    //    covered area now unknown (blank), a studio with no parking/veranda
    await saveDetails(page, flat.id, {
      floor_number: "-1",
      total_floors: "3",
      covered_area_sqm: "",
      bedrooms: "0",
      parking_spaces: "0",
      veranda_sqm: "0",
    });
    await expect(page.getByText(/^saved$/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(detailsForm(page).getByRole("alert")).toHaveCount(0);
    expect(await stored()).toMatchObject({
      floor_number: -1,
      total_floors: 3,
      covered_area_sqm: null, // blank is unknown — never 0
      plot_area_sqm: null,
      bedrooms: 0,
      parking_spaces: 0,
      veranda_sqm: 0,
    });
    expect(await eventCount(), "the one real save is recorded once").toBe(eventsBefore + 1);
  } finally {
    await admin.from("properties").delete().eq("id", flat.id);
  }
});
