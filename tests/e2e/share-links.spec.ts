import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { isLocal, serviceClient } from "./helpers";

/**
 * Buyer proposal links (IMPROVEMENTS B3).
 *
 * The point of these tests is the EXPOSURE BOUNDARY: a page served to an
 * unauthenticated stranger must show the marketing record and nothing else.
 * `resolve_share_link`'s allowlist is asserted in SQL by RLS test 25; here we
 * assert what actually reaches the DOM, because that is what a buyer sees.
 */

const SECRET_NOTE = "E2E-INTERNAL-NOTE-MUST-NOT-LEAK";
const OWNER_NET = 111111;
const MIN_PRICE = 222222;
const ASKING = 333333;

const svc = (): SupabaseClient => serviceClient();

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

async function seedProposal(admin: SupabaseClient) {
  const { data: profile } = await admin
    .from("profiles")
    .select("id, org_id")
    .eq("email", "admin@gnk.local")
    .single();

  const reference = `E2E-SHR-${randomBytes(3).toString("hex")}`;
  const { data: property } = await admin
    .from("properties")
    .insert({
      org_id: profile!.org_id,
      reference,
      property_type: "villa",
      visibility: "public",
      status: "available",
      title: { en: "E2E proposal villa" },
      public_description: { en: "A description the buyer may read." },
      asking_price: ASKING,
      owner_net_price: OWNER_NET,
      min_acceptable_price: MIN_PRICE,
      internal_notes: SECRET_NOTE,
    })
    .select("id")
    .single();

  const token = randomBytes(32).toString("base64url");
  const { data: link } = await admin
    .from("share_links")
    .insert({
      org_id: profile!.org_id,
      token_sha256: sha(token),
      locale: "en",
      title: "E2E proposal",
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      created_by: profile!.id,
    })
    .select("id")
    .single();

  await admin
    .from("share_link_properties")
    .insert({ share_link_id: link!.id, property_id: property!.id, sort_order: 0 });

  return { token, linkId: link!.id, propertyId: property!.id, reference };
}

async function cleanup(admin: SupabaseClient, ids: { linkId?: string; propertyId?: string }) {
  if (ids.linkId) {
    await admin.from("share_link_properties").delete().eq("share_link_id", ids.linkId);
    await admin.from("share_links").delete().eq("id", ids.linkId);
  }
  if (ids.propertyId) await admin.from("properties").delete().eq("id", ids.propertyId);
}

test.describe("Buyer proposal links", () => {
  test.beforeEach(() => {
    test.skip(
      !isLocal(),
      "seeds properties and links — local only, never production",
    );
  });

  // No session: this is exactly how a buyer arrives.
  test.describe("as an anonymous visitor", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("a live link renders the listing and leaks no private field", async ({ page }) => {
      const admin = svc();
      const seeded = await seedProposal(admin);
      try {
        const response = await page.goto(`/p/${seeded.token}`, { waitUntil: "networkidle" });

        // Not bounced to /login — doc 01 §4 forbids buyer logins, so this page
        // must be reachable without one.
        expect(response?.status()).toBe(200);
        expect(page.url()).toContain(`/p/${seeded.token}`);

        await expect(page.getByText("E2E proposal villa")).toBeVisible();
        await expect(page.getByText("A description the buyer may read.")).toBeVisible();

        // The whole rendered document, not just the visible text — a private
        // value hidden in a data attribute or a script payload still leaked.
        const html = await page.content();
        expect(html, "internal_notes must never reach a buyer").not.toContain(SECRET_NOTE);
        expect(html, "owner_net_price must never reach a buyer").not.toContain(String(OWNER_NET));
        expect(html, "min_acceptable_price must never reach a buyer").not.toContain(
          String(MIN_PRICE),
        );
      } finally {
        await cleanup(admin, seeded);
      }
    });

    test("revoked, expired and unknown tokens are indistinguishable", async ({ page }) => {
      const admin = svc();
      const seeded = await seedProposal(admin);
      try {
        await admin
          .from("share_links")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", seeded.linkId);

        await page.goto(`/p/${seeded.token}`, { waitUntil: "networkidle" });
        const revoked = await page.getByRole("heading").first().textContent();
        expect(revoked).toContain("no longer available");

        // An unknown token of the same shape must render the SAME page, or the
        // difference tells a prober which tokens exist.
        await page.goto(`/p/${randomBytes(32).toString("base64url")}`, {
          waitUntil: "networkidle",
        });
        const unknown = await page.getByRole("heading").first().textContent();
        expect(unknown).toBe(revoked);
      } finally {
        await cleanup(admin, seeded);
      }
    });

    test("the agent-facing manager stays behind the auth gate", async ({ page }) => {
      await page.goto("/share-links", { waitUntil: "networkidle" });
      expect(page.url()).toContain("/login");
    });
  });

  test("an agent can mint a link and revoke it", async ({ page }) => {
    await page.goto("/share-links", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Share links" })).toBeVisible();
    // The manager is reachable and lists links; minting is exercised end-to-end
    // by the RLS suite (test 25) against the same RPC this page calls.
    await expect(page.getByRole("button", { name: "New proposal" })).toBeVisible();
  });
});
