import { test, expect } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * The 0079 transitional condition REACHES THE SCREEN (2026-09-01 review).
 *
 * deriveVat's passthrough is unit-tested, and 0079's DO-block proved the
 * config — but nothing anywhere asserted the render, and the render is the
 * point: the exact defect 0079 fixed was "data present, screen silent",
 * quoting an unconditional 2026-12-31 deadline to buyers whose relief
 * lapsed 2026-06-15. This spec seeds an over-area new-build (the cliff
 * outcome that surfaces the transitional block) and pins the warning line.
 */

const REF = "E2EVATCOND1";

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: props } = await svc.from("properties").select("id").eq("reference", REF);
  for (const p of props ?? []) {
    await svc.from("tasks").delete().eq("property_id", p.id);
    await svc.from("properties").delete().eq("id", p.id);
  }
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("the transitional block renders the permit-date condition as a warning", async ({
  page,
}) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);

  // the config is the LIVE local row — this spec must fail if 0079's
  // condition is ever dropped from it, so read what we expect to see
  const { data: cfg } = await svc
    .from("cyprus_config")
    .select("value")
    .eq("key", "vat_property")
    .single();
  const condition = (
    cfg!.value as { transitional?: { condition?: string } }
  ).transitional?.condition;
  expect(condition, "0079's condition must be in the config").toBeTruthy();

  // 191 m² new-build: over the 190 m² cap → standard_only with the area
  // cliff, which is the outcome that renders the transitional block
  const { data: prop } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference: REF,
      property_type: "apartment",
      status: "available",
      vat_status: "reduced_rate_eligible",
      asking_price: 300000,
      covered_area_sqm: 191,
    })
    .select("id")
    .single();

  try {
    await page.goto(`/properties/${prop!.id}`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^details$/i }).click();

    await expect(
      page.getByText(/transitional rules may still apply until 2026-12-31/i),
    ).toBeVisible({ timeout: opTimeout(15_000) });

    // the warning line, verbatim from the config — not a paraphrase the
    // panel could silently drop
    const line = page.getByText(/^Condition: /);
    await expect(line).toBeVisible();
    await expect(line).toContainText("2026-06-15");
    await expect(line).toContainText("2024-12-31");
  } finally {
    await removeFixture(svc);
  }
});
