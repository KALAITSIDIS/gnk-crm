import { test, expect, type Page, type Route } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  assertNoProblems,
  assertShellRendered,
  fixtureProfile,
  isLocal,
  opTimeout,
  runTag,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * Settings → Lead escalation (0107, audit 2026-09-22 finding 3).
 *
 * The policy itself — the reader, the working-time clock, the minting sweep,
 * the send-time rechecks — is proven against the database by
 * supabase/tests/lead-escalation.test.ts and against the worker by
 * lib/services/enquiry-alert-worker.test.ts. This spec covers what only the
 * running app can prove: the page renders at both widths (a settings sub-page
 * no suite visits ships unrendered — the portals spec's lesson), a save lands
 * in `cyprus_config.lead_escalation` in the exact shape the sweep reads and
 * reads back, and turning it on with nobody to tell is refused with a
 * sentence and writes nothing.
 *
 * Runs in the desktop AND mobile projects. Local only: it writes the row, and
 * it leaves the policy OFF whatever happens — the row it restores is the one
 * it found.
 */
test.describe("Settings → Lead escalation", () => {
  let before: unknown;

  test.beforeEach(async () => {
    test.skip(!isLocal(), "writes cyprus_config — local only, never production");
    const { data } = await serviceClient().from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    before = data!.value;
  });

  test.afterEach(async () => {
    if (!isLocal()) return;
    await serviceClient().from("cyprus_config").update({ value: before as never }).eq("key", "lead_escalation");
  });

  test("renders, saves an enabled policy with the admin as recipient, and reads it back in the sweep's shape", async ({ page }) => {
    const svc = serviceClient();
    const { id: adminId } = await fixtureProfile(svc);

    const problems = watchForProblems(page);
    await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
    await assertShellRendered(page);
    await assertNoHorizontalOverflow(page, "settings/lead-escalation");

    const enabled = page.getByRole("checkbox", { name: /escalate unanswered website enquiries/i });
    await expect(enabled, "seeded OFF").not.toBeChecked();
    await enabled.check();
    await page.getByLabel(/minutes without a first response/i).fill("20");
    await page.getByLabel(/ignore enquiries overdue for more than/i).fill("24");
    await page.locator(`input[name="recipients"][value="${adminId}"]`).check();
    // working hours on, Saturday added, 08:30–17:30
    const hoursOn = page.getByRole("checkbox", { name: /count the wait in working time only/i });
    if (!(await hoursOn.isChecked())) await hoursOn.check();
    await page.locator('input[name="days"][value="6"]').check();
    await page.getByLabel(/^from$/i).fill("08:30");
    await page.getByLabel(/^to$/i).fill("17:30");
    await page.getByRole("button", { name: /save escalation/i }).click();
    await expect(page.getByText(/lead escalation saved/i)).toBeVisible({ timeout: opTimeout(15_000) });

    const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    expect(data!.value).toEqual({
      enabled: true,
      after_minutes: 20,
      max_age_hours: 24,
      recipients: [adminId],
      working_hours: { days: [1, 2, 3, 4, 5, 6], start: "08:30", end: "17:30" },
      timezone: "Asia/Nicosia",
    });
    // the SQL reader sees exactly what the page wrote — no fallback fired
    const { data: seen } = await svc.rpc("lead_escalation_config");
    expect(seen).toEqual(data!.value);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("checkbox", { name: /escalate unanswered website enquiries/i })).toBeChecked();
    await expect(page.getByLabel(/minutes without a first response/i)).toHaveValue("20");
    await expect(page.locator(`input[name="recipients"][value="${adminId}"]`)).toBeChecked();
    await expect(page.locator('input[name="days"][value="6"]')).toBeChecked();
    assertNoProblems(problems, "settings/lead-escalation");
  });

  test("refuses to switch on with nobody to tell, with a sentence, and writes nothing", async ({ page }) => {
    await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
    await page.getByRole("checkbox", { name: /escalate unanswered website enquiries/i }).check();
    for (const box of await page.locator('input[name="recipients"]:not([disabled])').all()) {
      await box.uncheck();
    }
    await page.getByRole("button", { name: /save escalation/i }).click();
    await expect(page.getByText(/at least one/i)).toBeVisible({ timeout: opTimeout(15_000) });
    const { data } = await serviceClient().from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    expect(data!.value, "nothing was written").toEqual(before);
  });

  test("saving with working hours off stores null hours — the sweep then counts clock time", async ({ page }) => {
    const svc = serviceClient();
    const { id: adminId } = await fixtureProfile(svc);
    await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
    await page.locator(`input[name="recipients"][value="${adminId}"]`).check();
    const hoursOn = page.getByRole("checkbox", { name: /count the wait in working time only/i });
    if (await hoursOn.isChecked()) await hoursOn.uncheck();
    await page.getByRole("button", { name: /save escalation/i }).click();
    await expect(page.getByText(/lead escalation saved/i)).toBeVisible({ timeout: opTimeout(15_000) });
    const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    expect(data!.value).toMatchObject({ enabled: false, working_hours: null, recipients: [adminId] });
  });

  /**
   * 0112: the activation preview. What only the running page can prove —
   * the card renders from the form's UNSAVED values (a value typed, never
   * saved, still drives the answer), a fixture enquiry that has waited
   * twenty minutes is listed as one the sweep would mint and the worker
   * could send, a changed field marks the preview stale, and afterwards the
   * policy row is what it was and the enquiry has no escalation job. The
   * database half — every verdict, every reason, org scope, the write-nothing
   * proof — is supabase/tests/lead-escalation-preview.test.ts.
   */
  test("previews activation from the unsaved form, lists a waiting enquiry, goes stale on a change, and writes nothing", async ({ page }) => {
    const svc = serviceClient();
    const { id: adminId, orgId } = await fixtureProfile(svc);
    const { data: org } = await svc.from("organizations").select("slug").eq("id", orgId).single();
    const tag = runTag();
    // a website enquiry that has waited twenty minutes; the policy is OFF, so the five-minute cron leaves it alone
    const { data: door, error: doorErr } = await svc.rpc("submit_public_enquiry", {
      p_org_slug: org!.slug,
      p_name: `Preview ${tag}`,
      p_email: `preview-${tag}@example.invalid`,
      p_phone: "",
      p_message: `preview e2e ${tag}`,
      p_property_ref: "",
      p_idempotency_key: `preview-${tag}`,
    });
    expect(doorErr).toBeNull();
    const leadId = (door as Array<{ lead_id: string }>)[0]!.lead_id;
    await svc.from("leads").update({ received_at: new Date(Date.now() - 20 * 60_000).toISOString() }).eq("id", leadId);

    try {
      const problems = watchForProblems(page);
      await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
      // clock time, a fifteen-minute wait, a one-hour cutoff: the fixture is due whatever the hour, and residue older than an hour is not on the page
      const hoursOn = page.getByRole("checkbox", { name: /count the wait in working time only/i });
      if (await hoursOn.isChecked()) await hoursOn.uncheck();
      await page.getByLabel(/minutes without a first response/i).fill("15");
      await page.getByLabel(/ignore enquiries overdue for more than/i).fill("1");
      await page.locator(`input[name="recipients"][value="${adminId}"]`).check();

      await page.getByRole("button", { name: /preview activation/i }).click();
      const card = page.getByTestId("lead-escalation-preview");
      await expect(card).toBeVisible({ timeout: opTimeout(15_000) });
      await expect(card, "evaluated as if on, against a stored OFF").toContainText(/stored policy is currently OFF/i);
      await expect(card, "the wait typed, never saved, drove the answer").toContainText(/15 min of clock time/i);
      await expect(card.getByTestId(`preview-recipient-${adminId}`)).toContainText(/eligible/i);
      // the sender is reported apart from eligibility, from the server's environment: neither
      // the local stack nor CI sets a provider key, so it must say so rather than "armed"
      const sender = card.getByTestId("lead-escalation-preview-sender");
      await expect(sender).toHaveAttribute("data-sender-state", "not_configured");
      await expect(sender).toContainText(/NOT configured.*RESEND_API_KEY/);
      await expect(card, "eligibility is worded as the escalation's rule, not a promise of delivery").toContainText(/eligible under the escalation/i);
      const row = card.getByTestId(`preview-lead-${leadId}`);
      await expect(row).toContainText(/would be escalated now/i);
      await expect(row.locator("td").last(), "one eligible recipient: the admin, who is not its assignee").toHaveText("1");
      await expect(page.getByTestId("lead-escalation-preview-stale")).toHaveCount(0);
      await assertNoHorizontalOverflow(page, "settings/lead-escalation (preview)");

      // any change after the preview marks it stale
      await page.getByLabel(/minutes without a first response/i).fill("30");
      await expect(page.getByTestId("lead-escalation-preview-stale")).toBeVisible();

      // nothing was written: the policy row is what it was, the enquiry has no escalation job, no escalation event
      const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
      expect(data!.value, "the policy row").toEqual(before);
      const { data: jobs } = await svc.from("notification_jobs").select("id").eq("lead_id", leadId).eq("kind", "lead_escalation");
      expect(jobs, "no escalation job").toHaveLength(0);
      const { data: events } = await svc.from("events").select("id").eq("entity_type", "lead").eq("entity_id", leadId).eq("event_type", "lead_escalation");
      expect(events, "no escalation event").toHaveLength(0);
      assertNoProblems(problems, "settings/lead-escalation (preview)");
    } finally {
      await svc.from("tasks").delete().eq("lead_id", leadId);
      await svc.from("leads").delete().eq("id", leadId); // the desk-alert job cascades; events stay
    }
  });

  /**
   * Audit 2026-09-22 (late): an answer that arrives after the form changed
   * must not be presented as current. Before the fix, a change made while
   * the FIRST preview was in flight was never recorded (the form only
   * tracked changes once a preview already existed), and the answer to ANY
   * request cleared the warning unconditionally — so the card showed the
   * 15-minute result under a 30-minute form with no warning.
   *
   * The delay is controlled, not slept: the preview's server-action POST is
   * held at the network layer until the test has edited the form, then
   * released. The request already carries the values from the click, so the
   * server answers for them.
   */
  test("a preview answered after the form changed is stale — first request, later request, and a fresh one clears it", async ({ page }) => {
    const svc = serviceClient();
    const { id: adminId } = await fixtureProfile(svc);
    const writesBefore = await previewWriteCounts(svc);

    const problems = watchForProblems(page);
    await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
    const hoursOn = page.getByRole("checkbox", { name: /count the wait in working time only/i });
    if (await hoursOn.isChecked()) await hoursOn.uncheck();
    const wait = page.getByLabel(/minutes without a first response/i);
    await wait.fill("15");
    await page.getByLabel(/ignore enquiries overdue for more than/i).fill("1");
    await page.locator(`input[name="recipients"][value="${adminId}"]`).check();
    const previewButton = page.getByRole("button", { name: /preview activation|previewing/i });
    const card = page.getByTestId("lead-escalation-preview");
    const staleNote = page.getByTestId("lead-escalation-preview-stale");

    // 1. The FIRST request: edited while in flight.
    let held = await holdNextPreview(page);
    await previewButton.click();
    await held.arrived;
    await expect(previewButton, "the request is in flight").toHaveText(/previewing/i);
    await wait.fill("30");
    held.release();
    await expect(card).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(card, "the answer is about the values sent").toContainText(/15 min of clock time/i);
    await expect(staleNote, "…and the form now says 30, so it is not current").toBeVisible();
    await expect(wait, "the unsaved edit survives the answer").toHaveValue("30");

    // 2. A LATER request: edited while in flight, over a previous preview.
    held = await holdNextPreview(page);
    await previewButton.click();
    await held.arrived;
    await wait.fill("45");
    held.release();
    await expect(card).toContainText(/30 min of clock time/i, { timeout: opTimeout(15_000) });
    await expect(staleNote, "the answer for 30 does not describe a 45-minute form").toBeVisible();

    // 3. A fresh preview of the current values clears it.
    await previewButton.click();
    await expect(card).toContainText(/45 min of clock time/i, { timeout: opTimeout(15_000) });
    await expect(staleNote).toHaveCount(0);

    // 4. After a completed preview: a change marks it stale, putting the value back makes it current again.
    await wait.fill("50");
    await expect(staleNote).toBeVisible();
    await wait.fill("45");
    await expect(staleNote).toHaveCount(0);

    // Previewing wrote nothing: the policy row, no escalation job, no config event.
    const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    expect(data!.value, "the policy row").toEqual(before);
    expect(await previewWriteCounts(svc), "no escalation job, no config event").toEqual(writesBefore);
    assertNoProblems(problems, "settings/lead-escalation (preview in flight)");
  });

  /**
   * React resets a form after its action settles — a REFUSED save included —
   * and a reset fires no change event. The preview was about the values
   * sent; once the form is back to the stored row it no longer holds them,
   * so the card must say stale rather than stay "current".
   */
  test("a refused save that resets the form leaves the preview stale, not current", async ({ page }) => {
    const svc = serviceClient();
    await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
    const escalate = page.getByRole("checkbox", { name: /escalate unanswered website enquiries/i });
    await escalate.check();
    for (const box of await page.locator('input[name="recipients"]:not([disabled])').all()) await box.uncheck();

    await page.getByRole("button", { name: /preview activation/i }).click();
    const card = page.getByTestId("lead-escalation-preview");
    await expect(card).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(card, "the preview allows nobody ticked").toContainText(/nobody is ticked/i);
    const staleNote = page.getByTestId("lead-escalation-preview-stale");
    await expect(staleNote).toHaveCount(0);

    // the save refuses "on with nobody to tell" — and React resets the fields to the stored row
    await page.getByRole("button", { name: /save escalation/i }).click();
    await expect(page.getByText(/at least one/i)).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(escalate, "the premise: the refused save reset the form to the stored row").toBeChecked({
      checked: (before as { enabled: boolean }).enabled,
    });
    await expect(staleNote, "the card was about values the form no longer holds").toBeVisible();

    const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    expect(data!.value, "nothing was written").toEqual(before);
  });

  /**
   * After that silent reset, React's own record of each field's last value
   * still holds the value from BEFORE the reset, so repeating an edit fires
   * no React change event at all — and the working-hours box shows ticked
   * while the page still believes it is off (its day and time fields stay
   * disabled, and the next preview or save is refused for "no working day").
   * The preview must follow the form through both.
   */
  test("after a refused save's reset, the preview still follows the form — repeated edits included", async ({ page }) => {
    const svc = serviceClient();
    const { id: adminId } = await fixtureProfile(svc);
    const stored = {
      ...(before as Record<string, unknown>),
      enabled: false,
      recipients: [adminId],
      working_hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
    };
    const { error: seedErr } = await svc.from("cyprus_config").update({ value: stored as never }).eq("key", "lead_escalation");
    expect(seedErr).toBeNull();

    await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
    const escalate = page.getByRole("checkbox", { name: /escalate unanswered website enquiries/i });
    const hoursBox = page.getByRole("checkbox", { name: /count the wait in working time only/i });
    const admin = page.locator(`input[name="recipients"][value="${adminId}"]`);
    const monday = page.locator('input[name="days"][value="1"]');
    const card = page.getByTestId("lead-escalation-preview");
    const staleNote = page.getByTestId("lead-escalation-preview-stale");
    const edit = async () => {
      await escalate.check();
      await hoursBox.uncheck();
      await admin.uncheck();
    };

    // a preview of the stored values, untouched
    await page.getByRole("button", { name: /preview activation/i }).click();
    await expect(card).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(staleNote).toHaveCount(0);

    // on, hours off, nobody ticked: stale — and the save refuses it, resetting the form to the stored row
    await edit();
    await expect(staleNote).toBeVisible();
    await page.getByRole("button", { name: /save escalation/i }).click();
    await expect(page.getByText(/at least one/i)).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(escalate, "the premise: reset to the stored row").not.toBeChecked();
    await expect(hoursBox).toBeChecked();
    await expect(admin).toBeChecked();
    await expect(monday, "a ticked hours box has live day fields").toBeEnabled();
    await expect(staleNote, "the form holds the previewed values again").toHaveCount(0);

    // the SAME edits again: React sees no change on any of them; the preview must still go stale
    await edit();
    await expect(staleNote, "the form no longer holds the previewed values").toBeVisible();
    await expect(monday, "an unticked hours box greys its days out again").toBeDisabled();

    // and back once more: current again
    await escalate.uncheck();
    await hoursBox.check();
    await admin.check();
    await expect(staleNote).toHaveCount(0);

    const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    expect(data!.value, "nothing was written by the preview or the refused save").toEqual(stored);
  });

  test("after a refused save from a row with hours OFF, ticking the hours box again brings its days back", async ({ page }) => {
    const svc = serviceClient();
    const { id: adminId } = await fixtureProfile(svc);
    const stored = { ...(before as Record<string, unknown>), enabled: false, recipients: [adminId], working_hours: null };
    expect((await svc.from("cyprus_config").update({ value: stored as never }).eq("key", "lead_escalation")).error).toBeNull();

    await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
    const hoursBox = page.getByRole("checkbox", { name: /count the wait in working time only/i });
    const monday = page.locator('input[name="days"][value="1"]');
    await expect(hoursBox).not.toBeChecked();
    await expect(monday).toBeDisabled();

    await page.getByRole("checkbox", { name: /escalate unanswered website enquiries/i }).check();
    await hoursBox.check();
    await expect(monday).toBeEnabled();
    await page.locator(`input[name="recipients"][value="${adminId}"]`).uncheck();
    await page.getByRole("button", { name: /save escalation/i }).click();
    await expect(page.getByText(/at least one/i)).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(hoursBox, "the premise: reset to the stored row, hours off").not.toBeChecked();
    await expect(monday).toBeDisabled();

    // the tick the admin already made once — React's record still says "ticked", the box does not
    await hoursBox.check();
    await expect(monday, "the days come back with the box").toBeEnabled();
  });

  test("a preview request that never reaches the server says so and keeps the unsaved values", async ({ page }) => {
    await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
    const wait = page.getByLabel(/minutes without a first response/i);
    await wait.fill("37");
    await page.route(
      (url) => url.pathname === "/settings/lead-escalation",
      (route) => (route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort("connectionfailed") : route.fallback()),
    );
    await page.getByRole("button", { name: /preview activation/i }).click();
    await expect(page.getByTestId("lead-escalation-preview-error")).toContainText(/could not reach the server/i, { timeout: opTimeout(15_000) });
    await expect(page.getByTestId("lead-escalation-form"), "the page is still the form, not the error screen").toBeVisible();
    await expect(wait, "the unsaved value survives").toHaveValue("37");
    const { data } = await serviceClient().from("cyprus_config").select("value").eq("key", "lead_escalation").single();
    expect(data!.value, "nothing was written").toEqual(before);
  });

  test("a same-page refresh that changes the stored values under an untouched form marks the preview stale", async ({ page }) => {
    const svc = serviceClient();
    const stored = { ...(before as Record<string, unknown>), after_minutes: 21 };
    expect((await svc.from("cyprus_config").update({ value: stored as never }).eq("key", "lead_escalation")).error).toBeNull();
    await page.goto("/settings/lead-escalation", { waitUntil: "networkidle" });
    const wait = page.getByLabel(/minutes without a first response/i);
    await expect(wait).toHaveValue("21");
    await page.getByRole("button", { name: /preview activation/i }).click();
    await expect(page.getByTestId("lead-escalation-preview")).toContainText(/21 min/i, { timeout: opTimeout(15_000) });
    const staleNote = page.getByTestId("lead-escalation-preview-stale");
    await expect(staleNote).toHaveCount(0);

    // another admin (or another tab) changes the row; this tab follows its own nav link to the same page
    expect((await svc.from("cyprus_config").update({ value: { ...stored, after_minutes: 26 } as never }).eq("key", "lead_escalation")).error).toBeNull();
    await page.getByRole("link", { name: "Lead escalation", exact: true }).click();
    await expect(wait, "the premise: the untouched field took the new stored value").toHaveValue("26", { timeout: opTimeout(15_000) });
    await expect(staleNote, "the preview was for 21").toBeVisible();
  });
});

/** Rows a preview must never create, counted on the server (a row read is capped at 1000). */
async function previewWriteCounts(svc: ReturnType<typeof serviceClient>): Promise<{ jobs: number; configEvents: number }> {
  const jobs = await svc.from("notification_jobs").select("id", { count: "exact", head: true }).eq("kind", "lead_escalation");
  const events = await svc.from("events").select("id", { count: "exact", head: true }).eq("entity_type", "config");
  expect(jobs.error, "count escalation jobs").toBeNull();
  expect(events.error, "count config events").toBeNull();
  return { jobs: jobs.count ?? -1, configEvents: events.count ?? -1 };
}

/**
 * Hold the page's next server-action POST to /settings/lead-escalation until
 * `release()` — the preview's request, since the test clicks nothing else.
 * `arrived` resolves once the browser has sent it (the values are already in
 * its body). One request only: after it, the handler falls through (it does
 * not unroute itself — unrouting mid-request hands the route on).
 */
async function holdNextPreview(page: Page): Promise<{ arrived: Promise<void>; release: () => void }> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let markArrived!: () => void;
  const arrived = new Promise<void>((r) => (markArrived = r));
  let used = false;
  await page.route(
    (url) => url.pathname === "/settings/lead-escalation",
    async (route: Route) => {
      const req = route.request();
      if (used || req.method() !== "POST" || !req.headers()["next-action"]) return route.fallback();
      used = true;
      markArrived();
      await released;
      await route.continue();
    },
  );
  return { arrived, release };
}
