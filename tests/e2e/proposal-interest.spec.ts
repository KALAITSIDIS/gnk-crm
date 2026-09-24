import { createHash, randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { INTEREST_COPY, type InterestLocale } from "@/lib/services/proposal-interest-copy";
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
 *
 * AND THE PAGE'S LANGUAGE UNDER REFUSAL (audit 2026-09-22, finding 2): a
 * Greek or Russian proposal that refuses a blank name or a mistyped
 * address must say so in Greek or Russian, under the field, with the field
 * marked invalid and described by the message — the server's 400 used to
 * reach the page as an English sentence. And a correction after a refusal
 * must be ONE lead: the form keeps what was typed and its idempotency key.
 */
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

async function seedProposal(admin: SupabaseClient, locale: InterestLocale) {
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

/** The one visible problem message, and the control it is attached to. */
async function expectProblemOn(page: Page, control: ReturnType<Page["getByLabel"]>, text: string) {
  // p[role=alert]: Next's route announcer is a role=alert div too
  const alert = page.locator('p[role="alert"]');
  await expect(alert).toHaveCount(1);
  await expect(alert).toHaveText(text);
  await expect(control).toHaveAttribute("aria-invalid", "true");
  const describedBy = await control.getAttribute("aria-describedby");
  expect(describedBy, "the message must be the control's description").toBe(await alert.getAttribute("id"));
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

  /**
   * The same refusals in each language the proposal is made in. The blank
   * name is refused by the page itself; the mistyped address is refused by
   * the SERVER (the form posts with noValidate, so the browser does not
   * catch it) — that 400 is the one that used to arrive in English. Then
   * the correction: the third submission is accepted, the lead is ONE, and
   * every post carried the same idempotency key.
   */
  for (const locale of ["en", "el", "ru"] as const) {
    test(`a ${locale} proposal refuses a blank name and a mistyped address in ${locale}, and a correction is one lead`, async ({ page }) => {
      const admin = serviceClient();
      const t = INTEREST_COPY[locale];
      const s = await seedProposal(admin, locale);
      const keys: string[] = [];
      page.on("request", (req) => {
        if (req.method() === "POST" && req.url().includes("/api/public/proposals/interest")) {
          const body = req.postDataJSON() as { idempotency_key?: string };
          if (body?.idempotency_key) keys.push(body.idempotency_key);
        }
      });
      try {
        await openAndExpress(page, s.token, t.cta);
        const name = page.getByLabel(t.name);
        const email = page.getByLabel(t.email, { exact: true });
        const phone = page.getByLabel(t.phone, { exact: true });

        // 1. a blank name, an otherwise valid form: refused on the page, in the page's language
        await email.fill(`buyer-${s.reference}@example.invalid`);
        await page.getByRole("button", { name: t.send }).click();
        await expectProblemOn(page, name, t.problems.name_required);
        expect(keys, "nothing was posted for a blank name").toHaveLength(0);

        // 2. a name and a mistyped address: the SERVER refuses (400 email_invalid) and the page translates
        await name.fill(`Buyer ${locale}`);
        await email.fill("not-an-email");
        await page.getByRole("button", { name: t.send }).click();
        await expectProblemOn(page, email, t.problems.email_invalid);
        expect(keys, "one post was made and refused").toHaveLength(1);
        await expect(name, "what was typed survives the refusal").toHaveValue(`Buyer ${locale}`);
        await expect(phone).not.toHaveAttribute("aria-invalid", "true");
        // the English sentence the route also carries never reaches the page
        await expect(page.getByText("That email address is not valid.")).toHaveCount(0);

        // 3. the correction is accepted, as ONE lead, under the SAME key
        await email.fill(`buyer-${s.reference}@example.invalid`);
        await page.getByRole("button", { name: t.send }).click();
        await expect(page.getByRole("status")).toContainText(t.done);
        await expect(page.locator('p[role="alert"]')).toHaveCount(0);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size, "the same idempotency key on every post").toBe(1);

        const { data: leads } = await admin.from("leads").select("id, message").eq("property_id", s.propertyId);
        expect(leads, "exactly one lead").toHaveLength(1);
        expect(String(leads![0]!.message)).toContain(`Buyer ${locale}`);
      } finally {
        await cleanup(admin, s);
      }
    });
  }

  /**
   * T-enquiry-identity-single-line. The name and the phone are one line each
   * of the header the CRM reads the person back from, so the server refuses a
   * line break in either (400 `name_line_break` / `phone_line_break`, and 0114
   * in the database). The page's inputs drop LF and CR — the browser turns a
   * newline into a space, which the first step shows — so the break is put
   * into the page's request in flight, as a script would send it (a visitor
   * reaches the same refusal only by pasting a rarer separator). The
   * page must still say what is wrong, in its language, under that field —
   * not "please enter your name" — keep what was typed and its key, and the
   * untampered correction must be ONE lead with the name the visitor typed.
   */
  for (const locale of ["en", "el", "ru"] as const) {
    test(`a ${locale} proposal names a line break in the name or the phone in ${locale}, and nothing is written`, async ({ page }) => {
      const admin = serviceClient();
      const t = INTEREST_COPY[locale];
      const s = await seedProposal(admin, locale);
      const keys: string[] = [];
      let inject: "name" | "phone" | null = null;
      // its own visitor address, so its own meter budget: the tests above
      // spend this connection's five (public-enquiry.spec.ts, "EVERY TEST GETS
      // ITS OWN VISITOR ADDRESS"; RFC 3849's documentation prefix)
      const visitor = `2001:db8:${randomBytes(4).toString("hex")}::${locale.charCodeAt(0)}`;
      await page.route("**/api/public/proposals/interest", async (route) => {
        const body = route.request().postDataJSON() as Record<string, string>;
        keys.push(body.idempotency_key!);
        if (inject === "name") body.name = `${body.name}\nEmail: other@x.invalid`;
        if (inject === "phone") body.phone = `${body.phone}\r\nEmail: other@x.invalid`;
        await route.continue({
          postData: JSON.stringify(body),
          headers: { ...route.request().headers(), "x-forwarded-for": visitor },
        });
      });
      try {
        await openAndExpress(page, s.token, t.cta);
        const name = page.getByLabel(t.name);
        const email = page.getByLabel(t.email, { exact: true });
        const phone = page.getByLabel(t.phone, { exact: true });

        // the page's input cannot carry a break: Chromium inserts a space for it
        await name.fill("Ann\nSmith");
        expect(await name.inputValue()).not.toMatch(/[\r\n]/);

        await name.fill(`Buyer ${locale}`);
        await email.fill(`buyer-${s.reference}@example.invalid`);
        await phone.fill("+357 99 123456");

        inject = "name";
        await page.getByRole("button", { name: t.send }).click();
        await expectProblemOn(page, name, t.problems.name_line_break);
        await expect(page.getByText(t.problems.name_required)).toHaveCount(0);
        await expect(name, "what was typed survives the refusal").toHaveValue(`Buyer ${locale}`);

        inject = "phone";
        await page.getByRole("button", { name: t.send }).click();
        await expectProblemOn(page, phone, t.problems.phone_line_break);
        await expect(name).not.toHaveAttribute("aria-invalid", "true");

        const { count: refused } = await admin.from("leads").select("id", { count: "exact", head: true }).eq("property_id", s.propertyId);
        expect(refused, "neither refusal wrote a lead").toBe(0);

        inject = null;
        await page.getByRole("button", { name: t.send }).click();
        await expect(page.getByRole("status")).toContainText(t.done);
        expect(keys).toHaveLength(3);
        expect(new Set(keys).size, "the same idempotency key on every post").toBe(1);

        const { data: leads } = await admin.from("leads").select("id, message").eq("property_id", s.propertyId);
        expect(leads, "exactly one lead").toHaveLength(1);
        const message = String(leads![0]!.message);
        expect(message).toContain(`\nName: Buyer ${locale}\nEmail: buyer-${s.reference}@example.invalid\nPhone: +357 99 123456\n`);
        expect(message).not.toContain("other@x.invalid");
      } finally {
        await page.unroute("**/api/public/proposals/interest");
        await cleanup(admin, s);
      }
    });
  }
});
