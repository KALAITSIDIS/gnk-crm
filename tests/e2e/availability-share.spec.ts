import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { isLocal, serviceClient } from "./helpers";

/**
 * Project availability links (migration 0041), the companion to
 * `share-links.spec.ts`.
 *
 * Same reason for existing: RLS test 29 asserts the allowlist in SQL, and this
 * asserts what actually reaches the DOM, because that is what a developer or a
 * partner agent sees. Two things are specific to this kind:
 *
 *  1. `status` IS on the page — that is the product. So the leak assertions
 *     have to be about the fields that still must not appear, and the presence
 *     assertions have to prove the widening actually happened.
 *  2. The project is PHASED. Its units hang off the phase, so a naive
 *     `parent_id` query renders an empty matrix; this test fails loudly if the
 *     descendant walk ever regresses to a child query.
 */

const SECRET_NOTE = "E2E-AVAIL-NOTE-MUST-NOT-LEAK";
const OWNER_NET = 111111;
const MIN_PRICE = 222222;

const svc = (): SupabaseClient => serviceClient();
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

async function seedAvailability(admin: SupabaseClient) {
  const { data: profile } = await admin
    .from("profiles")
    .select("id, org_id")
    .eq("email", "admin@gnk.local")
    .single();
  const org = profile!.org_id;
  const tag = randomBytes(3).toString("hex");
  const ref = (s: string) => `E2E-AVL-${tag}${s}`;

  const { data: project } = await admin
    .from("properties")
    .insert({
      org_id: org,
      reference: ref(""),
      kind: "project",
      property_type: "apartment",
      title: { en: "E2E phased development" },
      delivery_date: "2028-03-31",
      internal_notes: SECRET_NOTE,
      owner_net_price: OWNER_NET,
      min_acceptable_price: MIN_PRICE,
    })
    .select("id")
    .single();

  const { data: phase } = await admin
    .from("properties")
    .insert({
      org_id: org,
      reference: ref("-P1"),
      kind: "phase",
      parent_id: project!.id,
      property_type: "apartment",
      title: { en: "E2E phase one" },
      // its OWN date, severed from the project — the reason phases exist
      delivery_date: "2029-09-30",
    })
    .select("id")
    .single();

  const { data: units } = await admin
    .from("properties")
    .insert([
      {
        org_id: org,
        reference: ref("-P1-A101"),
        kind: "unit",
        parent_id: phase!.id,
        property_type: "apartment",
        status: "available",
        block: "A",
        unit_number: "101",
        asking_price: 255000,
      },
      {
        org_id: org,
        reference: ref("-P1-A102"),
        kind: "unit",
        parent_id: phase!.id,
        property_type: "apartment",
        status: "sold",
        block: "A",
        unit_number: "102",
        asking_price: 265000,
      },
    ])
    .select("id");

  const token = randomBytes(32).toString("base64url");
  const { data: link } = await admin
    .from("share_links")
    .insert({
      org_id: org,
      kind: "availability",
      token_sha256: sha(token),
      locale: "en",
      title: "E2E availability",
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      created_by: profile!.id,
    })
    .select("id")
    .single();

  await admin
    .from("share_link_properties")
    .insert({ share_link_id: link!.id, property_id: project!.id, sort_order: 0 });

  return {
    token,
    linkId: link!.id,
    projectId: project!.id,
    phaseId: phase!.id,
    unitIds: (units ?? []).map((u) => u.id),
    ref,
  };
}

async function cleanup(
  admin: SupabaseClient,
  ids: { linkId?: string; projectId?: string; phaseId?: string; unitIds?: string[] },
) {
  if (ids.linkId) {
    await admin.from("share_link_properties").delete().eq("share_link_id", ids.linkId);
    await admin.from("share_links").delete().eq("id", ids.linkId);
  }
  // children before parents — parent_id is ON DELETE RESTRICT
  for (const id of ids.unitIds ?? []) await admin.from("properties").delete().eq("id", id);
  if (ids.phaseId) await admin.from("properties").delete().eq("id", ids.phaseId);
  if (ids.projectId) await admin.from("properties").delete().eq("id", ids.projectId);
}

test.describe("Project availability links", () => {
  test.beforeEach(() => {
    test.skip(!isLocal(), "seeds properties and links — local only, never production");
  });

  test.describe("as an anonymous visitor", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("a phased project's units reach the page, with status, and nothing private", async ({
      page,
    }) => {
      const admin = svc();
      const seeded = await seedAvailability(admin);
      try {
        const response = await page.goto(`/p/${seeded.token}`, { waitUntil: "networkidle" });
        expect(response?.status()).toBe(200);

        // THE TRAP: both units hang off the PHASE, not the project. A child
        // query returns nothing here and this assertion is what says so.
        await expect(page.getByText(seeded.ref("-P1-A101"))).toBeVisible();
        await expect(page.getByText(seeded.ref("-P1-A102"))).toBeVisible();

        // grouped under the phase, carrying the PHASE's delivery date
        await expect(page.getByRole("heading", { name: /E2E phase one/ })).toBeVisible();
        await expect(page.getByText("Delivery September 2029")).toBeVisible();
        await expect(page.getByText("Delivery March 2028")).toBeVisible();

        // THE WIDENING: status is on the page for this kind, and it is real
        const html = await page.content();
        expect(html, "the matrix exists to show status").toContain("Sold");
        expect(html).toContain("Available");
        await expect(page.getByText("1 available")).toBeVisible();

        // and the boundary that did NOT move
        expect(html, "internal_notes must never reach a public page").not.toContain(
          SECRET_NOTE,
        );
        expect(html, "owner_net_price must never reach a public page").not.toContain(
          String(OWNER_NET),
        );
        expect(html, "min_acceptable_price must never reach a public page").not.toContain(
          String(MIN_PRICE),
        );
      } finally {
        await cleanup(admin, seeded);
      }
    });

    test("a revoked availability link is as blank as a revoked proposal", async ({ page }) => {
      const admin = svc();
      const seeded = await seedAvailability(admin);
      try {
        await admin
          .from("share_links")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", seeded.linkId);

        await page.goto(`/p/${seeded.token}`, { waitUntil: "networkidle" });
        const heading = await page.getByRole("heading").first().textContent();
        expect(heading).toContain("no longer available");

        // and it takes the project's name with it
        expect(await page.content()).not.toContain("E2E phased development");
      } finally {
        await cleanup(admin, seeded);
      }
    });
  });

  test("the mint control is on the project's units page", async ({ page }) => {
    const admin = svc();
    const seeded = await seedAvailability(admin);
    try {
      await page.goto(`/properties/${seeded.projectId}/units`, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { name: "Share availability" })).toBeVisible();

      await page.getByRole("button", { name: "New link" }).click();
      // The units table above shows DIRECT children only, so the form has to
      // say that the link covers more than what is on screen.
      await expect(page.getByText(/covers every phase of/)).toBeVisible();
      await expect(page.getByLabel("Prices shown on the link")).toBeVisible();
    } finally {
      await cleanup(admin, seeded);
    }
  });
});
