import { test, expect, type Page } from "@playwright/test";
import { type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  assertNoProblems,
  fixtureProfile,
  isLocal,
  opTimeout,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * F01 — Unknown is a scenario, never a conclusion.
 *
 * Before: for a listing whose VAT status was "unknown", the Details tab's VAT
 * panel quoted VAT-inclusive figures as if VAT applied, while its Costs link
 * sent only the price, so the calculator opened silently on "not subject to
 * VAT" with relief — two screens, opposite answers, and a copied quote that
 * named neither the listing nor the assumption.
 *
 * Now `vatApplicability` (lib/services/vat.ts) is the one reading of the
 * stored status; the panel frames unknown figures as "if it applies", the
 * Costs link carries the property, and the calculator opens on the scenario
 * the status implies and puts the reference and a "Scenario:" line on the
 * summary. The listings are planted with the service role and removed in
 * `finally`.
 */

const PREFIX = "E2EF01";
const REF = { land: `${PREFIX}LAND`, newBuild: `${PREFIX}NEW`, resale: `${PREFIX}RESALE` };

async function removeFixture(svc: SupabaseClient): Promise<void> {
  const { data: props } = await svc.from("properties").select("id").like("reference", `${PREFIX}%`);
  for (const p of props ?? []) {
    await svc.from("tasks").delete().eq("property_id", p.id);
    await svc.from("properties").delete().eq("id", p.id);
  }
}

async function plant(
  svc: SupabaseClient,
  orgId: string,
  row: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await svc
    .from("properties")
    .insert({ org_id: orgId, status: "available", ...row })
    .select("id")
    .single();
  expect(error, `planting ${String(row.reference)}`).toBeNull();
  return data!.id as string;
}

/** "€8.600" / "€8.600,00" -> 8600 (the app formats money de-DE style). */
function parseEuro(text: string): number {
  const m = text.match(/€\s*([\d.,]+)/);
  if (!m) throw new Error(`no euro amount in: ${text}`);
  return Number(m[1].replace(/\./g, "").replace(",", "."));
}

const transferCard = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: /transfer fees/i }) });

async function transferTotal(page: Page): Promise<string> {
  const row = transferCard(page).locator("div").filter({ hasText: /^Total/ }).last();
  return (await row.innerText()).replace(/\s+/g, " ").trim();
}

test.beforeEach(() => {
  test.skip(!isLocal(), "seeds and deletes rows through the service client — local only");
});

test("unknown land: the panel frames a scenario, and the calculator opens on it", async ({
  page,
}) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);
  const id = await plant(svc, orgId, {
    reference: REF.land,
    property_type: "land",
    vat_status: "unknown",
    asking_price: 200000,
    covered_area_sqm: null,
    plot_area_sqm: 1200,
  });

  try {
    const problems = watchForProblems(page);
    await page.goto(`/properties/${id}?tab=details`, { waitUntil: "networkidle" });

    // (1) the panel: an amber note, labelled figures, and no 5% band for land
    const note = page.getByRole("note").filter({ hasText: /VAT status: Unknown — not confirmed/ });
    await expect(note).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(note).toContainText(/nothing here confirms that it does, or that it has been paid/);
    await expect(page.getByText("VAT (if it applies)", { exact: true })).toBeVisible();
    await expect(page.getByText("Price including VAT (if it applies)", { exact: true })).toBeVisible();
    await expect(page.getByText(/€200\.000 at 19%/)).toBeVisible();
    await expect(page.getByText(/ at 5%/)).toHaveCount(0);
    await expect(page.getByText(/not available for land/)).toBeVisible();
    // the select says what the status means
    await expect(page.getByLabel("VAT status", { exact: true })).toContainText(
      "Unknown (not confirmed)",
    );

    // the other tax, one click away, on this property
    const expected = `/calculators?price=200000&property=${id}`;
    await expect(page.getByRole("link", { name: /Transfer fees for this price/ })).toHaveAttribute(
      "href",
      expected,
    );

    // (2) the header Costs link carries the property
    const costs = page.getByRole("link", { name: "Costs", exact: true });
    await expect(costs).toHaveAttribute("href", expected);

    // (3) the calculator names the listing and opens on "Not confirmed"
    await costs.click();
    await page.waitForURL(/\/calculators\?/);
    await expect(page.getByText(`· land · VAT status: Unknown (not confirmed)`)).toBeVisible();
    await expect(page.getByRole("link", { name: REF.land, exact: true })).toHaveAttribute(
      "href",
      `/properties/${id}?tab=details`,
    );
    await expect(page.getByRole("radio", { name: /^Not confirmed/i })).toBeChecked();
    await expect(page.getByRole("status").filter({ hasText: /confirm before quoting/ })).toBeVisible();
    // both branches: the nil one and the not-subject breakdown
    await expect(page.getByText(/subject to VAT, no transfer fees are payable/)).toBeVisible();
    await expect(page.getByRole("heading", { name: /^If not subject to VAT$/ })).toBeVisible();
    const total = await transferTotal(page);
    expect(total).toMatch(/^Total \(if not subject to VAT\)/);
    // 2,550 + 4,250 + 30,000 × 8% = 9,200 gross; 4,600 after the 50% relief
    expect(parseEuro(total)).toBe(4600);

    // (4) the copied summary names the listing and the scenario
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await transferCard(page).getByRole("button", { name: /copy summary/i }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    // The summary joins its lines with "\n" (buildTransferSummary); the Windows
    // clipboard stores text with CRLF and reads it back that way, so a line
    // ends at \r?\n here
    expect(clip.split(/\r?\n/)[0]).toBe(`Transfer fees for €200.000 — ${REF.land}:`);
    expect(clip).toContain("Scenario: VAT status not confirmed — confirm before quoting");
    expect(clip).toContain("If subject to VAT: no transfer fees.");
    expect(clip).toContain("Total (if not subject to VAT): €4.600");
    expect(clip, "never an unqualified total for an unconfirmed sale").not.toMatch(/^Total:/m);

    assertNoProblems(problems, "purchase-cost scenario");
  } finally {
    await removeFixture(svc);
  }
});

test("a new build opens on 'Subject to VAT'; a resale on 'Not subject', at the bare figure", async ({
  page,
}) => {
  const svc = serviceClient();
  await removeFixture(svc);
  const { orgId } = await fixtureProfile(svc);
  const newBuild = await plant(svc, orgId, {
    reference: REF.newBuild,
    property_type: "apartment",
    vat_status: "new_vat",
    asking_price: 300000,
    covered_area_sqm: 100,
  });
  const resale = await plant(svc, orgId, {
    reference: REF.resale,
    property_type: "villa",
    vat_status: "resale_no_vat",
    asking_price: 300000,
    covered_area_sqm: 150,
  });

  try {
    // (5) new_vat: the nil assessment, and a way back to the VAT treatment
    await page.goto(`/calculators?price=300000&property=${newBuild}`, { waitUntil: "networkidle" });
    await expect(page.getByText(/VAT status: New \(VAT applies\)/)).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Subject to VAT/i })).toBeChecked();
    await expect(page.getByText(/no transfer fees — the transaction is subject to VAT/i)).toBeVisible();
    await expect(
      page.getByRole("link", { name: /VAT applies instead — see the property/ }),
    ).toHaveAttribute("href", `/properties/${newBuild}?tab=details`);

    // the panel for a confirmed status carries no scenario note and no
    // transfer-fee link — VAT applies, so that is the figure
    await page.goto(`/properties/${newBuild}?tab=details`, { waitUntil: "networkidle" });
    await expect(page.getByText(/VAT treatment/).first()).toBeVisible({ timeout: opTimeout(15_000) });
    await expect(page.getByText(/VAT status: Unknown — not confirmed/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Transfer fees for this price/ })).toHaveCount(0);

    // resale: not subject, and the same total as the bare page
    await page.goto(`/calculators?price=300000&property=${resale}`, { waitUntil: "networkidle" });
    await expect(page.getByText(/VAT status: Resale \(no VAT\)/)).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Not subject to VAT/i })).toBeChecked();
    const withContext = parseEuro(await transferTotal(page));

    await page.goto("/calculators?price=300000", { waitUntil: "networkidle" });
    expect(withContext).toBe(parseEuro(await transferTotal(page)));
    expect(withContext).toBe(8600);
  } finally {
    await removeFixture(svc);
  }
});

test("a property link naming no visible row is the bare calculator, with no error", async ({
  page,
}) => {
  const problems = watchForProblems(page);
  await page.goto(`/calculators?price=300000&property=${randomUUID()}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByRole("heading", { name: "Calculators" })).toBeVisible();
  await expect(page.getByText(/VAT status:/)).toHaveCount(0);
  await expect(page.getByText(/could not be read/)).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /^Not subject to VAT/i })).toBeChecked();
  expect(parseEuro(await transferTotal(page))).toBe(8600);

  // and a malformed one is dropped, not queried into an error page
  await page.goto("/calculators?price=300000&property=not-a-uuid", { waitUntil: "networkidle" });
  await expect(page.getByRole("radio", { name: /^Not subject to VAT/i })).toBeChecked();
  assertNoProblems(problems, "calculators with an unknown property");
});
