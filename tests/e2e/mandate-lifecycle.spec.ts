import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * Mandate renewal and exclusivity (BACKLOG audit findings 6, 7 and 8).
 *
 * What is worth pinning here is not the buttons — it is the two rules that
 * protect the number the business gets paid on:
 *
 *   * ONE ACTIVE MANDATE PER PROPERTY, enforced by a partial unique index
 *     (0036). Two exclusives with different commission rates could otherwise
 *     coexist and the UI would show one of them arbitrarily.
 *   * AN ACTIVE MANDATE NAMES SOMEBODY. A contract with no counterparty is
 *     worth 10 points on the quality score and nothing in a dispute.
 *
 * The renewal chain matters for a third reason: this app's evidence is a hash
 * chain, and "were we on an exclusive in March" should be answerable from the
 * data rather than by reading dates and guessing.
 */

const svc = (): SupabaseClient => serviceClient();

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seedPropertyWithOwner(admin: SupabaseClient, orgId: string) {
  const tag = randomBytes(3).toString("hex");
  const { data: owner } = await admin
    .from("contacts")
    .insert({
      org_id: orgId,
      contact_kind: "person",
      first_name: "Mandate",
      last_name: tag,
      contact_types: ["owner"],
    })
    .select("id")
    .single();

  const { data: property } = await admin
    .from("properties")
    .insert({
      org_id: orgId,
      reference: `E2E-MAN-${tag}`,
      kind: "standalone" as const,
      property_type: "villa" as const,
      status: "available" as const,
      title: { en: "E2E mandate villa" },
    })
    .select("id")
    .single();

  return { propertyId: property!.id as string, ownerId: owner!.id as string };
}

async function openMandateTab(page: import("@playwright/test").Page, propertyId: string) {
  await page.goto(`/properties/${propertyId}`);
  await page.getByRole("tab", { name: /Mandate/ }).click();
}

test.describe("mandate lifecycle", () => {
  test("a mandate naming nobody cannot be activated", async ({ page }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const { propertyId } = await seedPropertyWithOwner(admin, orgId);

    await admin.from("mandates").insert({
      org_id: orgId,
      property_id: propertyId,
      type: "exclusive" as const,
      status: "draft" as const,
      commission_pct: 4,
      owner_contact_id: null,
    });

    await openMandateTab(page, propertyId);
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByText("Add the owner contact before activating")).toBeVisible();

    // the guard is the assertion, not the toast
    const { data: after } = await admin
      .from("mandates")
      .select("status")
      .eq("property_id", propertyId)
      .single();
    expect(after!.status).toBe("draft");

    await admin.from("mandates").delete().eq("property_id", propertyId);
    await admin.from("properties").delete().eq("id", propertyId);
  });

  test("renewing carries the terms forward and cannot go live beside its predecessor", async ({
    page,
  }) => {
    const admin = svc();
    const { orgId } = await fixtureProfile(admin);
    const { propertyId, ownerId } = await seedPropertyWithOwner(admin, orgId);

    const { data: original } = await admin
      .from("mandates")
      .insert({
        org_id: orgId,
        property_id: propertyId,
        type: "exclusive" as const,
        status: "active" as const,
        commission_pct: 3.5,
        owner_contact_id: ownerId,
        // a window still OPEN, so this exercises the realistic case: renewing
        // an active mandate early, where the successor starts as the old one ends
        start_date: "2026-06-01",
        expiry_date: "2026-12-01",
      })
      .select("id")
      .single();

    await openMandateTab(page, propertyId);
    await page.getByRole("button", { name: "Renew" }).click();
    await expect(page.getByText("Renewal drafted")).toBeVisible();

    const { data: mandates } = await admin
      .from("mandates")
      .select("id, status, type, commission_pct, owner_contact_id, renewed_from_id, start_date, expiry_date, signed_document_id")
      .eq("property_id", propertyId)
      .order("created_at");
    expect(mandates).toHaveLength(2);

    const successor = mandates!.find((m) => m.renewed_from_id !== null)!;
    expect(successor.status).toBe("draft"); // never born active
    expect(successor.type).toBe("exclusive");
    expect(Number(successor.commission_pct)).toBe(3.5);
    expect(successor.owner_contact_id).toBe(ownerId);
    expect(successor.renewed_from_id).toBe(original!.id);
    // the same 183-day window, starting exactly when the old one ends — so an
    // early renewal never produces two live windows over one property
    expect(successor.start_date).toBe("2026-12-01");
    expect(successor.expiry_date).toBe("2027-06-02");
    // a renewal is a new agreement and needs its own signature
    expect(successor.signed_document_id).toBeNull();

    // Activating it while the predecessor is live must be refused — this is the
    // rule that stops two commission rates being live over one property.
    await page.reload();
    await page.getByRole("tab", { name: /Mandate/ }).click();
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByText("already has an active mandate")).toBeVisible();

    const { data: stillOne } = await admin
      .from("mandates")
      .select("id")
      .eq("property_id", propertyId)
      .eq("status", "active");
    expect(stillOne).toHaveLength(1);

    await admin.from("mandates").delete().eq("property_id", propertyId);
    await admin.from("properties").delete().eq("id", propertyId);
  });
});
