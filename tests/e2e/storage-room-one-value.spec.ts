import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * F02: storage room has ONE value (the 'storage_room' feature) and ONE control
 * on the Details tab — the whole path: the real form, the real server action,
 * the real database with migration 0152's trigger, and the public feed the
 * site reads. Before F02 the tab showed two "Storage room" boxes (Areas &
 * rooms → has_storage, Features → storage_room), saved independently; a
 * listing could tell buyer matching one thing and the site another.
 *
 * An isolated, PUBLIC, available listing of the fixture org is seeded with
 * the two values disagreeing the way a pre-0152 row could not survive now
 * (the trigger derives the column, so it is seeded through the feature),
 * ticked, saved, reloaded, read from the database and from
 * /api/public/listings, then unticked — and deleted at the end.
 */
const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seedListing(admin: SupabaseClient, orgId: string) {
  const { data: district } = await admin
    .from("districts")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();
  const { data, error } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-STOR-${randomBytes(3).toString("hex")}`,
      kind: "standalone" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      // public straight away (service role, past the publish gate): the feed
      // is part of what this proves
      visibility: "public" as const,
      published_at: new Date().toISOString(),
      district_id: district!.id,
      title: { en: "E2E storage room" },
      asking_price: 250000,
      covered_area_sqm: 92,
      features: ["sea_view"],
      // a stale writer's value: replaced by the feature's (0152)
      has_storage: true,
    })
    .select("id, reference, has_storage")
    .single();
  expect(error, error?.message).toBeNull();
  return data!;
}

const detailsForm = (page: Page) =>
  page.locator("form").filter({ has: page.getByLabel(/^visibility$/i) });

async function saveDetails(page: Page, propertyId: string) {
  const form = detailsForm(page);
  const roundTrip = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === `/properties/${propertyId}`,
  );
  await form.getByRole("button", { name: /^save$/i }).click();
  await roundTrip;
  await expect(page.getByText(/^saved$/i).first()).toBeVisible({ timeout: 15_000 });
}

test("the Details tab has one Storage room control, and the database, the event and the public feed follow it", async ({
  page,
  request,
}) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const { data: org } = await admin.from("organizations").select("slug").eq("id", orgId).single();
  const listing = await seedListing(admin, orgId);
  expect(listing.has_storage, "the database derived the column from the feature at insert").toBe(false);

  const stored = async () =>
    (
      await admin
        .from("properties")
        .select("has_storage, features")
        .eq("id", listing.id)
        .single()
    ).data!;
  const lastUpdated = async () =>
    (
      await admin
        .from("events")
        .select("payload")
        .eq("entity_id", listing.id)
        .eq("event_type", "updated")
        .order("occurred_at", { ascending: false })
        .limit(1)
        .single()
    ).data!.payload as { changed: Record<string, unknown> };
  const onFeed = async () => {
    const res = await request.get(
      `/api/public/listings?org=${encodeURIComponent(org!.slug)}&reference=${encodeURIComponent(listing.reference)}`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { listings: { reference: string; has_storage: boolean | null; features: string[] }[] };
    expect(body.listings).toHaveLength(1);
    return body.listings[0]!;
  };

  try {
    await page.goto(`/properties/${listing.id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^details$/i }).click();

    // ONE control under that label — the Features box — and it is unticked
    // (the feature is absent, whatever the column was sent)
    const box = detailsForm(page).getByLabel("Storage room", { exact: true });
    await expect(box).toHaveCount(1);
    await expect(box).not.toBeChecked();
    await expect(detailsForm(page).locator('[name="has_storage"], #has_storage')).toHaveCount(0);

    // tick → save → reload → still ticked; both values true; the event says so; the feed says so
    await box.click();
    await saveDetails(page, listing.id);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^details$/i }).click();
    await expect(detailsForm(page).getByLabel("Storage room", { exact: true })).toBeChecked();
    expect(await stored()).toEqual({ has_storage: true, features: ["sea_view", "storage_room"] });
    const ticked = await lastUpdated();
    expect(ticked.changed.has_storage).toEqual({ from: false, to: true });
    expect(ticked.changed.features).toEqual({ from: ["sea_view"], to: ["sea_view", "storage_room"] });
    expect(await onFeed()).toMatchObject({ has_storage: true, features: ["sea_view", "storage_room"] });

    // untick → everything false again
    await detailsForm(page).getByLabel("Storage room", { exact: true }).click();
    await saveDetails(page, listing.id);
    expect(await stored()).toEqual({ has_storage: false, features: ["sea_view"] });
    expect((await lastUpdated()).changed.has_storage).toEqual({ from: true, to: false });
    expect(await onFeed()).toMatchObject({ has_storage: false, features: ["sea_view"] });
  } finally {
    await admin.from("properties").delete().eq("id", listing.id);
  }
});
