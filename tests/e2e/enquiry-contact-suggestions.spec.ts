import { randomBytes, randomInt } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { assertNoProblems, fixtureProfile, isLocal, opTimeout, serviceClient, watchForProblems } from "./helpers";

/**
 * "Possible existing contact" on the lead inbox, end to end in the running
 * app (T-enquiry-contact-suggestions): an existing contact with an earlier
 * enquiry → a website enquiry arrives with the same e-mail and phone typed
 * differently → the row names the contact and its earlier enquiry BEFORE
 * anyone clicks Create contact → Review and link shows the evidence → an
 * explicit confirmation links it → the link survives a reload, with one
 * `contact_linked` event and the enquiry's own lifecycle untouched.
 *
 * Also: the phone and the e-mail pointing at two different people shows both,
 * and a colleague's link made after the page was drawn is not overwritten.
 * Rendering and opening the dialog are checked to write nothing.
 *
 * NOTHING IS SENT. The enquiries are inserted as rows in the door's exact
 * header format rather than posted to /api/public/enquiries: the door would
 * queue a desk alert (0101), and the local .env.local may now hold a Resend
 * key. The door itself is public-enquiry.spec.ts's; this spec is about the
 * inbox. Local only: it writes contacts and leads into the seeded org and
 * removes them afterwards (events stay — the chain is append-only).
 */
const svc = serviceClient();
const made = { leads: [] as string[], contacts: [] as string[] };

test.beforeEach(async () => {
  test.skip(!isLocal(), "write flows are local-only — never run against production data");
});

test.afterAll(async () => {
  if (!isLocal()) return;
  if (made.leads.length) {
    await svc.from("tasks").delete().in("lead_id", made.leads);
    await svc.from("leads").delete().in("id", made.leads);
  }
  if (made.contacts.length) await svc.from("contacts").delete().in("id", made.contacts);
});

/** A Cyprus mobile no fixture is likely to hold: 99 + six random digits. */
const mobile = () => {
  const tail = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return { e164: `+35799${tail}`, typedLocally: `99 ${tail.slice(0, 3)} ${tail.slice(3)}` };
};

async function contact(orgId: string, first: string, last: string, over: Record<string, unknown>) {
  const { data, error } = await svc
    .from("contacts")
    .insert({ org_id: orgId, contact_kind: "person", first_name: first, last_name: last, ...over })
    .select("id")
    .single();
  if (error) throw new Error(`contact: ${error.message}`);
  made.contacts.push(data.id);
  return data.id as string;
}

async function lead(orgId: string, row: Record<string, unknown>) {
  const { data, error } = await svc
    .from("leads")
    .insert({ org_id: orgId, source: "website", status: "new", ...row })
    .select("id")
    .single();
  if (error) throw new Error(`lead: ${error.message}`);
  made.leads.push(data.id);
  return data.id as string;
}

/** The block the door writes (0101), so the inbox reads it exactly as it reads a real enquiry. */
const doorBlock = (name: string, email: string | null, phone: string | null, words: string) =>
  ["Website enquiry", `Name: ${name}`, email ? `Email: ${email}` : null, phone ? `Phone: ${phone}` : null, "", words]
    .filter((l) => l !== null)
    .join("\n");

const rowOf = (page: Page, visitor: string) => page.locator("li", { hasText: visitor });

async function linkEvents(leadId: string) {
  const { data, error } = await svc
    .from("events")
    .select("actor_id, payload")
    .eq("entity_type", "lead")
    .eq("entity_id", leadId)
    .eq("event_type", "contact_linked");
  if (error) throw new Error(`events: ${error.message}`);
  return (data ?? []).map((e) => ({ actor_id: e.actor_id as string | null, payload: e.payload as Record<string, unknown> }));
}

async function leadRow(leadId: string) {
  const { data, error } = await svc
    .from("leads")
    .select("contact_id, status, assigned_agent_id, received_at, first_response_at, criteria, updated_at")
    .eq("id", leadId)
    .single();
  if (error) throw new Error(`lead row: ${error.message}`);
  return data;
}

test.describe("Lead inbox — possible existing contact", () => {
  test("suggests the contact and its earlier enquiry before Create contact, links on confirmation, and the link persists", async ({ page }) => {
    const { id: adminId, orgId } = await fixtureProfile(svc);
    const tok = randomBytes(3).toString("hex");
    const email = `e2e-sugg-${tok}@example.invalid`;
    const phone = mobile();
    const last = `Existing ${tok}`;
    const existing = await contact(orgId, "Suggest", last, { email, phone_e164: phone.e164 });
    const { data: adminProfile } = await svc.from("profiles").select("full_name").eq("id", adminId).single();
    const { data: property } = await svc
      .from("properties")
      .select("id, reference")
      .eq("org_id", orgId)
      .order("reference")
      .limit(1)
      .maybeSingle();
    const earlier = await lead(orgId, {
      source: "phone",
      contact_id: existing,
      property_id: property?.id ?? null,
      status: "contacted",
      assigned_agent_id: adminId,
      received_at: "2026-08-15T09:00:00Z",
      message: `earlier call ${tok}`,
    });
    const visitor = `Visitor ${tok}`;
    // the same person, typed differently: capitals in the e-mail, the phone in local format
    const enquiry = await lead(orgId, {
      received_at: new Date().toISOString(),
      message: doorBlock(visitor, email.toUpperCase(), phone.typedLocally, `Is it still available? ${tok}`),
    });
    const earlierBefore = await leadRow(earlier);
    const enquiryBefore = await leadRow(enquiry);

    const problems = watchForProblems(page);
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = rowOf(page, visitor);
    await expect(row).toBeVisible({ timeout: opTimeout(30_000) });

    // the suggestion is there on arrival — nobody has clicked Create contact
    const panel = row.getByRole("group", { name: "Possible existing contact" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("link", { name: `Suggest ${last}` })).toHaveAttribute("href", `/contacts/${existing}`);
    await expect(panel.getByText("Same e-mail and phone")).toBeVisible();
    // the recent enquiries are summarised, and open in place
    const summary = panel.getByText("1 recent enquiry · latest 15 Aug 2026");
    await expect(summary).toBeVisible();
    await summary.click();
    await expect(panel.getByText("15 Aug 2026", { exact: true })).toBeVisible();
    await expect(panel.getByText("Contacted")).toBeVisible();
    await expect(panel.getByText(adminProfile!.full_name)).toBeVisible();
    if (property) await expect(panel.getByRole("link", { name: property.reference })).toBeVisible();
    await expect(row.getByRole("button", { name: /create contact/i }), "Create contact would only hit the same match").toHaveCount(0);

    await panel.getByRole("button", { name: `Review and link Suggest ${last}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Link this enquiry to Suggest ${last}?` })).toBeVisible();
    await expect(dialog.getByText(`E-mail ${email} — the same as this contact's e-mail.`)).toBeVisible();
    await expect(dialog.getByText(/^Phone \+357 99 \d{6} — the same as this contact's phone\.$/)).toBeVisible();
    await expect(dialog.getByText("A shared e-mail or phone suggests, but does not prove, that this is the same person.")).toBeVisible();

    // rendering the inbox and opening the dialog wrote nothing
    expect(await leadRow(enquiry)).toEqual(enquiryBefore);
    expect(await linkEvents(enquiry)).toEqual([]);

    await dialog.getByRole("button", { name: `Link to Suggest ${last}` }).click();
    await expect(page.getByText(`Enquiry linked to Suggest ${last}`)).toBeVisible({ timeout: opTimeout(20_000) });
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: opTimeout(20_000) });
    await expect.poll(async () => (await leadRow(enquiry)).contact_id, { timeout: opTimeout(20_000) }).toBe(existing);

    // after a reload the row is linked and the suggestion is gone
    await page.reload({ waitUntil: "networkidle" });
    const linkedRow = rowOf(page, visitor);
    await expect(linkedRow.getByRole("link", { name: `Suggest ${last}` }).first()).toHaveAttribute("href", `/contacts/${existing}`, {
      timeout: opTimeout(30_000),
    });
    await expect(linkedRow.getByText("No contact linked")).toHaveCount(0);
    await expect(linkedRow.getByRole("group", { name: /possible existing contact/i })).toHaveCount(0);

    // one event, by the admin, ids and shape only; the enquiry kept its own lifecycle
    const events = await linkEvents(enquiry);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_id).toBe(adminId);
    expect(events[0]!.payload).toEqual({ contact_id: existing, via: "suggestion", matched_on: "email_and_phone" });
    const enquiryAfter = await leadRow(enquiry);
    // everything but the link itself (and the row's updated_at stamp) is as it was
    expect({ ...enquiryAfter, contact_id: null, updated_at: null }).toEqual({ ...enquiryBefore, updated_at: null });
    expect(await leadRow(earlier), "the earlier enquiry is a separate record, untouched").toEqual(earlierBefore);
    assertNoProblems(problems, "leads (possible existing contact)");
  });

  test("the phone and the e-mail pointing at two different people shows both, and picks neither", async ({ page }) => {
    const { orgId } = await fixtureProfile(svc);
    const tok = randomBytes(3).toString("hex");
    const email = `e2e-split-${tok}@example.invalid`;
    const phone = mobile();
    await contact(orgId, "ByEmail", `Split ${tok}`, { email });
    await contact(orgId, "ByPhone", `Split ${tok}`, { phone_e164: phone.e164 });
    const visitor = `Visitor split ${tok}`;
    const enquiry = await lead(orgId, {
      received_at: new Date().toISOString(),
      message: doorBlock(visitor, email, phone.typedLocally, `hello ${tok}`),
    });

    const problems = watchForProblems(page);
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = rowOf(page, visitor);
    await expect(row).toBeVisible({ timeout: opTimeout(30_000) });
    const panel = row.getByRole("group", { name: "2 possible existing contacts" });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByText(`The e-mail matches ByEmail Split ${tok}, but the phone matches ByPhone Split ${tok}.`, { exact: false }),
    ).toBeVisible();
    await expect(panel.getByText("Same e-mail", { exact: true })).toBeVisible();
    await expect(panel.getByText("Same phone", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Review and link / })).toHaveCount(2);
    await expect(panel.getByRole("button", { name: `Review and link ByEmail Split ${tok}` })).toBeVisible();
    await expect(panel.getByRole("button", { name: `Review and link ByPhone Split ${tok}` })).toBeVisible();
    await expect(row.getByRole("button", { name: /create contact/i }), "not while candidates are listed").toHaveCount(0);
    expect((await leadRow(enquiry)).contact_id, "nothing was chosen for the desk").toBeNull();
    assertNoProblems(problems, "leads (split evidence)");
  });

  test("a colleague's link made after the page was drawn wins — the confirmation changes nothing", async ({ page }) => {
    const { orgId } = await fixtureProfile(svc);
    const tok = randomBytes(3).toString("hex");
    const email = `e2e-stale-${tok}@example.invalid`;
    await contact(orgId, "Suggested", `Stale ${tok}`, { email });
    const colleaguesPick = await contact(orgId, "Colleague", `Pick ${tok}`, {});
    const visitor = `Visitor stale ${tok}`;
    const enquiry = await lead(orgId, {
      received_at: new Date().toISOString(),
      message: doorBlock(visitor, email, null, `hello ${tok}`),
    });

    const problems = watchForProblems(page);
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = rowOf(page, visitor);
    await expect(row.getByRole("group", { name: "Possible existing contact" })).toBeVisible({ timeout: opTimeout(30_000) });
    await row.getByRole("button", { name: `Review and link Suggested Stale ${tok}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: `Link to Suggested Stale ${tok}` })).toBeVisible();

    // meanwhile, a colleague links a different contact
    const { error } = await svc.from("leads").update({ contact_id: colleaguesPick }).eq("id", enquiry);
    if (error) throw new Error(error.message);

    await dialog.getByRole("button", { name: `Link to Suggested Stale ${tok}` }).click();
    // said where a refresh cannot take it away: the refreshed row no longer
    // qualifies, so the dialog (and its own alert) unmount underneath
    await expect(page.locator("[data-sonner-toast]", { hasText: "This lead is already linked to another contact" })).toBeVisible({
      timeout: opTimeout(20_000),
    });
    expect((await leadRow(enquiry)).contact_id).toBe(colleaguesPick);
    expect(await linkEvents(enquiry), "a refused write logs nothing").toEqual([]);

    // the inbox underneath was refreshed to what actually happened
    if (await dialog.isVisible()) await page.keyboard.press("Escape");
    await expect(rowOf(page, visitor).getByRole("link", { name: `Colleague Pick ${tok}` })).toBeVisible({ timeout: opTimeout(30_000) });
    await expect(rowOf(page, visitor).getByRole("group", { name: /possible existing contact/i })).toHaveCount(0);
    assertNoProblems(problems, "leads (stale suggestion)");
  });

  test("evidence that changed after the page was drawn is not confirmed", async ({ page }) => {
    const { orgId } = await fixtureProfile(svc);
    const tok = randomBytes(3).toString("hex");
    const email = `e2e-changed-${tok}@example.invalid`;
    const suggested = await contact(orgId, "Changed", `Evidence ${tok}`, { email });
    const visitor = `Visitor changed ${tok}`;
    const enquiry = await lead(orgId, {
      received_at: new Date().toISOString(),
      message: doorBlock(visitor, email, null, `hello ${tok}`),
    });

    const problems = watchForProblems(page);
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = rowOf(page, visitor);
    await expect(row.getByRole("group", { name: "Possible existing contact" })).toBeVisible({ timeout: opTimeout(30_000) });
    await row.getByRole("button", { name: `Review and link Changed Evidence ${tok}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(`E-mail ${email} — the same as this contact's e-mail.`)).toBeVisible();

    // meanwhile the contact's address is corrected — what the dialog shows is no longer true
    const { error } = await svc.from("contacts").update({ email: `corrected-${tok}@example.invalid` }).eq("id", suggested);
    if (error) throw new Error(error.message);

    await dialog.getByRole("button", { name: `Link to Changed Evidence ${tok}` }).click();
    await expect(page.locator("[data-sonner-toast]", { hasText: "no longer shares the enquiry's e-mail or phone" })).toBeVisible({
      timeout: opTimeout(20_000),
    });
    expect((await leadRow(enquiry)).contact_id, "stale evidence links nothing").toBeNull();
    expect(await linkEvents(enquiry)).toEqual([]);

    // the refreshed row tells the truth now
    if (await dialog.isVisible()) await page.keyboard.press("Escape");
    await expect(rowOf(page, visitor).getByText("No active contact has this enquiry's e-mail or phone.")).toBeVisible({
      timeout: opTimeout(30_000),
    });
    assertNoProblems(problems, "leads (changed evidence)");
  });

  test("no match says so, and Create contact is still there", async ({ page }) => {
    const { orgId } = await fixtureProfile(svc);
    const tok = randomBytes(3).toString("hex");
    const visitor = `Visitor nomatch ${tok}`;
    await lead(orgId, {
      received_at: new Date().toISOString(),
      message: doorBlock(visitor, `nobody-${tok}@example.invalid`, null, `hello ${tok}`),
    });
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = rowOf(page, visitor);
    await expect(row.getByText("No active contact has this enquiry's e-mail or phone.")).toBeVisible({ timeout: opTimeout(30_000) });
    await expect(row.getByRole("button", { name: /create contact/i })).toBeVisible();
  });

  /**
   * T-enquiry-identity-single-line. Before 0114 a line break in the phone
   * stored a second Email line, and the inbox matched — and "Create contact"
   * would have created — on that injected address. The header is now read as
   * AMBIGUOUS: nothing is suggested (not even the contact who holds the
   * injected address), Create contact is not offered, Link contact is, and
   * the enquiry itself is shown whole for the desk to read.
   */
  test("an enquiry stored with an ambiguous header is left to the desk — no guessed match, no Create contact", async ({ page }) => {
    const { orgId } = await fixtureProfile(svc);
    const tok = randomBytes(3).toString("hex");
    const injected = `e2e-injected-${tok}@example.invalid`;
    await contact(orgId, "Holds", `Injected ${tok}`, { email: injected });
    const visitor = `Visitor ambiguous ${tok}`;
    // exactly what the door wrote for the audit's case A before 0114
    const stored = [
      "Website enquiry",
      `Name: ${visitor}`,
      `Email: buyer-${tok}@example.invalid`,
      "Phone: +35799123456",
      `Email: ${injected}`,
      "",
      `Please contact me. ${tok}`,
    ].join("\n");
    await lead(orgId, { received_at: new Date().toISOString(), message: stored });

    const problems = watchForProblems(page);
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = rowOf(page, visitor);
    await expect(row.getByText("This enquiry's details could not be read — link the contact by hand.")).toBeVisible({
      timeout: opTimeout(30_000),
    });
    await expect(row.getByRole("group", { name: /possible existing contact/i })).toHaveCount(0);
    await expect(row.getByText(`Holds Injected ${tok}`)).toHaveCount(0);
    await expect(row.getByRole("button", { name: /create contact/i })).toHaveCount(0);
    await expect(row.getByRole("button", { name: /link contact/i }).first()).toBeVisible();
    // the enquiry is untouched and readable in full
    await row.getByText("· more").click();
    await expect(row.getByText(`Email: ${injected}`)).toBeVisible();
    await expect(row.getByText(`Please contact me. ${tok}`)).toBeVisible();
    assertNoProblems(problems, "leads (ambiguous header)");
  });
});
