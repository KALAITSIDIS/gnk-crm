import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The deal page header's figure and its Costs link, for the states the
 * deal-close spec does not reach (T-won-value-surfaces). The header shows
 * dealValue() labelled by dealValueIsFinal(): a won deal with a confirmed
 * price leads with "Final value", anything else — including a win closed
 * WITHOUT a figure (an admin override, or a legacy win) — with "Expected
 * value", so an estimate is never passed off as the price. Costs opens the
 * calculators at the shown figure, and is absent when there is none.
 *
 * The won deals are planted with the service role (the maintenance path the
 * close guard deliberately does not bind; deal-close-outcomes.spec does the
 * same) and removed in `finally`.
 */

const TITLE = "E2E header-value fixture deal";

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

test("the header labels its figure by its basis, and Costs opens at that figure", async ({ page }) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { id: adminId, orgId } = await fixtureProfile(svc);
  const stageOf = async (won: boolean) => {
    const { data } = await svc
      .from("deal_stages")
      .select("id")
      .eq("org_id", orgId)
      .eq("deal_type", "sale")
      .eq("is_won", won)
      .eq("is_lost", false)
      .order("sort_order")
      .limit(1)
      .single();
    return data!.id as string;
  };
  const wonStage = await stageOf(true);
  const openStage = await stageOf(false);
  const plant = async (suffix: string, row: Record<string, unknown>) => {
    const { data, error } = await svc
      .from("deals")
      .insert({ org_id: orgId, deal_type: "sale", title: `${TITLE} ${suffix}`, agent_id: adminId, created_by: adminId, ...row })
      .select("id")
      .single();
    expect(error, `planting ${suffix}`).toBeNull();
    return data!.id as string;
  };

  try {
    const now = new Date().toISOString();
    // won WITHOUT a recorded figure: the estimate, labelled as the estimate
    const noFinal = await plant("no final", {
      stage_id: wonStage,
      status: "won",
      won_at: now,
      expected_value: 80000,
      final_value: null,
    });
    // won with a confirmed price and NO estimate: still the final value, and Costs still shows
    const noEstimate = await plant("no estimate", {
      stage_id: wonStage,
      status: "won",
      won_at: now,
      expected_value: null,
      final_value: 120000,
    });
    // open with no figure at all: no number, no Costs
    const noFigure = await plant("no figure", { stage_id: openStage, expected_value: null });

    const header = page.getByTestId("deal-header-value");
    const costs = page.getByRole("link", { name: "Costs", exact: true });

    await page.goto(`/deals/${noFinal}`, { waitUntil: "networkidle" });
    await expect(header).toHaveText(/^Expected value\s+€80\.000$/);
    await expect(costs).toHaveAttribute("href", "/calculators?price=80000");

    await page.goto(`/deals/${noEstimate}`, { waitUntil: "networkidle" });
    await expect(header).toHaveText(/^Final value\s+€120\.000$/);
    await expect(costs).toHaveAttribute("href", "/calculators?price=120000");

    await page.goto(`/deals/${noFigure}`, { waitUntil: "networkidle" });
    await expect(header).toHaveText(/^Expected value\s+—$/);
    await expect(costs).toHaveCount(0);
  } finally {
    await removeFixture(svc);
  }
});
