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
 * Settings → Lead routing (0098, audit LR-05).
 *
 * The rule itself is proven against the database by
 * supabase/tests/enquiry-meta.test.ts (round-robin picks the member with the
 * fewest open leads; an inactive member is skipped). This spec covers what
 * only the running app can prove: the page renders at both widths (the
 * portals spec's lesson — a settings sub-page no suite visits ships
 * unrendered), a save lands in `cyprus_config.lead_routing` and reads back,
 * and round-robin over nobody is refused with a sentence.
 *
 * Runs in the desktop AND mobile projects. Local only: it writes the row.
 */
const OFF = { mode: "off", agents: [] as string[] };

test.describe("Settings → Lead routing", () => {
  test.beforeEach(() => {
    test.skip(!isLocal(), "writes cyprus_config — local only, never production");
  });

  test.afterEach(async () => {
    if (!isLocal()) return;
    await serviceClient().from("cyprus_config").update({ value: OFF }).eq("key", "lead_routing");
  });

  test("renders, saves round-robin over the admin, and reads it back", async ({ page }) => {
    const svc = serviceClient();
    await svc.from("cyprus_config").update({ value: OFF }).eq("key", "lead_routing");
    const { id: adminId } = await fixtureProfile(svc);

    const problems = watchForProblems(page);
    await page.goto("/settings/lead-routing", { waitUntil: "networkidle" });
    await assertShellRendered(page);
    await assertNoHorizontalOverflow(page, "settings/lead-routing");

    await expect(page.getByRole("radio", { name: /^Off/ })).toBeChecked();
    await page.getByRole("radio", { name: /^Round-robin/ }).check();
    const member = page.locator(`input[name="agents"][value="${adminId}"]`);
    await member.check();
    await page.getByRole("button", { name: /save routing/i }).click();
    await expect(page.getByText(/lead routing saved/i)).toBeVisible({ timeout: opTimeout(15_000) });

    const { data } = await svc.from("cyprus_config").select("value").eq("key", "lead_routing").single();
    expect(data!.value).toEqual({ mode: "round_robin", agents: [adminId] });

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("radio", { name: /^Round-robin/ })).toBeChecked();
    await expect(page.locator(`input[name="agents"][value="${adminId}"]`)).toBeChecked();
    assertNoProblems(problems, "settings/lead-routing");
  });

  test("refuses round-robin over nobody, with a sentence", async ({ page }) => {
    await page.goto("/settings/lead-routing", { waitUntil: "networkidle" });
    await page.getByRole("radio", { name: /^Round-robin/ }).check();
    for (const box of await page.locator('input[name="agents"]:not([disabled])').all()) {
      await box.uncheck();
    }
    await page.getByRole("button", { name: /save routing/i }).click();
    await expect(page.getByText(/at least one member/i)).toBeVisible({ timeout: opTimeout(15_000) });
    const { data } = await serviceClient().from("cyprus_config").select("value").eq("key", "lead_routing").single();
    expect(data!.value, "nothing was written").toEqual(OFF);
  });
});
