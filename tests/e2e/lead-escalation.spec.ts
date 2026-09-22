import { test, expect } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  assertNoProblems,
  assertShellRendered,
  fixtureProfile,
  isLocal,
  opTimeout,
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
});
