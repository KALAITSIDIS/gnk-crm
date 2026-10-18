import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * A deal idle for 20 days shows it, in a real browser (A09).
 *
 * Its stored health is 100 with "Recent activity 30/30 · 0d since last
 * activity" — what the last recompute, run right after its last activity,
 * left behind. Before A09 the deal page and the board showed exactly that,
 * for as long as nobody touched the deal. Now both re-score the activity
 * factor at the request: 70, "0/30 · 20d since last activity", and a line
 * saying when the rest of the checklist was assessed. The page writes
 * nothing: the row's health, score and updated_at are the same afterwards.
 *
 * The page-level rules (the board, a won deal frozen, no snapshot, no write,
 * the agent's view) are proven against a real PostgREST in
 * supabase/tests/pipeline-live-health.test.ts; this pins the render.
 *
 * Planted with the service role, removed in `finally`.
 */

const TITLE = "E2E live health fixture deal";
const DAY = 86_400_000;

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: deals } = await svc.from("deals").select("id").like("title", `${TITLE}%`);
  for (const d of deals ?? []) {
    await svc.from("tasks").delete().eq("deal_id", d.id);
    await svc.from("deals").delete().eq("id", d.id);
  }
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("a deal idle 20 days shows 70 and '20d since last activity', and the page writes nothing", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the board's hover breakdown is the desktop subject");
  const svc = serviceClient();
  await removeFixture(svc);
  const { id: adminId, orgId } = await fixtureProfile(svc);
  const { data: stage } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", orgId)
    .eq("deal_type", "sale")
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("sort_order")
    .limit(1)
    .single();

  const lastActivity = new Date(Date.now() - 20 * DAY).toISOString();
  // the snapshot a recompute stores right after the last activity: all met, 100
  const health = {
    budget_confirmed: true,
    computed_at: lastActivity,
    factors: [
      { key: "budget", label: "Budget confirmed", points: 25, max: 25, detail: "confirmed" },
      { key: "kyc", label: "Buyer KYC ≥ 50%", points: 15, max: 15, detail: "100% complete" },
      { key: "title_deed", label: "Title deed status known", points: 15, max: 15, detail: "known" },
      { key: "mandate", label: "Mandate active", points: 15, max: 15, detail: "active" },
      { key: "activity", label: "Recent activity", points: 30, max: 30, detail: "0d since last activity" },
    ],
  };
  const { data: planted, error } = await svc
    .from("deals")
    .insert({
      org_id: orgId,
      deal_type: "sale",
      stage_id: stage!.id,
      title: `${TITLE} idle`,
      agent_id: adminId,
      created_by: adminId,
      last_activity_at: lastActivity,
      health,
      health_score: 100,
    })
    .select("id")
    .single();
  expect(error, "planting the idle deal").toBeNull();
  const id = planted!.id as string;
  const row = async () =>
    (await svc.from("deals").select("health, health_score, updated_at").eq("id", id).single()).data;

  try {
    const before = await row();

    await page.goto(`/deals/${id}`, { waitUntil: "networkidle" });
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Health", exact: true }) });
    await expect(panel).toContainText("70", { timeout: opTimeout(15_000) });
    await expect(panel.getByText("20d since last activity")).toBeVisible();
    await expect(panel.locator("li").filter({ hasText: "Recent activity" })).toContainText("0/30");
    const assessed = page.getByTestId("health-assessed");
    await expect(assessed).toContainText(/^Checklist assessed .+ · activity as of now$/);

    // the board: the card's dot names the live score, and its breakdown says why
    await page.goto("/pipeline?type=sale", { waitUntil: "networkidle" });
    const card = page.locator("li").filter({ has: page.getByRole("link", { name: `${TITLE} idle` }) });
    const dot = card.getByLabel("Health 70/100");
    await expect(dot).toHaveCount(1);
    await dot.focus();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("20d since last activity", { timeout: opTimeout(10_000) });
    await expect(tip).toContainText("activity as of now");

    // nothing written on the way
    expect(await row()).toEqual(before);
  } finally {
    await removeFixture(svc);
  }
});
