import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, runTag, serviceClient } from "./helpers";

/**
 * A04, end to end: from a qualified lead to a buyer-bound proposal and a
 * viewing, with nothing sent by the system at any step.
 *
 *   1. A website lead linked to an EXISTING contact shows "No saved search —
 *      add one" in the inbox; "Save brief as search" writes the search; the
 *      row then links to the contact's Preferences tab (`?tab=preferences`),
 *      which opens on that tab and says what the brief left unstated.
 *   2. On the buyer's matches every row starts unticked; ticking two and
 *      pressing "Create proposal for <buyer> (2)" mints ONE link, shown once,
 *      bound to the buyer (share_links.contact_id) and holding exactly those
 *      two listings; the rows then say "Proposed"; the listing's Matching
 *      buyers tab says it too; "Viewing" opens with both parties filled in.
 *   3. An off-market match is marked, and a proposal including it cannot be
 *      made until "This buyer may see off-market listings" is ticked.
 *   4. On the listing's side, a proposal's one-time link survives Escape and a
 *      click beside the dialog; only Done ends it (A04 review).
 *
 * Seeds and deletes through the service client, so local only.
 */

const TAG = runTag();
const BUYER = `E2EMatch ${TAG}`;
const REFS = { a: `E2EMA${TAG.slice(-4)}`, b: `E2EMB${TAG.slice(-4)}`, c: `E2EMC${TAG.slice(-4)}` };
const TITLES = { a: `E2E match villa A ${TAG}`, b: `E2E match villa B ${TAG}`, c: `E2E off-market villa ${TAG}` };

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

async function cleanup(svc: SupabaseClient, contactId: string | null, leadId: string | null, propertyIds: string[]) {
  if (contactId) {
    const { data: links } = await svc.from("share_links").select("id").eq("contact_id", contactId);
    for (const l of links ?? []) {
      await svc.from("share_link_properties").delete().eq("share_link_id", l.id);
      await svc.from("events").delete().eq("entity_id", l.id);
      await svc.from("share_links").delete().eq("id", l.id);
    }
    await svc.from("buyer_requirements").delete().eq("contact_id", contactId);
    await svc.from("viewings").delete().eq("contact_id", contactId);
  }
  if (leadId) {
    await svc.from("notification_jobs").delete().eq("lead_id", leadId);
    await svc.from("tasks").delete().eq("lead_id", leadId);
    await svc.from("events").delete().eq("entity_id", leadId);
    await svc.from("leads").delete().eq("id", leadId);
  }
  if (contactId) {
    await svc.from("events").delete().eq("entity_id", contactId);
    await svc.from("contacts").delete().eq("id", contactId);
  }
  for (const id of propertyIds) {
    await svc.from("events").delete().eq("entity_id", id);
    await svc.from("properties").delete().eq("id", id);
  }
}

async function preferencesIsOpen(page: Page) {
  await expect(page.getByRole("tab", { name: /^preferences$/i })).toHaveAttribute("aria-selected", "true", {
    timeout: opTimeout(15_000),
  });
  await expect(page.getByRole("heading", { name: /^saved searches$/i })).toBeVisible();
}

test("a website brief becomes the existing contact's saved search from the inbox, and the link opens Preferences", async ({ page }) => {
  const svc = serviceClient();
  const { orgId } = await fixtureProfile(svc);
  const { data: contact, error: cErr } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: BUYER, contact_types: ["buyer"] })
    .select("id")
    .single();
  expect(cErr, "seeding the buyer").toBeNull();
  const { data: lead, error: lErr } = await svc
    .from("leads")
    .insert({
      org_id: orgId,
      source: "website",
      message: `Website enquiry ${TAG}`,
      contact_id: contact!.id,
      criteria: { looking_to: "buy", budget: "300_500k", buy_property_type: "villa" },
    })
    .select("id")
    .single();
  expect(lErr, "seeding the lead").toBeNull();

  try {
    await page.goto("/leads", { waitUntil: "networkidle" });
    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: BUYER, exact: true }) });
    await expect(row.getByRole("link", { name: "No saved search — add one" })).toBeVisible({
      timeout: opTimeout(15_000),
    });

    await row.getByRole("button", { name: /save brief as search/i }).click();
    await expect
      .poll(
        async () => {
          const { data } = await svc
            .from("buyer_requirements")
            .select("label, is_active, property_types, budget_max")
            .eq("contact_id", contact!.id);
          return data ?? [];
        },
        { timeout: opTimeout(15_000) },
      )
      .toEqual([{ label: "From website enquiry", is_active: true, property_types: ["villa"], budget_max: 500000 }]);

    const { data: added } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", contact!.id)
      .eq("event_type", "requirement_added");
    expect(added?.[0]?.payload, "the line names the lead it came from").toMatchObject({
      via: "website_enquiry",
      lead_id: lead!.id,
    });

    // the row now says so, and both states link to the contact's Preferences
    const saved = row.getByRole("link", { name: /^saved search$/i });
    await expect(saved).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(row.getByRole("button", { name: /save brief as search/i })).toHaveCount(0);
    await saved.click();
    await expect(page).toHaveURL(new RegExp(`/contacts/${contact!.id}\\?tab=preferences$`));
    await preferencesIsOpen(page);
    // the brief said budget and type — not where, not how big
    await expect(page.getByText(/Not stated: location, bedrooms/)).toBeVisible();

    // an unknown ?tab= opens Profile, as before
    await page.goto(`/contacts/${contact!.id}?tab=nonsense`, { waitUntil: "networkidle" });
    await expect(page.getByRole("tab", { name: /^profile$/i })).toHaveAttribute("aria-selected", "true");
  } finally {
    await cleanup(svc, contact?.id ?? null, lead?.id ?? null, []);
  }
});

test("ticked matches become ONE proposal bound to the buyer; Proposed shows on both sides; Viewing is prefilled; off-market asks first", async ({ page }) => {
  const svc = serviceClient();
  const { orgId } = await fixtureProfile(svc);
  const { data: district } = await svc.from("districts").select("id").eq("org_id", orgId).eq("code", "PAF").single();
  const { data: buyer, error: bErr } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: BUYER, contact_types: ["buyer"], languages: ["ru"] })
    .select("id")
    .single();
  expect(bErr, "seeding the buyer").toBeNull();
  const seed = (ref: string, title: string, visibility: string) => ({
    org_id: orgId,
    reference: ref,
    kind: "standalone",
    property_type: "villa",
    transaction_type: "sale",
    status: "available",
    visibility,
    district_id: district!.id,
    asking_price: 450000,
    bedrooms: 3,
    title: { en: title },
  });
  const { data: props, error: pErr } = await svc
    .from("properties")
    .insert([seed(REFS.a, TITLES.a, "private"), seed(REFS.b, TITLES.b, "private"), seed(REFS.c, TITLES.c, "off_market")])
    .select("id, reference");
  expect(pErr, "seeding the listings").toBeNull();
  const idOf = (ref: string) => props!.find((p) => p.reference === ref)!.id;
  const { error: rErr } = await svc.from("buyer_requirements").insert({
    org_id: orgId,
    contact_id: buyer!.id,
    label: `E2E villas ${TAG}`,
    transaction_type: "sale",
    property_types: ["villa"],
    district_ids: [district!.id],
    area_ids: [],
    features_required: [],
    title_deed_required: false,
    budget_max: 600000,
  });
  expect(rErr, "seeding the search").toBeNull();

  try {
    await page.goto(`/contacts/${buyer!.id}?tab=preferences`, { waitUntil: "networkidle" });
    await preferencesIsOpen(page);

    const pick = (ref: string) => page.getByRole("checkbox", { name: `Include ${ref} in the proposal` });
    await expect(pick(REFS.a)).toBeVisible({ timeout: opTimeout(15_000) });
    // nothing is pre-ticked: a proposal is a deliberate shortlist
    for (const ref of [REFS.a, REFS.b, REFS.c]) await expect(pick(ref)).not.toBeChecked();
    // the off-market listing is marked on its row — the chip, exactly: the row's
    // title link ("E2E off-market villa …") contains the word too
    await expect(page.getByRole("listitem").filter({ hasText: TITLES.c }).getByText("Off-market", { exact: true })).toBeVisible();

    // ---------- off-market asks first ----------
    await pick(REFS.c).check();
    const create = page.getByRole("button", { name: /^Create proposal for / });
    await expect(create).toBeDisabled();
    await expect(page.getByText("Confirm this buyer may see off-market listings first.")).toBeVisible();
    await page.getByRole("checkbox", { name: /this buyer may see off-market listings/i }).check();
    await expect(create).toBeEnabled();
    await pick(REFS.c).uncheck();

    // ---------- two ticked → one link ----------
    await pick(REFS.a).check();
    await pick(REFS.b).check();
    await expect(create).toHaveText(new RegExp(`Create proposal for ${BUYER} \\(2\\)`));
    await create.click();
    const shown = page.getByRole("textbox", { name: "Proposal link ready" });
    await expect(shown, "the link is shown once").toBeVisible({ timeout: opTimeout(15_000) });
    await expect(shown).toHaveValue(/\/p\/[A-Za-z0-9_-]{43}$/);

    const { data: links } = await svc.from("share_links").select("id, kind, locale, contact_id").eq("contact_id", buyer!.id);
    expect(links, "ONE proposal, bound to the buyer").toHaveLength(1);
    expect(links![0]).toMatchObject({ kind: "proposal", locale: "ru", contact_id: buyer!.id });
    const { data: held } = await svc.from("share_link_properties").select("property_id").eq("share_link_id", links![0]!.id);
    expect((held ?? []).map((h) => h.property_id).sort()).toEqual([idOf(REFS.a), idOf(REFS.b)].sort());

    // the rows now say so; the listing not proposed does not
    const rowA = page.getByRole("listitem").filter({ hasText: TITLES.a });
    await expect(rowA.getByText(/^Proposed /)).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(page.getByRole("listitem").filter({ hasText: TITLES.c }).getByText(/^Proposed /)).toHaveCount(0);
    // and the buyer's Proposals sent list has it
    await expect(page.getByText("2 listings")).toBeVisible();

    // ---------- the viewing, both parties filled in ----------
    await page.getByRole("button", { name: `Viewing — ${REFS.a} with ${BUYER}` }).click();
    const dialog = page.getByRole("dialog", { name: "Schedule viewing" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(TITLES.a)).toBeVisible();
    await expect(dialog.getByText(BUYER)).toBeVisible();
    await page.keyboard.press("Escape");

    // ---------- the listing's side ----------
    await page.goto(`/properties/${idOf(REFS.a)}?tab=buyers`, { waitUntil: "networkidle" });
    const buyerRow = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: BUYER, exact: true }) });
    await expect(buyerRow.getByText(/^Proposed /)).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(buyerRow.getByRole("button", { name: `Proposal — ${REFS.a} for ${BUYER}` })).toBeVisible();
    await expect(buyerRow.getByRole("button", { name: `Viewing — ${REFS.a} with ${BUYER}` })).toBeVisible();

    // ---------- a proposal from the listing's side: only Done ends the link (A04 review) ----------
    await buyerRow.getByRole("button", { name: `Proposal — ${REFS.a} for ${BUYER}` }).click();
    const single = page.getByRole("dialog", { name: `Proposal for ${BUYER}` });
    await expect(single).toBeVisible();
    await single.getByRole("button", { name: "Create proposal", exact: true }).click();
    const fromListing = single.getByRole("textbox", { name: "Proposal link ready" });
    await expect(fromListing, "the link is shown once").toBeVisible({ timeout: opTimeout(15_000) });
    const once = await fromListing.inputValue();
    // the one copy there will ever be: neither Escape nor a click beside the
    // dialog throws it away, and there is no corner X while it is shown
    await page.keyboard.press("Escape");
    await expect(fromListing).toHaveValue(once);
    await page.mouse.click(4, 4);
    await expect(fromListing).toHaveValue(once);
    await expect(single.getByRole("button", { name: "Close" })).toHaveCount(0);
    await single.getByRole("button", { name: "Done" }).click();
    await expect(single).toBeHidden();
    // reopened, it offers a NEW proposal — the shown link is not kept anywhere
    await buyerRow.getByRole("button", { name: `Proposal — ${REFS.a} for ${BUYER}` }).click();
    await expect(single.getByRole("button", { name: "Create proposal", exact: true })).toBeVisible();
    await expect(single.getByRole("textbox", { name: "Proposal link ready" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(single, "with no link shown, Escape closes it as before").toBeHidden();

    // nothing was sent: no viewing was created, and the only new links are the two minted
    const { data: viewings } = await svc.from("viewings").select("id").eq("contact_id", buyer!.id);
    expect(viewings).toEqual([]);
    const { data: minted } = await svc.from("share_links").select("id").eq("contact_id", buyer!.id);
    expect(minted, "the contact side's proposal and the listing side's").toHaveLength(2);
  } finally {
    await cleanup(svc, buyer?.id ?? null, null, (props ?? []).map((p) => p.id));
  }
});
