import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * F03: a public listing with no photograph scores 85 — above the publish
 * threshold — and every screen used to call it healthy. Now:
 *   - its property page says, in VISIBLE text (not a hover tooltip), that it
 *     is public on the website without a cover photo, with "Completeness
 *     85/100" and the gaps linked to the tab each is fixed on — and the link
 *     switches to that tab in place;
 *   - the score ring is a button: Tab reaches it, and its tooltip opens;
 *   - the admin dashboard's Listing health names it under website essentials
 *     and is not green, while saying separately that it scores 70 or more;
 *   - the worklist lists it under "Public without website essentials".
 * Nothing unpublishes it: it is still public afterwards.
 *
 * An isolated listing of the fixture org, seeded through the service role
 * (public straight away, past the gate) with everything but photographs, and
 * deleted at the end with its mandate and owner contact.
 */
const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seed(admin: SupabaseClient, orgId: string, agentId: string) {
  const { data: district } = await admin
    .from("districts")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();
  const { data: owner, error: ownerErr } = await admin
    .from("contacts")
    .insert({ org_id: orgId, first_name: "E2E readiness owner" })
    .select("id")
    .single();
  expect(ownerErr, ownerErr?.message).toBeNull();
  const { data, error } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-READY-${randomBytes(3).toString("hex")}`,
      kind: "standalone" as const,
      property_type: "apartment" as const,
      status: "available" as const,
      visibility: "public" as const,
      published_at: new Date().toISOString(),
      district_id: district!.id,
      title: { en: "E2E readiness flat" },
      public_description: { en: "A bright flat near the sea, close to schools and shops. ".repeat(7) },
      asking_price: 265000,
      covered_area_sqm: 88,
      bedrooms: 2,
      bathrooms: 1,
      location: "SRID=4326;POINT(32.4297 34.7720)",
      location_approx: false,
      title_deed_status: "separate" as const,
      permit_status: "full" as const,
      assigned_agent_id: agentId,
      owner_contact_id: owner!.id,
    })
    .select("id, reference")
    .single();
  expect(error, error?.message).toBeNull();
  const { error: mandateErr } = await admin
    .from("mandates")
    .insert({ org_id: orgId, property_id: data!.id, type: "exclusive" as const, status: "active" as const });
  expect(mandateErr, mandateErr?.message).toBeNull();
  return { ...data!, ownerId: owner!.id };
}

test("a public listing with no photograph is said to be on the website without one — on its page, the dashboard and the worklist", async ({
  page,
}) => {
  const admin = svc();
  const { id: agentId, orgId } = await fixtureProfile(admin);
  const listing = await seed(admin, orgId, agentId);

  try {
    // 1. the property page: visible text, not a tooltip
    await page.goto(`/properties/${listing.id}`, { waitUntil: "networkidle" });
    const panel = page.getByRole("region", { name: "Listing readiness" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Public on the website without: cover photo.");
    await expect(panel).toContainText("Completeness 85/100");
    await expect(panel).toContainText("Clears the publish threshold of 70.");

    // the gap's link switches to the Media tab in place
    // exact: the completeness chip "Cover photo +5" links to the same tab
    await panel.getByRole("link", { name: "cover photo", exact: true }).click();
    await expect(page.getByRole("tab", { name: /^Media/ })).toHaveAttribute("aria-selected", "true");

    // the ring is a button the keyboard reaches, and its tooltip opens on focus
    const ring = page.getByRole("button", { name: /^Quality score 85 of 100/ });
    await expect(ring).toHaveAttribute("type", "button");
    await page.locator("h1").click();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await ring.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Tab reaches the score ring").toBe(true);
    await expect(page.getByRole("tooltip")).toContainText("Missing (2):");

    // 2. the admin dashboard names it under website essentials, apart from completeness
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    const health = page.getByRole("region", { name: /^Listing health/ });
    await expect(health).toHaveAttribute("data-listing-health", "attention");
    await expect(health.locator('[data-line="essentials"]')).toContainText(`${listing.reference} (cover photo)`);
    await expect(health.locator('[data-line="completeness"]')).toContainText("score 70 or more");

    // 3. the worklist lists it first, under its own heading
    await page.goto("/properties/worklist", { waitUntil: "networkidle" });
    const essentials = page.locator("section").filter({ hasText: "Public without website essentials" });
    await expect(essentials).toContainText(listing.reference);
    await expect(essentials.getByRole("link", { name: "cover photo", exact: true }).first()).toHaveAttribute(
      "href",
      new RegExp(`\\?tab=media$`),
    );

    // nothing unpublished it
    const { data: after } = await admin.from("properties").select("visibility").eq("id", listing.id).single();
    expect(after!.visibility).toBe("public");
  } finally {
    await admin.from("mandates").delete().eq("property_id", listing.id);
    await admin.from("properties").delete().eq("id", listing.id);
    await admin.from("contacts").delete().eq("id", listing.ownerId);
  }
});
