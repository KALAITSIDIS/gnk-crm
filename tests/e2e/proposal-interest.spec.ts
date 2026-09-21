import { createHash, randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { isLocal, serviceClient } from "./helpers";

/**
 * "I'm interested" on a shared proposal (0106) — the whole journey, as a
 * buyer on a forwarded link: open the page, say so about one property, give
 * a name and an e-mail, and see the confirmation. Then the CRM side: one
 * lead in the right org, bound to that property, owned by the proposal's
 * author, with its durable desk-alert row — and the link's own contact NOT
 * attributed. The recoverable and terminal states: a submission without a
 * way to reply is refused on the page; a link revoked after the page was
 * opened answers "no longer available" on submit.
 */
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

async function seedProposal(admin: SupabaseClient, locale: "en" | "el") {
  const { data: profile } = await admin.from("profiles").select("id, org_id").eq("email", "admin@gnk.local").single();
  const reference = `E2E-INT-${randomBytes(3).toString("hex").toUpperCase()}`;
  const { data: property } = await admin
    .from("properties")
    .insert({
      org_id: profile!.org_id,
      reference,
      property_type: "villa",
      visibility: "private", // a proposal may carry a listing the website never shows
      status: "available",
      title: { en: "E2E interest villa" },
      asking_price: 640000,
    })
    .select("id")
    .single();
  const { data: contact } = await admin
    .from("contacts")
    .insert({ org_id: profile!.org_id, first_name: "Original", last_name: "Recipient", email: `recipient-${reference}@example.invalid` })
    .select("id")
    .single();
  const token = randomBytes(32).toString("base64url");
  const { data: link } = await admin
    .from("share_links")
    .insert({
      org_id: profile!.org_id,
      token_sha256: sha(token),
      locale,
      title: "E2E selection",
      contact_id: contact!.id,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      created_by: profile!.id,
    })
    .select("id")
    .single();
  await admin.from("share_link_properties").insert({ share_link_id: link!.id, property_id: property!.id, sort_order: 0 });
  return { token, linkId: link!.id as string, propertyId: property!.id as string, contactId: contact!.id as string, reference, agentId: profile!.id as string, orgId: profile!.org_id as string };
}

async function cleanup(admin: SupabaseClient, s: Awaited<ReturnType<typeof seedProposal>>) {
  const { data: leads } = await admin.from("leads").select("id").eq("property_id", s.propertyId);
  const ids = (leads ?? []).map((l) => l.id as string);
  if (ids.length) {
    await admin.from("tasks").delete().in("lead_id", ids);
    await admin.from("leads").delete().in("id", ids);
  }
  await admin.from("share_link_properties").delete().eq("share_link_id", s.linkId);
  await admin.from("share_links").delete().eq("id", s.linkId);
  await admin.from("properties").delete().eq("id", s.propertyId);
  await admin.from("contacts").delete().eq("id", s.contactId);
}

async function openAndExpress(page: Page, token: string, cta: string) {
  await page.goto(`/p/${token}`);
  const button = page.getByRole("button", { name: cta });
  await expect(button).toBeVisible();
  await button.click();
}

test.describe("Proposal interest", () => {
  test.beforeEach(() => {
    test.skip(!isLocal(), "seeds through the local stack's service key");
  });

  test("a buyer expresses interest in one property and the CRM gets one attributed enquiry with its desk alert", async ({ page }) => {
    const admin = serviceClient();
    const s = await seedProposal(admin, "en");
    try {
      await openAndExpress(page, s.token, "I'm interested");
      await page.getByLabel("Your name").fill("Interested Buyer");
      await page.getByLabel("Email").fill(`buyer-${s.reference}@example.invalid`);
      await page.getByLabel(/Message/).fill("Is a viewing possible next week?");
      await page.getByRole("button", { name: "Send" }).click();

      const status = page.getByRole("status");
      await expect(status).toContainText("we have noted your interest in");
      await expect(status).toContainText(s.reference);

      const { data: lead } = await admin
        .from("leads")
        .select("id, org_id, property_id, contact_id, assigned_agent_id, source, message, criteria")
        .eq("property_id", s.propertyId)
        .single();
      expect(lead, "one lead for the property").not.toBeNull();
      expect(lead!.org_id).toBe(s.orgId);
      expect(lead!.contact_id, "the link's recipient is not assumed to be the visitor").toBeNull();
      expect(lead!.assigned_agent_id, "the proposal's author owns it").toBe(s.agentId);
      expect(lead!.source).toBe("website");
      expect(String(lead!.message)).toContain("Is a viewing possible next week?");
      expect((lead!.criteria as Record<string, unknown>).share_link_id).toBe(s.linkId);

      const { data: job } = await admin.from("notification_jobs").select("kind, state").eq("lead_id", lead!.id).single();
      expect(job?.kind, "the durable desk alert").toBe("enquiry_desk_alert");

      // the recipient's own data never reached the page
      await expect(page.getByText("Original Recipient")).toHaveCount(0);
      await expect(page.getByText(`recipient-${s.reference}@example.invalid`)).toHaveCount(0);
    } finally {
      await cleanup(admin, s);
    }
  });

  test("without a way to reply the page refuses before posting, and a Greek proposal speaks Greek", async ({ page }) => {
    const admin = serviceClient();
    const s = await seedProposal(admin, "el");
    try {
      await openAndExpress(page, s.token, "Με ενδιαφέρει");
      await page.getByLabel("Το όνομά σας").fill("Ενδιαφερόμενος");
      await page.getByRole("button", { name: "Αποστολή" }).click();
      // p[role=alert]: Next's route announcer is a role=alert div too
      await expect(page.locator('p[role="alert"]')).toContainText("email");
      const { count } = await admin.from("leads").select("id", { count: "exact", head: true }).eq("property_id", s.propertyId);
      expect(count, "nothing was written").toBe(0);
    } finally {
      await cleanup(admin, s);
    }
  });

  test("a link revoked after the page was opened answers 'no longer available' on submit", async ({ page }) => {
    const admin = serviceClient();
    const s = await seedProposal(admin, "en");
    try {
      await openAndExpress(page, s.token, "I'm interested");
      await admin.from("share_links").update({ revoked_at: new Date().toISOString() }).eq("id", s.linkId);
      await page.getByLabel("Your name").fill("Too Late");
      await page.getByLabel("Phone").fill("+357 99 123456");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByRole("status")).toContainText("no longer available");
      const { count } = await admin.from("leads").select("id", { count: "exact", head: true }).eq("property_id", s.propertyId);
      expect(count).toBe(0);
    } finally {
      await cleanup(admin, s);
    }
  });
});
