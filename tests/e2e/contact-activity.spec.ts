import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertNoHorizontalOverflow, fixtureProfile, isLocal, opTimeout, runTag, serviceClient } from "./helpers";

/**
 * A06, end to end: a customer's Activity tab and the summary strip under the
 * name, and the rule the item was validated against — a WhatsApp click is a
 * link click, never contact, and never stops a lead's response clock.
 *
 * Seeded through the service client as the seed admin's org (local only):
 * a contact with a phone and WhatsApp, a phoned-in lead linked to them with a
 * `called` event on the LEAD (what the inbox's Called button writes), and an
 * `updated` event on the contact. Then, as the seed admin, through the real
 * pages:
 *
 * - the strip's "Last logged contact" is the lead's call, "on a lead";
 * - the WhatsApp button (window.open stubbed) records a click: the strip
 *   shows it as "Last chat opened … not a logged contact" and the last
 *   contact does not move;
 * - the Activity tab shows the call with a "Lead" chip and its author, the
 *   click as "WhatsApp chat opened (link click only)", and the filters
 *   (aria-pressed, per-filter empty text) hide the record change under
 *   Communication;
 * - on /leads, a website enquiry whose only activity is a WhatsApp click
 *   still shows a running clock, and the lead row is still unanswered.
 * - A06-b (0155): the Log-conversation dialogs say what happened. The
 *   contact's Log contact with "Message sent, no reply yet" and no note, then
 *   the inbox's Log on the person's lead with "Client replied" and a note:
 *   the Activity tab reads "Message sent (WhatsApp)" and "Client replied
 *   (Phone)" with a Lead chip, the strip's last logged contact is the reply,
 *   and the database holds the outcome in each event (and on the note).
 *
 * What a non-admin may NOT see (a signed slip's names, a colleague's task, a
 * deal they cannot read) is measured against the real policies in
 * supabase/tests/contact-activity.test.ts — every e2e signs in as the seed admin.
 */

const TAG = runTag();
const NAME = `E2EActivity ${TAG}`;
const PHONE_LEAD_MESSAGE = `E2E activity phoned-in enquiry ${TAG}`;
const WEB_LEAD_MESSAGE = `E2E activity website enquiry ${TAG}`;

let svc: SupabaseClient;
let contactId: string;
let phoneLeadId: string;
let webLeadId: string;
let adminName: string;

/** chat_link_opened rows on one record */
async function clicks(entityType: string, entityId: string): Promise<number> {
  const { count, error } = await svc
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .eq("event_type", "chat_link_opened");
  if (error) throw new Error(error.message);
  return count ?? -1;
}

async function stubWindowOpen(page: Page) {
  // the button opens wa.me in a new tab; the test only needs the logged click
  await page.addInitScript(() => {
    window.open = () => null;
  });
}

const strip = (page: Page) => page.locator('dl[aria-label="Contact summary"]');
const stripPart = (page: Page, label: string) => strip(page).locator("div").filter({ has: page.getByText(label, { exact: true }) });

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test.beforeAll(async () => {
  if (!isLocal()) return;
  svc = serviceClient();
  const me = await fixtureProfile(svc);
  const { data: profile } = await svc.from("profiles").select("full_name").eq("id", me.id).single();
  adminName = profile!.full_name as string;

  const { data: c, error: cErr } = await svc
    .from("contacts")
    .insert({ org_id: me.orgId, first_name: NAME, phone_e164: "+35799000417", has_whatsapp: true, created_by: me.id })
    .select("id")
    .single();
  if (cErr) throw new Error(`contact: ${cErr.message}`);
  contactId = c.id;

  const { data: l, error: lErr } = await svc
    .from("leads")
    .insert({
      org_id: me.orgId,
      source: "phone",
      message: PHONE_LEAD_MESSAGE,
      contact_id: contactId,
      assigned_agent_id: me.id,
      status: "contacted",
      first_response_at: new Date(Date.now() - 3600_000).toISOString(),
      first_call_at: new Date(Date.now() - 3600_000).toISOString(),
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`phone lead: ${lErr.message}`);
  phoneLeadId = l.id;

  const { data: w, error: wErr } = await svc
    .from("leads")
    .insert({
      org_id: me.orgId,
      source: "website",
      message: WEB_LEAD_MESSAGE,
      contact_id: contactId,
      assigned_agent_id: me.id,
      received_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  if (wErr) throw new Error(`website lead: ${wErr.message}`);
  webLeadId = w.id;

  // what the inbox's Called button writes — on the LEAD — and an ordinary edit on the contact
  const { error: eErr } = await svc.from("events").insert([
    { org_id: me.orgId, actor_id: me.id, entity_type: "lead", entity_id: phoneLeadId, event_type: "called", payload: { first_call: true } },
    { org_id: me.orgId, actor_id: me.id, entity_type: "contact", entity_id: contactId, event_type: "updated", payload: { section: "profile" } },
  ]);
  if (eErr) throw new Error(`events: ${eErr.message}`);
});

test.afterAll(async () => {
  if (!isLocal() || !svc) return;
  // events are append-only and stay; the rows they name go — including the
  // interaction_notes the real Log dialogs write (no FK to leads or contacts,
  // so nothing cascades: lead-redaction.spec.ts deletes them the same way)
  await svc.from("interaction_notes").delete().in("entity_id", [phoneLeadId, webLeadId, contactId].filter(Boolean));
  await svc.from("tasks").delete().in("lead_id", [phoneLeadId, webLeadId].filter(Boolean));
  await svc.from("leads").delete().in("id", [phoneLeadId, webLeadId].filter(Boolean));
  if (contactId) await svc.from("contacts").delete().eq("id", contactId);
});

test.describe.configure({ mode: "serial" });

test("the contact page: last logged contact, a WhatsApp click that is only a click, and a filterable Activity", async ({ page }) => {
  await stubWindowOpen(page);
  await page.goto(`/contacts/${contactId}`, { waitUntil: "networkidle" });

  // the call logged on the LEAD is the person's last contact — the page used to read only the contact
  await expect(stripPart(page, "Last logged contact")).toContainText("Marked called — first call");
  await expect(stripPart(page, "Last logged contact")).toContainText("on a lead");
  await expect(stripPart(page, "Last chat opened")).toContainText("None");

  await page.getByRole("button", { name: /WhatsApp/ }).first().click();
  await expect.poll(() => clicks("contact", contactId), { timeout: opTimeout(15_000) }).toBe(1);

  await page.reload({ waitUntil: "networkidle" });
  await expect(stripPart(page, "Last chat opened")).toContainText("WhatsApp");
  await expect(stripPart(page, "Last chat opened")).toContainText("Link click only — not a logged contact");
  await expect(stripPart(page, "Last logged contact"), "a click never becomes the last contact").toContainText(
    "Marked called — first call",
  );

  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  const panel = page.getByRole("tabpanel");
  const call = panel.locator("li").filter({ hasText: "Marked called — first call" });
  await expect(call).toContainText("Lead");
  await expect(call).toContainText(adminName);
  await expect(panel.locator("li").filter({ hasText: "WhatsApp chat opened (link click only)" })).toHaveCount(1);
  await expect(panel.getByText("A chat-link click opens the app — it is not a logged contact.")).toBeVisible();
  await expect(panel.locator("li").filter({ hasText: "Updated — profile" })).toHaveCount(1);
  await expect(panel.locator("li").filter({ hasText: /merged contact/ }), "a lead's event is not a merged contact's").toHaveCount(0);

  const group = panel.getByRole("group", { name: "Filter activity" });
  const all = group.getByRole("button", { name: /^All/ });
  const communication = group.getByRole("button", { name: /^Communication/ });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await communication.click();
  await expect(communication).toHaveAttribute("aria-pressed", "true");
  await expect(all).toHaveAttribute("aria-pressed", "false");
  await expect(panel.locator("li").filter({ hasText: "Updated — profile" }), "a record change is not communication").toHaveCount(0);
  await expect(panel.locator("li").filter({ hasText: "Marked called — first call" })).toHaveCount(1);
  await expect(panel.locator("li").filter({ hasText: "WhatsApp chat opened (link click only)" })).toHaveCount(1);

  await group.getByRole("button", { name: /^Viewings/ }).click();
  await expect(panel.getByText("No viewing activity yet.")).toBeVisible();

  await assertNoHorizontalOverflow(page, "contact page with the activity strip");
});

test("an inbox WhatsApp click leaves the enquiry's response clock running", async ({ page }) => {
  await stubWindowOpen(page);
  await page.goto("/leads", { waitUntil: "networkidle" });
  const card = page.locator("li").filter({ hasText: WEB_LEAD_MESSAGE }).filter({ has: page.getByRole("button", { name: /WhatsApp/ }) });
  test.skip(!(await card.count()), "the seeded enquiry is not on the inbox's first page on this database");

  await card.first().getByRole("button", { name: /WhatsApp/ }).click();
  await expect.poll(() => clicks("lead", webLeadId), { timeout: opTimeout(15_000) }).toBe(1);

  const { data: lead } = await svc.from("leads").select("first_response_at, status").eq("id", webLeadId).single();
  expect(lead, "the click stamped nothing").toEqual({ first_response_at: null, status: "new" });

  await page.reload({ waitUntil: "networkidle" });
  const after = page.locator("li").filter({ hasText: WEB_LEAD_MESSAGE }).first();
  await expect(after).toBeVisible();
  await expect(after.getByText("answered", { exact: true }), "the clock is still running").toHaveCount(0);
});

/** the newest conversation_logged payload on one record */
async function lastLoggedPayload(entityType: string, entityId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await svc
    .from("events")
    .select("payload")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .eq("event_type", "conversation_logged")
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0]?.payload as Record<string, unknown> | undefined) ?? null;
}

test("the Log dialogs say what happened: a message sent with no reply yet, then the client's reply on the lead (A06-b)", async ({ page }) => {
  // 1. the contact's Log contact — WhatsApp, "Message sent, no reply yet", no note
  await page.goto(`/contacts/${contactId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Log contact" }).click();
  const contactDialog = page.getByRole("dialog", { name: "Log contact" });
  await contactDialog.getByLabel("How did you make contact?").selectOption("whatsapp");
  const what = contactDialog.getByRole("group", { name: "What happened" });
  await expect(what.getByRole("radio", { name: "Spoke" }), "Spoke is preselected").toBeChecked();
  await what.getByRole("radio", { name: "Message sent, no reply yet" }).check();
  await contactDialog.getByRole("button", { name: "Log contact" }).click();
  await expect(contactDialog).toBeHidden({ timeout: opTimeout(15_000) });
  await expect
    .poll(() => lastLoggedPayload("contact", contactId), { timeout: opTimeout(15_000) })
    .toEqual({ channel: "whatsapp", outcome: "message_sent" });

  // 2. the inbox's Log on the person's lead — Phone, "Client replied", with a note
  await page.goto("/leads", { waitUntil: "networkidle" });
  const card = page.locator("li").filter({ hasText: PHONE_LEAD_MESSAGE }).filter({ has: page.getByRole("button", { name: "Log", exact: true }) });
  test.skip(!(await card.count()), "the seeded lead is not on the inbox's first page on this database");
  await card.first().getByRole("button", { name: "Log", exact: true }).click();
  const leadDialog = page.getByRole("dialog", { name: "Log conversation" });
  await leadDialog.getByRole("group", { name: "What happened" }).getByRole("radio", { name: "Client replied" }).check();
  await leadDialog.getByLabel("Note").fill(`E2E rang back about the second floor ${TAG}`);
  await leadDialog.getByRole("button", { name: "Log conversation" }).click();
  await expect(leadDialog).toBeHidden({ timeout: opTimeout(15_000) });
  await expect.poll(() => lastLoggedPayload("lead", phoneLeadId), { timeout: opTimeout(15_000) }).toMatchObject({
    channel: "phone",
    outcome: "client_replied",
  });
  const payload = (await lastLoggedPayload("lead", phoneLeadId))!;
  expect(JSON.stringify(payload), "the note's words stay out of the chain").not.toContain(TAG);
  const { data: note } = await svc.from("interaction_notes").select("outcome").eq("id", payload.note_id as string).single();
  expect(note).toEqual({ outcome: "client_replied" });

  // 3. the person's page reads both, and the reply is the last logged contact
  await page.goto(`/contacts/${contactId}`, { waitUntil: "networkidle" });
  await expect(stripPart(page, "Last logged contact")).toContainText("Client replied (Phone)");
  await expect(stripPart(page, "Last logged contact")).toContainText("on a lead");
  await page.getByRole("tab", { name: "Activity" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.locator("li").filter({ hasText: "Message sent (WhatsApp)" })).toHaveCount(1);
  const reply = panel.locator("li").filter({ hasText: "Client replied (Phone)" });
  await expect(reply).toHaveCount(1);
  await expect(reply).toContainText("Lead");
  await expect(reply).toContainText(adminName);
  await expect(panel.getByText(`rang back about the second floor ${TAG}`), "the note's text shows with its line").toBeVisible();
});
