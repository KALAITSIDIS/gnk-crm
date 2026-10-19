import { createHash, randomBytes } from "node:crypto";
import { test, expect, request as pwRequest, type Dialog, type Locator, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { portalById } from "@/lib/services/portals/registry";
import {
  assertNoHorizontalOverflow,
  assertNoProblems,
  baseUrl,
  fixtureProfile,
  isLocal,
  opTimeout,
  runTag,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * Enable a portal → select a listing → the feed carries it → remove → gone →
 * disable → the empty document. The whole loop the spec promises, through the
 * two UI surfaces and the public route, with the anonymous fetch a portal's
 * crawler would make. Runs in the desktop AND mobile projects; the overflow
 * and in-viewport assertions are the only measurement these two routes get at
 * phone width.
 *
 * WHAT THE CRM CAN SAY (portal integrations audit 2026-10-18). The cards say
 * "selected", "in the feed" and "feed URL last requested" — never that the
 * portal published anything. Every request with the valid token is RECORDED
 * (0150 record_portal_pull) through the service role AFTER the response has
 * gone (`after()`), so the record is polled for, never read straight after
 * the request.
 */
const PORTAL_ID = "jamesedition";
const PORTAL_NAME = "JamesEdition";
/** The photo floor is the registry's, not a number copied into a fixture. */
const MIN_PHOTOS = portalById(PORTAL_ID)!.requirements.minPhotos;
/**
 * Both the populated and the empty Kyero document carry this header
 * (dialects/kyero.ts HEADER). Whitespace-tolerant: since 2026-10-18 the
 * renderer puts one element per line, so the old one-line literal
 * `<kyero><feed_version>3</feed_version></kyero>` no longer occurs in either.
 */
const KYERO_ANCHOR = /<kyero>\s*<feed_version>3<\/feed_version>\s*<\/kyero>/;
/** The crawler's user-agent, so this run's pull record is told apart from any other request. */
const CRAWLER_UA = "gnk-e2e-portal-check/1.0";

test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

/**
 * Radix sometimes ignores a synthetic click on a tab trigger (HANDOFF §7).
 * The fallback lives here rather than at the first call site: a spec that
 * guarded one of its three tab switches and left the other two bare would be
 * flaky in the two places nobody thought about.
 */
async function openTab(page: Page, name: string) {
  const trigger = page.getByRole("tab", { name });
  await trigger.click();
  const panel = page.getByRole("tabpanel", { name });
  if (!(await panel.isVisible().catch(() => false))) {
    await trigger.dispatchEvent("mousedown");
  }
  await expect(panel).toBeVisible();
}

/**
 * Click a control that may raise a `window.confirm`, and accept it. Playwright
 * DISMISSES a dialog nobody handles — `confirm()` returns false and the click
 * silently does nothing — so the settings card's "Disable …?" question, and
 * its "Enable …? N of its selected listings go back into its feed" when
 * earlier selections survive (portal_listings has no foreign key to the
 * connection, so the pre-step's delete keeps them), would leave the toggle
 * where it was. The handler lives for this one click. Returns the question
 * asked, or null when none was.
 */
async function clickAccepting(page: Page, target: Locator): Promise<string | null> {
  let asked: string | null = null;
  const accept = (dialog: Dialog) => {
    asked = dialog.message();
    void dialog.accept();
  };
  page.on("dialog", accept);
  try {
    await target.click();
  } finally {
    page.off("dialog", accept);
  }
  return asked;
}

/** The connection's pull facts as 0150 records them — read with the service role, never through the page. */
async function pullFacts(svc: SupabaseClient, orgId: string) {
  const { data, error } = await svc
    .from("portal_connections")
    .select("id, last_pulled_at, last_pulled_ua, last_pull_outcome, last_pull_count, last_success_at")
    .eq("org_id", orgId)
    .eq("portal", PORTAL_ID)
    .single();
  if (error) throw new Error(`reading the ${PORTAL_ID} connection: ${error.message}`);
  return data as {
    id: string;
    last_pulled_at: string | null;
    last_pulled_ua: string | null;
    last_pull_outcome: string | null;
    last_pull_count: number | null;
    last_success_at: string | null;
  };
}

async function seedPublicListing(svc: SupabaseClient, orgId: string, tag: string) {
  // Scoped by org: `districts.code` is unique per org, not globally.
  const { data: district, error: dErr } = await svc
    .from("districts")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", "PAF")
    .single();
  if (dErr) throw new Error(`no PAF district for the fixture org: ${dErr.message}`);
  const reference = `E2EPRT${tag}`.slice(0, 20).toUpperCase();
  const { data: prop, error } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference,
      property_type: "villa",
      transaction_type: "sale",
      status: "available",
      visibility: "public",
      published_at: new Date().toISOString(),
      district_id: district!.id,
      // JamesEdition's moderation floor is EUR 450,000 (registry `moderation`);
      // this is not under it, so the card shows no advisory for it
      asking_price: 450000,
      currency: "EUR",
      bedrooms: 3,
      bathrooms: 2,
      covered_area_sqm: 180,
      title: { en: "E2E portal villa" },
      // Greek is here so `not.toContain("<el>")` below is an assertion that can
      // FAIL: Kyero has no Greek node, and a renderer that grew one would be
      // invisible to a fixture with no Greek to emit.
      public_description: { en: "Portal e2e listing.", el: "Καταχώριση e2e." },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  // TWO LOAD-BEARING COLUMNS, and deliberately nothing else:
  //   path_full — public_listings() withholds a photo that has none
  //               (0086_etag_covers_alt.sql:69), so the listing would reach the
  //               site feed with an empty images array.
  //   path_jpeg — portal_feed_supplement() (0150) returns only photos that
  //               have one, and carries `alt` and the original's size beside it.
  // `alt` is NOT NULL and PostgREST sends null for a key missing from a
  // multi-row insert, so every row states it. The rest of the production shape
  // — storage_path_original, path_thumb, path_card, width, height,
  // content_sha256, created_by — is absent on purpose: this fixture exists to
  // be SELECTED by those two functions, and a column neither of them reads
  // would only prove the seed writer had read the table. (No width/height
  // also means JamesEdition's 800×600 minimum does not bite: an unmeasured
  // photo is never counted as too small — eligibility.ts acceptedPhotoCount.)
  //
  // ONE ROW MORE THAN THE MINIMUM, and the extra one has NO `path_jpeg`. That
  // last row is the whole of what the settings page's backfill warning counts,
  // and it has to be a third photo rather than one of the two: the listing
  // must still clear JamesEdition's minimum, so the warning is measured
  // without changing what the feed is entitled to carry. The supplement
  // filters `path_jpeg is not null`, so this row must be absent from the XML.
  const { error: mErr } = await svc.from("property_media").insert(
    Array.from({ length: MIN_PHOTOS + 1 }, (_, i) => ({
      org_id: orgId,
      property_id: prop.id,
      kind: "photo",
      path_full: `properties/${prop.id}/${tag}_${i + 1}_full.webp`,
      path_jpeg: i === MIN_PHOTOS ? null : `properties/${prop.id}/${tag}_${i + 1}_jpeg.jpg`,
      is_cover: i === 0,
      sort_order: i,
      alt: {},
    })),
  );
  if (mErr) {
    // The caller's `finally` does not own this row yet, so nothing else would
    // ever delete it: a public, published, available listing would survive in
    // public_listings() and in every later portal feed.
    const { error: rollback } = await svc.from("properties").delete().eq("id", prop.id);
    throw new Error(
      `seeding media failed: ${mErr.message}` +
        (rollback ? ` — AND the property survived: ${rollback.message}` : ""),
    );
  }
  return {
    id: prop.id as string,
    reference,
    /** the photo with no JPEG rendition: counted by the settings page, absent from the feed */
    unpreparedStem: `${tag}_${MIN_PHOTOS + 1}`,
  };
}

test("enable → select → feed → remove → gone → disable → empty", async ({ page }) => {
  const svc = serviceClient();
  const { orgId } = await fixtureProfile(svc);
  const tag = runTag().replace(/-/g, "");

  // The connection is REMOVED before the run as well as after it (0097). The
  // unconditional `Enable` below exists to prove the enable path is exercised
  // every time, and since 0097 the feed URL is shown only by the call that
  // mints its token — the first enable of a connection, or Regenerate. A row
  // left over from an earlier run would make this Enable a plain toggle that
  // shows no URL, so the run starts from no row at all, which already reads
  // "Enable". (Until 2026-09-15 this only switched the row off; the shared
  // local stack once had it enabled by hand, 2026-09-14.) Its pull history
  // and export dates (0150 portal_pull_log, portal_export_state) cascade with
  // it, so every pull fact read below is this run's.
  const { error: preErr } = await svc
    .from("portal_connections")
    .delete()
    .eq("org_id", orgId)
    .eq("portal", PORTAL_ID);
  if (preErr) throw new Error(`could not remove the ${PORTAL_ID} connection: ${preErr.message}`);

  // BEFORE the seed, and outside the `try` so the `finally` can dispose it
  // however the test ends. Before, because nothing here needs the listing and
  // a throw after the seed would strand a public, published, available row
  // with no `finally` yet in scope to take it away.
  const api = await pwRequest.newContext({ baseURL: baseUrl(), userAgent: CRAWLER_UA });

  // The settings page counts the org's photos that have no JPEG rendition, so
  // the number it shows is a DELTA over whatever this database already holds —
  // test residue elsewhere would otherwise make a hardcoded "1" fail for a
  // reason that has nothing to do with portals. Measured before the seed, with
  // the same filter the page's RLS-scoped read uses (0002_rls_policies.sql:171
  // scopes property_media SELECT to the org and nothing narrower).
  const { count: unpreparedBefore, error: countErr } = await svc
    .from("property_media")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("kind", "photo")
    .is("path_jpeg", null);
  if (countErr) throw new Error(`counting unprepared photos: ${countErr.message}`);
  // The seed adds exactly one such photo — see seedPublicListing.
  const expectedUnprepared = (unpreparedBefore ?? 0) + 1;

  const listing = await seedPublicListing(svc, orgId, tag);
  const problems = watchForProblems(page);

  try {
    // 1. Settings → Portals: enable JamesEdition. UNCONDITIONAL, because the
    // `finally` removes the connection — so this is a first enable every run
    // in both projects, not a branch that residue can skip.
    await page.goto("/settings/portals");
    await expect(page.getByTestId(`portal-card-${PORTAL_ID}`)).toBeVisible();
    await assertNoHorizontalOverflow(page, "settings/portals");

    // The backfill warning. It stands between a migrated database and an empty
    // feed — a photo with no JPEG is invisible to every portal — and this is
    // the only suite that renders the page it lives on.
    const unprepared = page.getByTestId("portal-photos-unprepared");
    await expect(unprepared).toBeVisible();
    await expect(unprepared).toContainText(
      `${expectedUnprepared} ${expectedUnprepared === 1 ? "photo is" : "photos are"} not yet prepared`,
    );
    await expect(unprepared).toContainText("media:backfill-jpeg");

    // The card never claims publication: no portal reports back.
    await expect(page.getByTestId(`portal-publication-${PORTAL_ID}`)).toContainText("Publication not verified");

    const toggle = page.getByTestId(`portal-toggle-${PORTAL_ID}`);
    await expect(toggle).toHaveText("Enable");
    // Asks only when earlier selections for this portal survive in the org —
    // and then the click must not be dismissed (see clickAccepting).
    const enableAsked = await clickAccepting(page, toggle);
    if (enableAsked !== null) expect(enableAsked).toContain(`Enable ${PORTAL_NAME}?`);
    await expect(toggle).toHaveText("Disable");
    const feedInput = page.getByTestId(`portal-feed-url-${PORTAL_ID}`);
    await expect(feedInput).toHaveValue(new RegExp(`/api/portals/${PORTAL_ID}/[0-9a-f]{64}$`));
    const feedUrl = await feedInput.inputValue();
    const feedPath = feedUrl.replace(/^https?:\/\/[^/]+/, "");
    // a fresh connection: nothing has asked for its feed yet, and the card says so
    await expect(page.getByTestId(`portal-health-${PORTAL_ID}`)).toContainText("never been requested");
    // a pending portal shows the badge and no toggle
    await expect(page.getByTestId("portal-card-bazaraki")).toContainText("Not available yet");
    await expect(page.getByTestId("portal-toggle-bazaraki")).toHaveCount(0);

    // 2. The listing's Marketing tab: select the portal
    await page.goto(`/properties/${listing.id}`);
    if (test.info().project.name === "mobile") {
      // Ten tabs overflow 390px. `justify-start` on the strip is what keeps its
      // FIRST tab reachable at scrollLeft 0 — a centred overflowing strip hides
      // its own start, and scrolling right never brings it back. The check is
      // HORIZONTAL: since the review's summary strip and readiness panel
      // (2026-10-18) the strip sits below a phone's first screen, so bring it
      // into vertical view first — by the page's scroll, never the strip's.
      await page.getByRole("tablist").first().evaluate((el) => {
        window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 8 });
      });
      await expect(page.getByRole("tab", { name: "Overview" })).toBeInViewport({ ratio: 1 });
    }
    await openTab(page, "Marketing");
    await expect(page.getByTestId("portals-card")).toBeVisible();
    await assertNoHorizontalOverflow(page, "property Marketing tab");
    const state = page.getByTestId(`portal-state-${PORTAL_ID}`);
    await expect(state).toHaveText("Not selected");
    await expect(page.getByTestId(`portal-row-${PORTAL_ID}`)).toContainText("The feed URL has not been requested yet");
    const select = page.getByTestId(`portal-select-${PORTAL_ID}`);
    await expect(select).toHaveText("Select");
    await expect(select).toBeEnabled();
    await select.click();
    await expect(select).toHaveText("Remove");
    // "in the feed" — what the CRM knows — never "on JamesEdition"
    await expect(state).toHaveText("Selected · in the feed this portal is offered");

    // 3. The portal's view: anonymous, no cookies
    const res = await api.get(feedPath);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/xml");
    // a served document is cacheable and carries its own digest as the ETag
    expect(res.headers()["cache-control"]).toBe("public, max-age=300");
    expect(res.headers()["etag"]).toBeTruthy();
    const xml = await res.text();
    expect(xml).toContain(`<ref>${listing.reference}</ref>`);
    expect(xml).toContain(`/media/properties/${listing.id}/${tag}_1_jpeg.jpg`);
    // …and the photo with no JPEG rendition is invisible to the portal: neither
    // its jpeg (there is none) nor its webp reaches the document.
    expect(xml).not.toContain(listing.unpreparedStem);
    expect(xml).not.toContain("<el>");

    // The request is recorded through the service role after the response:
    // last_pulled_* is still written (now with its outcome), and the history
    // gains a run. Polled, because the record lands after the bytes do.
    await expect
      .poll(async () => (await pullFacts(svc, orgId)).last_pulled_ua, { timeout: opTimeout(15_000) })
      .toBe(CRAWLER_UA);
    const served = await pullFacts(svc, orgId);
    expect(served.last_pulled_at).not.toBeNull();
    expect(served.last_pull_outcome).toBe("served");
    expect(served.last_success_at).not.toBeNull();
    // at least this listing; other selections in the org may ride along
    expect(served.last_pull_count ?? 0).toBeGreaterThanOrEqual(1);
    const { data: runs, error: runsErr } = await svc
      .from("portal_pull_log")
      .select("outcome, served, selected, ua")
      .eq("connection_id", served.id)
      .order("last_at", { ascending: false })
      .order("id", { ascending: false });
    if (runsErr) throw new Error(`reading the pull history: ${runsErr.message}`);
    expect(runs?.[0]).toMatchObject({ outcome: "served", ua: CRAWLER_UA });
    expect((runs?.[0] as { served: number | null }).served ?? 0).toBeGreaterThanOrEqual(1);

    // 4. The timeline names the portal, not its id
    await openTab(page, "Activity");
    await expect(page.getByText(`Selected for portal ${PORTAL_NAME}`)).toBeVisible();

    // 5. Remove → gone
    await openTab(page, "Marketing");
    await expect(select).toHaveText("Remove");
    await select.click();
    await expect(select).toHaveText("Select");
    await expect(state).toHaveText("Not selected");
    const after = await api.get(feedPath);
    expect(after.status()).toBe(200);
    const afterXml = await after.text();
    expect(afterXml).not.toContain(`<ref>${listing.reference}</ref>`);
    // …and what came back is still the live Kyero document, not a 200 carrying
    // an error page — which would also "not contain" the reference.
    expect(afterXml).toMatch(KYERO_ANCHOR);
    // the timeline says what happened — deselected — not that the portal removed it
    await openTab(page, "Activity");
    await expect(page.getByText(`Deselected for portal ${PORTAL_NAME}`)).toBeVisible();

    // 6. Settings → Portals: the request is reported as a request, then disable
    await page.goto("/settings/portals");
    const health = page.getByTestId(`portal-health-${PORTAL_ID}`);
    await expect(health).toContainText("Feed URL last requested");
    await expect(health).toContainText(`(reported as ${CRAWLER_UA})`);
    await expect(toggle).toHaveText("Disable");
    // Disabling ALWAYS asks — it empties the feed, which tells the portal to
    // remove what it was offered — and an unhandled dialog would cancel it.
    const disableAsked = await clickAccepting(page, toggle);
    expect(disableAsked).toContain(`Disable ${PORTAL_NAME}?`);
    await expect(toggle).toHaveText("Enable");

    // A disabled portal's feed is a VALID empty document, never cached, so
    // flipping the switch back is seen at the very next request — and never a
    // 404, which a portal would read as a broken feed and keep the stale copy.
    const disabled = await api.get(feedPath);
    expect(disabled.status()).toBe(200);
    expect(disabled.headers()["cache-control"]).toBe("no-store");
    const disabledXml = await disabled.text();
    expect(disabledXml).toMatch(KYERO_ANCHOR);
    expect(disabledXml).not.toContain("<property>");
    await expect
      .poll(async () => (await pullFacts(svc, orgId)).last_pull_outcome, { timeout: opTimeout(15_000) })
      .toBe("disabled");

    // 7. The wrong token is a 404, not a hint
    const bad = await api.get(`/api/portals/${PORTAL_ID}/${"0".repeat(64)}`);
    expect(bad.status()).toBe(404);

    assertNoProblems(problems, "portals loop");
  } finally {
    // EVERY cleanup runs and every cleanup reports: one failing must not leave
    // another undone, which is why the disposal is caught rather than allowed
    // to throw past the two database writes below. A zero-row write is a
    // refusal, not success — the house rule in lib/actions/portals.ts:16-18.
    const faults: string[] = [];
    await api.dispose().catch((e: unknown) => faults.push(`api.dispose: ${String(e)}`));

    // The connection goes, so the next run's Enable is a first enable again
    // and mints a URL it can read (see the pre-step); its pull history and
    // export dates cascade with it. Zero rows is legitimate HERE AND ONLY
    // HERE — the test may have failed before the enable, in which case there
    // is no connection to remove.
    const restored = await svc
      .from("portal_connections")
      .delete({ count: "exact" })
      .eq("org_id", orgId)
      .eq("portal", PORTAL_ID);
    if (restored.error) faults.push(`portal_connections removal: ${restored.error.message}`);
    else if ((restored.count ?? 0) > 1) {
      faults.push(`portal_connections removal touched ${restored.count} rows`);
    }

    // The seed MUST go: it is public, published and available, so a survivor is
    // a permanent listing in public_listings() and in every later portal feed.
    const removed = await svc
      .from("properties")
      .delete({ count: "exact" })
      .eq("id", listing.id); // media and selection cascade
    if (removed.error) faults.push(`seed delete: ${removed.error.message}`);
    else if (removed.count !== 1) faults.push(`seed delete removed ${removed.count} rows, not 1`);

    if (faults.length) throw new Error(`cleanup failed — ${faults.join("; ")}`);
  }
});

/**
 * A reason's "Fix" link opens the tab that fixes it — from the SAME page
 * (portal integrations audit 2026-10-18, review). The Portals card sits on the
 * Marketing tab and its links are `?tab=…` on the page already open: an
 * uncontrolled tab strip read `?tab=` once, at mount, and stayed on Marketing.
 * A Place in the Sun (one photo) with every JPEG removed makes the listing
 * `too_few_photos`, whose fix is the Media tab. Connection and selection are
 * written with the service role — this test is about the link, not the loop.
 */
test("a portal reason's Fix link opens the tab that fixes it, from the same page", async ({ page }) => {
  const svc = serviceClient();
  const { orgId } = await fixtureProfile(svc);
  const tag = `FX${runTag().replace(/-/g, "")}`;
  const FIX_PORTAL = "aplaceinthesun";

  const { data: existing, error: readErr } = await svc
    .from("portal_connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("portal", FIX_PORTAL);
  if (readErr) throw new Error(`reading the ${FIX_PORTAL} connection: ${readErr.message}`);
  const createdConnection = (existing ?? []).length === 0;
  if (createdConnection) {
    const digest = createHash("sha256").update(randomBytes(32).toString("hex")).digest("hex");
    const { error } = await svc
      .from("portal_connections")
      .insert({ org_id: orgId, portal: FIX_PORTAL, enabled: true, feed_token_sha256: digest });
    if (error) throw new Error(`creating the ${FIX_PORTAL} connection: ${error.message}`);
  } else {
    const { error } = await svc.from("portal_connections").update({ enabled: true }).eq("org_id", orgId).eq("portal", FIX_PORTAL);
    if (error) throw new Error(`enabling the ${FIX_PORTAL} connection: ${error.message}`);
  }

  const listing = await seedPublicListing(svc, orgId, tag);
  try {
    // no JPEG at all: below A Place in the Sun's one photo
    const { error: mErr } = await svc.from("property_media").update({ path_jpeg: null }).eq("property_id", listing.id);
    if (mErr) throw new Error(`clearing the JPEGs: ${mErr.message}`);
    const { error: sErr } = await svc
      .from("portal_listings")
      .insert({ org_id: orgId, property_id: listing.id, portal: FIX_PORTAL, selected_by: null });
    if (sErr) throw new Error(`selecting the listing: ${sErr.message}`);

    await page.goto(`/properties/${listing.id}`);
    await openTab(page, "Marketing");
    const row = page.getByTestId(`portal-row-${FIX_PORTAL}`);
    await expect(row.getByTestId(`portal-state-${FIX_PORTAL}`)).toContainText("left out of the feed");
    await row.getByRole("link", { name: "Fix" }).first().click();
    await expect(page).toHaveURL(/[?&]tab=media(&|$)/);
    await expect(page.getByRole("tabpanel", { name: /Media/ })).toBeVisible();
    // and clicking a tab writes the URL back, so a second Fix click works too
    await openTab(page, "Marketing");
    await expect(page).toHaveURL(/[?&]tab=marketing(&|$)/);
  } finally {
    const faults: string[] = [];
    const removed = await svc.from("properties").delete({ count: "exact" }).eq("id", listing.id); // media and selection cascade
    if (removed.error) faults.push(`seed delete: ${removed.error.message}`);
    else if (removed.count !== 1) faults.push(`seed delete removed ${removed.count} rows, not 1`);
    if (createdConnection) {
      const gone = await svc.from("portal_connections").delete().eq("org_id", orgId).eq("portal", FIX_PORTAL);
      if (gone.error) faults.push(`connection removal: ${gone.error.message}`);
    }
    if (faults.length) throw new Error(`cleanup failed — ${faults.join("; ")}`);
  }
});
