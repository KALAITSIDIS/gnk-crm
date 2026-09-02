import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The quality publish gate, for an ordinary listing.
 *
 * It has existed since T1.x and had no e2e at all: the only tests of it were
 * the container ones added on 2026-09-02, which cover the OTHER refusal (an
 * empty project) and deliberately assert that no override is consulted. So
 * the path an admin actually uses — a thin but deliberate listing, published
 * on their own authority — was unpinned, including the event that records
 * that authority.
 *
 * That event is the point. A `publish_override` row is the desk's answer to
 * "who put this live below the bar", so it must exist when the listing went
 * public and must never exist when it did not (2026-09-02 guardrail-1 sweep
 * moved it to after the write for exactly that reason).
 */
const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

/** A deliberately thin listing: enough to exist, far below the 70 threshold. */
async function seedThinProperty(admin: SupabaseClient, orgId: string) {
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
      reference: `E2E-GATE-${randomBytes(3).toString("hex")}`,
      kind: "standalone" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      visibility: "private" as const,
      district_id: district!.id,
      title: { en: "E2E publish gate listing" },
    })
    .select("id, reference")
    .single();
  return data!;
}

const detailsForm = (page: import("@playwright/test").Page) =>
  page.locator("form").filter({ has: page.getByLabel(/^visibility$/i) });

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

test("a thin listing is refused, then published on the admin's recorded authority", async ({
  page,
}) => {
  const admin = svc();
  const { orgId } = await fixtureProfile(admin);
  const property = await seedThinProperty(admin, orgId);

  try {
    await page.goto(`/properties/${property.id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^details$/i }).click();

    // 1. refused, and the refusal names the way through
    await savePublic(page, property.id);
    await expect(page.getByText(/below 70/i)).toBeVisible({ timeout: 15_000 });
    const { data: refused } = await admin
      .from("properties")
      .select("visibility")
      .eq("id", property.id)
      .single();
    expect(refused!.visibility, "the refusal is not cosmetic").not.toBe("public");

    // …and no authority was recorded for a publish that did not happen
    const { data: noneYet } = await admin
      .from("events")
      .select("id")
      .eq("entity_id", property.id)
      .eq("event_type", "publish_override");
    expect(noneYet, "an override event must not precede its publish").toEqual([]);

    // 2. the admin overrides, and now it publishes
    const override = detailsForm(page).locator("#publish_override");
    await override.check();
    await expect(override).toBeChecked();
    await savePublic(page, property.id);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(async () => {
        const { data } = await admin
          .from("properties")
          .select("visibility")
          .eq("id", property.id)
          .single();
        return data?.visibility;
      })
      .toBe("public");

    // 3. the authority is on the record, with the score it was exercised over
    const { data: events } = await admin
      .from("events")
      .select("id, event_type, payload")
      .eq("entity_id", property.id)
      .order("id");
    const overrides = (events ?? []).filter((e) => e.event_type === "publish_override");
    expect(overrides, "exactly one override, for one act").toHaveLength(1);
    const payload = overrides[0]!.payload as { score?: number; threshold?: number };
    expect(payload.threshold).toBe(70);
    expect(typeof payload.score).toBe("number");
    expect(payload.score!).toBeLessThan(70);

    // it sits with the save it authorised, not stranded before it
    const updated = (events ?? []).find((e) => e.event_type === "updated");
    expect(updated, "the publish itself is evented").toBeTruthy();
    expect(overrides[0]!.id).toBeLessThan(updated!.id);
  } finally {
    await admin.from("properties").delete().eq("id", property.id);
  }
});
