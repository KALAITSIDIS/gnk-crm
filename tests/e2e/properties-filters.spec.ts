import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { assertShellRendered, fixtureProfile, isLocal, serviceClient } from "./helpers";

/**
 * The properties list's filter bar, sort and view name (A03).
 *
 * Regression guards for what already worked and was covered by nothing that
 * types or clicks — the search box, the Table/Card toggle, the selects — and
 * the state races A03 fixed in `components/features/properties/filters.tsx`:
 *
 *   - a change made while the previous one was still in flight was composed
 *     from the URL on screen, so it dropped that change (a search typed and
 *     then a district picked inside the 300 ms debounce; two selects back to
 *     back before the first answer);
 *   - Clear did not cancel the pending search, which then put itself back.
 *
 * Each URL assertion polls the parsed query rather than matching a string, so
 * parameter order is not part of the contract.
 *
 * Desktop only: the phone gets the cards and the same bar; the races are not
 * viewport-specific, and one run of them is the guard.
 */

const params = (page: Page) => new URL(page.url()).searchParams;
const param = (page: Page, key: string) => () => params(page).get(key);

const LAND_NOTE = /match only listings with that figure recorded/;

interface Fixture {
  id: string;
  reference: string;
  districtId: string;
}

/** One land listing in Paphos that matches the business example, with a reference nobody else has. */
async function seedLandPlot(): Promise<Fixture> {
  const svc = serviceClient();
  const { orgId } = await fixtureProfile(svc);
  const { data: district } = await svc.from("districts").select("id").eq("org_id", orgId).eq("code", "PAF").single();
  expect(district, "the seed has a Paphos district").not.toBeNull();
  const reference = `E2E-LAND-${randomBytes(3).toString("hex").toUpperCase()}`;
  const { data, error } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference,
      property_type: "land",
      transaction_type: "sale",
      status: "available",
      visibility: "private",
      district_id: district!.id,
      plot_area_sqm: 3200,
      building_density_pct: 95,
      asking_price: 410000,
      title: { en: "E2E land plot" },
    })
    .select("id")
    .single();
  expect(error, `seeding a plot: ${error?.message}`).toBeNull();
  return { id: data!.id, reference, districtId: district!.id };
}

async function removeFixture(f: Fixture | null) {
  if (!f) return;
  const { error } = await serviceClient().from("properties").delete().eq("id", f.id);
  expect(error, `fixture delete: ${error?.message}`).toBeNull();
}

async function pick(page: Page, combobox: string, option: string | RegExp) {
  await page.getByRole("combobox", { name: combobox, exact: true }).click();
  // exact for a string: "Sale" must not match "Sale & rent" (the "no filter" option)
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

const searchBox = (page: Page) => page.getByRole("searchbox", { name: /search properties/i });

test.describe("properties filters (A03)", () => {
  test.skip(({ isMobile }) => isMobile, "desktop: the races are not viewport-specific");

  let plot: Fixture | null = null;
  test.beforeEach(async () => {
    test.skip(!isLocal(), "seeding a listing needs the local service key");
    plot = await seedLandPlot();
  });
  test.afterEach(async () => {
    await removeFixture(plot);
    plot = null;
  });

  test("the search box finds a listing by its reference", async ({ page }) => {
    await page.goto("/properties?view=table", { waitUntil: "networkidle" });
    await searchBox(page).fill(plot!.reference);
    await expect.poll(param(page, "q")).toBe(plot!.reference);
    await expect(page.getByRole("link", { name: plot!.reference })).toBeVisible();
    await expect(page.getByTestId("properties-view-description")).toHaveText(`“${plot!.reference}”`);
  });

  test("a search typed and a district picked inside the debounce both land", async ({ page }) => {
    await page.goto("/properties?view=table", { waitUntil: "networkidle" });
    await searchBox(page).fill(plot!.reference);
    // no wait: the district is picked while the search's 300 ms timer is pending
    await pick(page, "District", "Paphos");
    await expect.poll(param(page, "district")).toBe(plot!.districtId);
    await expect.poll(param(page, "q")).toBe(plot!.reference);
    // and they stay: nothing lands later and takes one of them back
    await page.waitForTimeout(800);
    expect(params(page).get("q")).toBe(plot!.reference);
    expect(params(page).get("district")).toBe(plot!.districtId);
    await expect(page.getByRole("link", { name: plot!.reference })).toBeVisible();
  });

  test("two selects changed back to back keep both", async ({ page }) => {
    await page.goto("/properties?view=table", { waitUntil: "networkidle" });
    await pick(page, "Property type", "Land");
    await pick(page, "Transaction", "Sale");
    await expect.poll(param(page, "type")).toBe("land");
    await expect.poll(param(page, "transaction")).toBe("sale");
    await page.waitForTimeout(500);
    expect(params(page).get("type")).toBe("land");
    // the select shows what was picked, not the URL it replaced
    await expect(page.getByRole("combobox", { name: "Property type", exact: true })).toHaveText(/Land/);
  });

  test("Clear right after typing: the search does not come back", async ({ page }) => {
    await page.goto("/properties?view=table&sort=price_asc", { waitUntil: "networkidle" });
    await searchBox(page).fill("zz-nothing-matches");
    // Clear is offered for text not yet sent, and clicked inside the debounce
    await page.getByRole("button", { name: "Clear" }).click();
    await page.waitForTimeout(800);
    expect(params(page).get("q")).toBeNull();
    await expect(searchBox(page)).toHaveValue("");
    // Clear keeps how the list is shown
    expect(params(page).get("view")).toBe("table");
    expect(params(page).get("sort")).toBe("price_asc");
  });

  test("land filters commit on Enter, name the view, and survive a visit to a record and Back", async ({ page }) => {
    await page.goto("/properties?view=table", { waitUntil: "networkidle" });
    await pick(page, "District", "Paphos");
    await pick(page, "Property type", "Land");
    for (const [name, value] of [
      [/plot area from/i, "1500"],
      [/plot area up to/i, "6000"],
      [/building density at least/i, "90"],
    ] as const) {
      const box = page.getByRole("spinbutton", { name });
      await box.fill(value);
      await box.press("Enter");
    }
    await expect.poll(param(page, "plot_min")).toBe("1500");
    await expect.poll(param(page, "plot_max")).toBe("6000");
    await expect.poll(param(page, "density_min")).toBe("90");
    expect(params(page).get("district")).toBe(plot!.districtId);
    expect(params(page).get("type")).toBe("land");

    // the view names itself, on the page and in the tab
    const words = "Paphos · Land · plot 1.500–6.000 m² · density ≥ 90%";
    await expect(page.getByTestId("properties-view-description")).toHaveText(words);
    await expect(page).toHaveTitle(`Properties · ${words}`);
    await expect(page.getByText(LAND_NOTE)).toBeVisible();
    // the land table: Plot m² and Density in place of Area and Beds
    await expect(page.getByRole("columnheader", { name: /Plot m²/ })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Density" })).toBeVisible();
    await expect(page.getByRole("link", { name: plot!.reference })).toBeVisible();

    // the tab remembers the settled list URL for the record pages' back link
    const listUrl = await page.evaluate(() => `${location.pathname}${location.search}`);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("gnk:properties:last"))).toBe(listUrl);

    // a record and browser Back: the URL and the controls are restored
    await page.getByRole("link", { name: plot!.reference }).click();
    await expect(page).toHaveURL(new RegExp(`/properties/${plot!.id}`));
    await page.goBack();
    await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(listUrl);
    await expect(page.getByRole("spinbutton", { name: /plot area from/i })).toHaveValue("1500");
    await expect(page.getByRole("combobox", { name: "Property type", exact: true })).toHaveText(/Land/);

    // the record page's "Properties" link returns to the same view (its reading
    // half is the record page's back link, built in the same review)
    await page.getByRole("link", { name: plot!.reference }).click();
    await expect(page).toHaveURL(new RegExp(`/properties/${plot!.id}`));
    const back = page.locator("main").getByRole("link", { name: /^(←\s*)?properties$/i }).first();
    await expect(back).toHaveAttribute("href", listUrl);
    await back.click();
    await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(listUrl);
  });

  test("the Table and Card toggles switch the view, keep the filters and say which is on", async ({ page }) => {
    await page.goto("/properties?type=land", { waitUntil: "networkidle" });
    const table = page.getByRole("button", { name: "Table view" });
    const cards = page.getByRole("button", { name: "Card view" });
    await cards.click();
    await expect.poll(param(page, "view")).toBe("cards");
    await expect(cards).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("table")).toHaveCount(0);
    await table.click();
    await expect.poll(param(page, "view")).toBe("table");
    await expect(table).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("table").first()).toBeVisible();
    expect(params(page).get("type")).toBe("land");
  });

  test("a sortable header sorts, says so with aria-sort, and flips on the second click", async ({ page }) => {
    await page.goto("/properties?view=table", { waitUntil: "networkidle" });
    const price = page.getByRole("columnheader", { name: /^Price/ });
    await expect(price).not.toHaveAttribute("aria-sort", /.+/);
    await price.getByRole("link").click();
    await expect.poll(param(page, "sort")).toBe("price_asc");
    await expect(page.getByRole("columnheader", { name: /^Price/ })).toHaveAttribute("aria-sort", "ascending");
    await expect(page).toHaveTitle(/sorted by asking price ↑/);
    await page.getByRole("columnheader", { name: /^Price/ }).getByRole("link").click();
    await expect.poll(param(page, "sort")).toBe("price_desc");
    await expect(page.getByRole("columnheader", { name: /^Price/ })).toHaveAttribute("aria-sort", "descending");
    // the Sort select shows the same sort
    await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveText(/Asking price: high to low/);
  });
});

test.describe("properties filters — URLs a person can type (A03)", () => {
  test("a Beds value past int4 is no filter, not an error page (was 400 22003)", async ({ page }) => {
    for (const path of ["/properties?beds=2147483648", "/properties/map?beds=1e300", "/properties?beds=150&view=table"]) {
      await page.goto(path);
      await assertShellRendered(page);
    }
    const res = await page.request.get("/properties/export?beds=2147483648");
    expect(res.status()).toBe(200);
  });
});
