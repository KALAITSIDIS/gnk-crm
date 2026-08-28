import { test, expect } from "@playwright/test";
import { isLocal, opTimeout } from "./helpers";

/**
 * The new-property wizard keeps a browser-local draft.
 *
 * WHY THIS SPEC EXISTS. On 2026-08-28 the operator entered a listing and it was
 * simply gone: the server logs showed two GETs of /properties/new and no POST
 * at all. The wizard writes NOTHING until "Create property", and "Continue"
 * only advances a step — so filling step 1 and leaving lost everything with no
 * row, no event and no warning. The draft is the fix; this is what stops it
 * quietly rotting.
 *
 * It asserts the three things that actually failed while it was being built,
 * each of which passed a type-check and a lint before a browser caught it:
 *
 *   1. the step-2 values come back at all — the first version restored only the
 *      controlled half, because it wrote into inputs that do not exist yet
 *      while the wizard is still on step 1;
 *   2. restoring does not destroy the draft — the restore triggers a save, and
 *      that save read the not-yet-populated inputs as empty and overwrote the
 *      draft it had just read. It survived exactly one round trip;
 *   3. discarding really clears it, rather than leaving a draft that ambushes
 *      the next listing.
 */

const DRAFT_KEY = "gnk:new-property-draft";

test.beforeEach(async ({ page }) => {
  test.skip(!isLocal(), "creates and abandons drafts — local only");
  await page.goto("/properties/new");
  await page.evaluate((k) => window.localStorage.removeItem(k), DRAFT_KEY);
});

test.afterEach(async ({ page }) => {
  await page.evaluate((k) => window.localStorage.removeItem(k), DRAFT_KEY).catch(() => {});
});

/** Step 1 → step 2, leaving the wizard on the details step. */
async function fillStepOne(page: import("@playwright/test").Page) {
  await page.goto("/properties/new");
  await page.getByLabel("Property type").click();
  await page.getByRole("option", { name: "Villa", exact: true }).click();
  await page.getByLabel("District").click();
  await page.getByRole("option", { name: "Paphos", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Title (EN)")).toBeVisible();
}

test("a half-finished entry survives leaving the page", async ({ page }) => {
  await fillStepOne(page);

  await page.getByLabel("Title (EN)").fill("Draft survivor villa");
  await page.getByLabel("Asking price (€)").fill("477000");
  await page.getByLabel("Bedrooms").fill("4");

  // The save is debounced; leaving instantly is the case that used to lose it.
  await expect
    .poll(async () => page.evaluate((k) => window.localStorage.getItem(k) !== null, DRAFT_KEY), {
      timeout: opTimeout(5_000),
    })
    .toBe(true);

  // Leave the page entirely, exactly as the operator did.
  await page.goto("/dashboard");
  await page.goto("/properties/new");

  await expect(page.getByText(/Restored what you had typed/i)).toBeVisible({
    timeout: opTimeout(10_000),
  });

  // Back on step 2, not step 1 — it resumes where it was left.
  await expect(page.getByLabel("Title (EN)")).toHaveValue("Draft survivor villa");
  await expect(page.getByLabel("Asking price (€)")).toHaveValue("477000");
  await expect(page.getByLabel("Bedrooms")).toHaveValue("4");
});

test("restoring does not empty the draft it just read", async ({ page }) => {
  await fillStepOne(page);
  await page.getByLabel("Title (EN)").fill("Second round trip");
  await expect
    .poll(async () => page.evaluate((k) => window.localStorage.getItem(k) !== null, DRAFT_KEY), {
      timeout: opTimeout(5_000),
    })
    .toBe(true);

  // TWO round trips. The first version of this feature passed one and failed
  // the second: restoring scheduled a save, and that save wrote the empty
  // form over the stored draft.
  for (let i = 0; i < 2; i++) {
    await page.goto("/dashboard");
    await page.goto("/properties/new");
    await expect(page.getByText(/Restored what you had typed/i)).toBeVisible({
      timeout: opTimeout(10_000),
    });
  }

  await expect(page.getByLabel("Title (EN)")).toHaveValue("Second round trip");

  const stored = await page.evaluate((k) => {
    const raw = window.localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as { fields: Record<string, string> }).fields.title_en : null;
  }, DRAFT_KEY);
  expect(stored, "the stored draft must still hold the title").toBe("Second round trip");
});

test("discarding clears it so it cannot ambush the next listing", async ({ page }) => {
  await fillStepOne(page);
  await page.getByLabel("Title (EN)").fill("To be discarded");
  await expect
    .poll(async () => page.evaluate((k) => window.localStorage.getItem(k) !== null, DRAFT_KEY), {
      timeout: opTimeout(5_000),
    })
    .toBe(true);

  await page.goto("/dashboard");
  await page.goto("/properties/new");
  await page.getByRole("button", { name: /Start blank instead/i }).click();

  await expect(page.getByText(/Restored what you had typed/i)).toBeHidden();
  // Back to step 1 with nothing carried over.
  await expect(page.getByLabel("Property type")).toBeVisible();
  expect(await page.evaluate((k) => window.localStorage.getItem(k), DRAFT_KEY)).toBeNull();
});
