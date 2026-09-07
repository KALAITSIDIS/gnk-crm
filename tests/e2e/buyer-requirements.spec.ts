import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * A saved search, end to end — the flow with NO e2e coverage at all until now,
 * and the entry point to the matching engine this product is sold on.
 *
 * Measured on the live database 2026-09-07: `buyer_requirements` held ZERO
 * rows. The listing half has been used properly; this half has never been used
 * once. So nothing had ever proven that what the FORM collects is what the
 * MATCHER reads — and the two are connected by nothing but agreement.
 *
 * The specific trap this pins: property types, districts, areas and features
 * are repeated checkbox inputs. `Object.fromEntries(formData.entries())` keeps
 * only the LAST value of a repeated key, so the action has to reach for
 * `getAll` on each of them (lib/actions/buyer-requirements.ts). Get that wrong
 * and a buyer who wants a villa OR a house is recorded as wanting only a
 * house, silently, and the desk rings the wrong people — a defect no unit test
 * of the action would catch, because the bug lives in the shape of the form.
 */
const CONTACT_NAME = "E2EReqBuyer";
const REF = "E2EREQ01";
const LABEL = "E2E sea-view villa, Paphos";
const VILLA_TITLE = "E2E requirement fixture villa";
const RETIRED_REF = "E2EREQ02";
const RENT_REF = "E2EREQ03";
const RENT_TITLE = "E2E requirement rental flat";
const RETIRED_TITLE = "E2E requirement retired villa";

/**
 * Saved searches and their matches live behind the Preferences tab, and the
 * tab's content is not mounted until it is opened — so every fresh load has to
 * come through here. (After a reload the tab resets to Profile; asserting on
 * the card without this waits 240s for an element that was never rendered.)
 */
async function openPreferences(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /^preferences$/i }).click();
  await expect(page.getByRole("heading", { name: /^saved searches$/i })).toBeVisible({
    timeout: opTimeout(15_000),
  });
}

/** The "Saved searches" section — the page has other controls of the same name. */
function savedSearches(page: Page) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^saved searches$/i }) });
}

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: contacts } = await svc.from("contacts").select("id").eq("first_name", CONTACT_NAME);
  for (const c of contacts ?? []) {
    await svc.from("buyer_requirements").delete().eq("contact_id", c.id);
    await svc.from("events").delete().eq("entity_id", c.id);
    await svc.from("contacts").delete().eq("id", c.id);
  }
  await svc.from("properties").delete().eq("reference", REF);
  await svc.from("properties").delete().eq("reference", RETIRED_REF);
  await svc.from("properties").delete().eq("reference", RENT_REF);
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("a saved search records what the buyer said, and the matcher reads exactly that", async ({
  page,
}) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);

  // A district to tick, and a villa that ought to match the search below.
  const { data: district } = await svc
    .from("districts")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();
  // `districts.name` is localised jsonb, not text — the form renders `.en`.
  const districtName = (district!.name as { en?: string }).en!;
  expect(districtName, "the district fixture must carry an English name to tick").toBeTruthy();
  const { data: buyer, error: buyerErr } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: CONTACT_NAME, contact_types: ["buyer"] })
    .select("id")
    .single();
  expect(buyerErr, "seeding the buyer").toBeNull();
  const { data: villa, error: villaErr } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference: REF,
      kind: "standalone",
      property_type: "villa",
      transaction_type: "sale",
      status: "available",
      visibility: "private",
      district_id: district!.id,
      asking_price: 450000,
      bedrooms: 3,
      bathrooms: 2,
      covered_area_sqm: 185,
      title: { en: VILLA_TITLE },
    })
    .select("id")
    .single();
  expect(villaErr, "seeding the villa").toBeNull();

  /*
   * An identical villa that has been RETIRED. Same district, same price, same
   * bedrooms — the only difference is `visibility: "archived"`, which is how a
   * listing is taken off the books (the other half of `status: "withdrawn"`).
   *
   * It must never be proposed. Until 2026-09-07 it was: the matcher filtered
   * status and kind but not visibility, so a listing the properties list, the
   * quality worklist and the container-unit reader all refuse to show was
   * still offered to buyers. On production that was five units archived
   * precisely BECAUSE their data was fabricated.
   */
  const { error: retiredErr } = await svc.from("properties").insert({
    org_id: orgId,
    reference: RETIRED_REF,
    kind: "standalone",
    property_type: "villa",
    transaction_type: "sale",
    status: "available",
    visibility: "archived",
    district_id: district!.id,
    asking_price: 450000,
    bedrooms: 3,
    bathrooms: 2,
    covered_area_sqm: 185,
    title: { en: RETIRED_TITLE },
  });
  expect(retiredErr, "seeding the retired villa").toBeNull();

  try {
    await page.goto(`/contacts/${buyer!.id}`, { waitUntil: "networkidle" });
    await openPreferences(page);

    // ---------- record what the buyer wants ----------
    await page.getByRole("button", { name: /^add search$/i }).click();
    await page.getByLabel(/name this search/i).fill(LABEL);
    await page.getByLabel(/budget max/i).fill("500000");
    await page.getByLabel(/bedrooms min/i).fill("3");

    // TWO property types — the repeated-key trap. A buyer who would take a
    // villa or a house must be recorded as wanting both.
    const types = page.getByRole("group", { name: /property types/i });
    await types.getByRole("checkbox", { name: /^villa$/i }).check();
    await types.getByRole("checkbox", { name: /^house$/i }).check();
    await page
      .getByRole("group", { name: /districts/i })
      .getByRole("checkbox", { name: districtName, exact: true })
      .check();

    // The submit is labelled "Add search" as well — the trigger is replaced by
    // the form, so only one button of that name exists at a time. Scoped to the
    // form so this cannot silently re-click the trigger if that ever changes.
    const form = page.locator("form").filter({ has: page.getByLabel(/name this search/i) });
    await form.getByRole("button", { name: /^add search$/i }).click();

    // ---------- the row says what the form said ----------
    await expect
      .poll(
        async () => {
          const { data } = await svc
            .from("buyer_requirements")
            .select("id")
            .eq("contact_id", buyer!.id);
          return data?.length ?? 0;
        },
        { timeout: opTimeout(15_000) },
      )
      .toBe(1);

    const { data: saved } = await svc
      .from("buyer_requirements")
      .select(
        "id, label, transaction_type, property_types, district_ids, budget_max, bedrooms_min, is_active",
      )
      .eq("contact_id", buyer!.id)
      .single();

    expect(saved!.label).toBe(LABEL);
    expect(saved!.transaction_type).toBe("sale");
    // THE TRAP: both types survive. `Object.fromEntries` would have kept one.
    expect(
      [...(saved!.property_types as string[])].sort(),
      "a buyer who would take either must be recorded as wanting both",
    ).toEqual(["house", "villa"]);
    expect(saved!.district_ids).toEqual([district!.id]);
    expect(Number(saved!.budget_max)).toBe(500000);
    expect(saved!.bedrooms_min).toBe(3);
    expect(saved!.is_active, "a new search is live — nothing else switches it on").toBe(true);

    // the save is evented against the CONTACT, which is whose search it is
    const { data: added } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", buyer!.id)
      .eq("event_type", "requirement_added");
    expect(added, "recording a search is a state change, so it owes an event").toHaveLength(1);

    // ---------- and the matcher uses it ----------
    // The whole point of the flow: the search the desk typed reaches the
    // engine and names a property the desk can ring about.
    await page.reload({ waitUntil: "networkidle" });
    await openPreferences(page);
    await expect(page.getByText(LABEL).first()).toBeVisible({ timeout: opTimeout(15_000) });
    // The match links by TITLE (matches-card falls back to the reference only
    // when a listing has no title), so the reference is asserted as the line
    // underneath it — both, because the desk rings on the reference.
    await expect(
      page.getByRole("link", { name: VILLA_TITLE }),
      "the villa this search describes appears under it",
    ).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(page.getByText(new RegExp(REF)).first()).toBeVisible();
    // ...and the retired twin is not, though it fits the search exactly
    await expect(
      page.getByRole("link", { name: RETIRED_TITLE }),
      "an archived listing is off the books — proposing it undoes the archiving",
    ).toHaveCount(0);

    // ---------- archiving retires it, and the matches go with it ----------
    // SCOPED, not `.first()`: the contact header carries an "Archive" button of
    // its own (it archives the whole CONTACT, behind a window.confirm), and it
    // comes first in the DOM. An unscoped locator here clicks that one instead,
    // and the saved search never moves — which is exactly how this first read.
    await savedSearches(page).getByRole("button", { name: /^archive$/i }).first().click();
    await expect
      .poll(
        async () => {
          const { data } = await svc
            .from("buyer_requirements")
            .select("is_active")
            .eq("id", saved!.id)
            .single();
          return data?.is_active;
        },
        { timeout: opTimeout(15_000) },
      )
      .toBe(false);
    await expect(
      page.getByRole("link", { name: VILLA_TITLE }),
      "an archived search stops proposing anyone",
    ).toHaveCount(0, { timeout: opTimeout(15_000) });
  } finally {
    await svc.from("properties").delete().eq("id", villa!.id);
    await removeFixture(svc);
  }
});

test("a requirement cannot be moved to another buyer by posting a different contact", async ({
  page,
}) => {
  /*
   * THIS TEST POSTS THE FORGERY. An earlier version of it seeded a requirement
   * and then asserted the requirement still belonged to the buyer it was
   * seeded for — without ever attempting the reassignment. It could not fail,
   * which is worse than not existing: it reported a guard as covered.
   *
   * The guard is the action's, not the form's, because a form can post
   * anything: `contact_id` is a hidden input, and rewriting it before submit
   * is the whole attack. Reassigning a saved search would hand one buyer's
   * brief to another and the timeline would show it as an ordinary edit.
   */
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);
  const { data: pair, error: pairErr } = await svc
    .from("contacts")
    .insert([
      { org_id: orgId, first_name: CONTACT_NAME, last_name: "One", contact_types: ["buyer"] },
      { org_id: orgId, first_name: CONTACT_NAME, last_name: "Two", contact_types: ["buyer"] },
    ])
    .select("id");
  expect(pairErr, "seeding the pair").toBeNull();
  const [owner, other] = pair!;

  try {
    const { data: req, error: reqErr } = await svc
      .from("buyer_requirements")
      .insert({
        org_id: orgId,
        contact_id: owner.id,
        label: LABEL,
        transaction_type: "sale",
        property_types: [],
        district_ids: [],
        area_ids: [],
        features_required: [],
        title_deed_required: false,
      })
      .select("id")
      .single();
    expect(reqErr, "seeding the requirement").toBeNull();

    await page.goto(`/contacts/${owner.id}`, { waitUntil: "networkidle" });
    await openPreferences(page);
    await savedSearches(page).getByRole("button", { name: /^edit$/i }).first().click();

    const form = page.locator("form").filter({ has: page.getByLabel(/name this search/i) });
    await expect(form).toBeVisible({ timeout: opTimeout(15_000) });

    // Rewrite the hidden owner field, exactly as a tampered client would.
    const rewritten = await form.locator('input[name="contact_id"]').evaluate(
      (el, id) => {
        (el as HTMLInputElement).value = id;
        return (el as HTMLInputElement).value;
      },
      other.id,
    );
    expect(rewritten, "the forgery is in the form before submit").toBe(other.id);

    await form.getByRole("button", { name: /^save/i }).click();

    // the action REFUSES, in words, rather than silently reassigning
    await expect(
      form.getByRole("alert"),
      "the refusal is shown to whoever tried it",
    ).toHaveText(/cannot be moved to another contact/i, { timeout: opTimeout(15_000) });

    // and the row did not move
    const { data: after } = await svc
      .from("buyer_requirements")
      .select("contact_id")
      .eq("id", req!.id)
      .single();
    expect(after!.contact_id, "the brief still belongs to the buyer who gave it").toBe(owner.id);
    expect(after!.contact_id).not.toBe(other.id);

    // nor did it appear under the other buyer
    const { data: strayed } = await svc
      .from("buyer_requirements")
      .select("id")
      .eq("contact_id", other.id);
    expect(strayed, "and no brief was created on the other buyer either").toHaveLength(0);
  } finally {
    await removeFixture(svc);
  }
});

test("a rental match shows the RENT, not the sale price it does not have", async ({ page }) => {
  /*
   * The matcher compares a rental brief against `rent_price_month` — reading
   * `asking_price` would measure €250.000 against a €1.500 budget and reject
   * every rental in the database. The card did not share that rule: it printed
   * `asking_price` unconditionally, so a rent-only listing (which has none)
   * rendered "no price set" directly beside the chip saying the rent was
   * within budget.
   *
   * One rule now, exported from lib/services/matching.ts, for the budget check
   * and for what the desk reads.
   */
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);

  const { data: district } = await svc
    .from("districts")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();
  const { data: buyer, error: buyerErr } = await svc
    .from("contacts")
    .insert({ org_id: orgId, first_name: CONTACT_NAME, contact_types: ["buyer"] })
    .select("id")
    .single();
  expect(buyerErr, "seeding the buyer").toBeNull();

  // A LETTING: a monthly rent and no asking price at all.
  const { error: flatErr } = await svc.from("properties").insert({
    org_id: orgId,
    reference: RENT_REF,
    kind: "standalone",
    property_type: "apartment",
    transaction_type: "rent",
    status: "available",
    visibility: "private",
    district_id: district!.id,
    asking_price: null,
    rent_price_month: 1500,
    bedrooms: 2,
    bathrooms: 1,
    covered_area_sqm: 90,
    title: { en: RENT_TITLE },
  });
  expect(flatErr, "seeding the rental").toBeNull();

  const { error: reqErr } = await svc.from("buyer_requirements").insert({
    org_id: orgId,
    contact_id: buyer!.id,
    label: "E2E rental brief",
    transaction_type: "rent",
    property_types: ["apartment"],
    district_ids: [district!.id],
    area_ids: [],
    features_required: [],
    title_deed_required: false,
    budget_max: 2000,
  });
  expect(reqErr, "seeding the rental brief").toBeNull();

  try {
    await page.goto(`/contacts/${buyer!.id}`, { waitUntil: "networkidle" });
    await openPreferences(page);

    const match = page.locator("li").filter({ hasText: RENT_TITLE });
    await expect(match, "the rental matches the rental brief").toBeVisible({
      timeout: opTimeout(15_000),
    });

    const line = (await match.innerText()).replace(/\s+/g, " ");
    expect(
      line,
      "the rent is what this brief is about — printing the (absent) sale price " +
        "showed 'no price set' beside a chip saying it was within budget",
    ).not.toMatch(/no price set/i);
    expect(line.replace(/[^\d]/g, ""), "1.500, the monthly rent").toContain("1500");
  } finally {
    await removeFixture(svc);
  }
});
