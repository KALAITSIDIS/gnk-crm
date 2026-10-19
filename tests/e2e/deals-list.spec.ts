import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { zonedParts } from "@/lib/utils/tz";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * The deals register (F05) as the desk meets it. The pipeline board keeps a
 * closed deal for 30 days (DECISIONS T-audit-pipeline item 4); before /deals,
 * one lost 60 days ago was reachable only through a contact, a lead or a task
 * that happened to link it.
 *
 * This proves, in a real browser: such a deal is NOT on the board's Lost
 * column; that column's footer lands on the register pre-filtered to the
 * board's type and the column's outcome, where it IS; the sidebar's Deals
 * item, Status "Lost" and a Cyprus-day closed range find it without a contact
 * or a URL, and it opens at /deals/<id>; Export CSV saves a file holding it.
 *
 * Who sees what (an agent only the deals they own or created; a second agent
 * none of a colleague's; another organisation nothing), every filter past
 * page one, the Cyprus-day edges and the CSV's order are proven against a
 * real PostgREST in supabase/tests/deals-list.test.ts.
 *
 * The lost deal is planted with the service role — the maintenance path the
 * close guard (0118) deliberately does not bind; deal-close-outcomes.spec does
 * the same — and removed in `finally`.
 */

const TITLE = "E2E register fixture deal";
const DAY = 86_400_000;

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: deals } = await svc.from("deals").select("id").like("title", `${TITLE}%`);
  for (const d of deals ?? []) {
    await svc.from("tasks").delete().eq("deal_id", d.id);
    await svc.from("deals").delete().eq("id", d.id);
  }
}

/** After hydration: the filter bar and the export button are client components. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("a deal lost 60 days ago: off the board, found in the register, opened, exported", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the desktop sidebar and board are the subject; modules.spec covers the phone");
  const svc = serviceClient();
  await removeFixture(svc);
  const { id: adminId, orgId } = await fixtureProfile(svc);
  const { data: lostStage } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", orgId)
    .eq("deal_type", "sale")
    .eq("is_lost", true)
    .order("sort_order")
    .limit(1)
    .single();
  const title = `${TITLE} ${Date.now().toString(36)}`;
  const lostAt = new Date(Date.now() - 60 * DAY);
  const { data: planted, error } = await svc
    .from("deals")
    .insert({
      org_id: orgId,
      deal_type: "sale",
      stage_id: lostStage!.id,
      title,
      status: "lost",
      lost_at: lostAt.toISOString(),
      lost_reason: "E2E fixture",
      agent_id: adminId,
      created_by: adminId,
      expected_value: 210000,
    })
    .select("id")
    .single();
  expect(error, "planting the lost deal").toBeNull();
  const dealId = planted!.id as string;

  try {
    // 1. the board's Lost column holds 30 days: the deal is not there
    await open(page, "/pipeline?type=sale");
    const lostColumn = page.locator('section[data-stage-closed="true"]').filter({ has: page.locator("h3", { hasText: "✕" }) });
    await expect(lostColumn).toHaveCount(1);
    await expect(lostColumn.getByText(title)).toHaveCount(0);

    // 2. …and its footer lands on the register, pre-filtered, where it is
    const older = lostColumn.getByRole("link", { name: "Older closed deals →" });
    await expect(older).toHaveAttribute("href", "/deals?type=sale&status=lost");
    await older.click();
    await page.waitForURL(/\/deals\?type=sale&status=lost$/, { timeout: opTimeout(15_000) });
    await expect(page.getByRole("heading", { name: "Deals", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: title })).toBeVisible();

    // 3. from the sidebar, with no contact and no URL: Status Lost + a closed range in Cyprus days
    await open(page, "/dashboard");
    await page.locator("aside").getByRole("link", { name: "Deals", exact: true }).click();
    await page.waitForURL(/\/deals$/, { timeout: opTimeout(15_000) });
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Filter deals by status").click();
    await page.getByRole("option", { name: "Lost", exact: true }).click();
    await expect(page).toHaveURL(/status=lost/, { timeout: opTimeout(15_000) });
    const from = zonedParts(new Date(Date.now() - 90 * DAY)).dayKey;
    const to = zonedParts(new Date(Date.now() - 31 * DAY)).dayKey;
    await page.getByLabel("Closed from").fill(from);
    await page.getByLabel("Closed to").fill(to);
    await expect(page).toHaveURL(new RegExp(`closed_from=${from}.*closed_to=${to}|closed_to=${to}.*closed_from=${from}`), {
      timeout: opTimeout(15_000),
    });
    const row = page.getByRole("link", { name: title });
    await expect(row).toBeVisible({ timeout: opTimeout(15_000) });
    const filteredUrl = page.url();

    // 4. Export CSV: the file is the filtered list, and holds the deal
    const pending = page.waitForEvent("download", { timeout: opTimeout(30_000) });
    await page.getByRole("link", { name: "Export CSV" }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/^deals-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = readFileSync((await download.path())!, "utf8");
    expect(csv.slice(1)).toMatch(/^Title,Type,Stage,Status,Expected value,Final value,/);
    expect(csv).toContain(title);

    // 5. it opens at its own page
    await open(page, filteredUrl);
    await page.getByRole("link", { name: title }).click();
    await page.waitForURL(new RegExp(`/deals/${dealId}$`), { timeout: opTimeout(15_000) });
    // the sidebar marks Deals as where the user is (the bare class, not its hover: variant)
    await expect(page.locator("aside").getByRole("link", { name: "Deals", exact: true })).toHaveClass(
      /(^|\s)bg-brand-900(\s|$)/,
    );
  } finally {
    await removeFixture(svc);
  }
});

test("the board links to the register for its deal type", async ({ page }) => {
  await open(page, "/pipeline?type=rental");
  await expect(page.getByRole("link", { name: "All deals" })).toHaveAttribute("href", "/deals?type=rental");
  const won = page.locator('section[data-stage-closed="true"]').filter({ has: page.locator("h3", { hasText: "✓" }) });
  await expect(won.getByRole("link", { name: "Older closed deals →" })).toHaveAttribute(
    "href",
    "/deals?type=rental&status=won",
  );
});

test("junk in the URL is no filter, never an error page", async ({ page }) => {
  const res = await page.goto("/deals?status=deleted&contact=not-a-uuid&closed_from=2026-02-30&page=-4");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Deals", level: 1 })).toBeVisible();
  await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
});
