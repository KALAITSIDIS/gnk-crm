import { test, expect, type Page } from "@playwright/test";

/**
 * Accessible-name regression suite (audit finding A11Y-1).
 *
 * The original defect: every `<Select>` sitting under a visible `<Label>` was
 * unreachable by name — the Label had no `htmlFor` and the SelectTrigger no
 * `id` — so a screen reader announced a bare "combobox". WCAG 2.1 SC 4.1.2.
 *
 * Grepping for `<Label>` only catches the shape of the bug I already knew
 * about. This walks the rendered DOM instead and asserts that EVERY form
 * control has a computed accessible name, so a control added later with no
 * label at all (placeholder-only, say) also fails.
 */

interface NamelessControl {
  tag: string;
  type: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  text: string;
}

/**
 * Approximates the accessible-name computation for form controls:
 * aria-label > aria-labelledby > <label for> > wrapping <label> > title.
 * Deliberately does NOT count placeholder — a placeholder is not an
 * accessible name (it vanishes on input and is not exposed consistently).
 */
async function findNamelessControls(page: Page): Promise<NamelessControl[]> {
  return page.evaluate(() => {
    const selector = [
      "input:not([type=hidden])",
      "select",
      "textarea",
      "[role=combobox]",
    ].join(",");

    /**
     * Only controls that are actually IN the accessibility tree can need a
     * name. Radix's Select renders a 1x1 `aria-hidden` native <select> purely
     * so the form submits a value; it is not exposed to assistive tech and
     * must not be flagged. Same for anything inside an aria-hidden subtree or
     * removed from the tab order.
     */
    const inAccessibilityTree = (el: Element) => {
      if (el.closest('[aria-hidden="true"]')) return false;
      if ((el as HTMLElement).tabIndex < 0) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none";
    };

    const named = (el: Element): boolean => {
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return true;

      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const ok = labelledby
          .split(/\s+/)
          .some((id) => (document.getElementById(id)?.textContent ?? "").trim().length > 0);
        if (ok) return true;
      }

      const id = el.getAttribute("id");
      if (id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (forLabel && (forLabel.textContent ?? "").trim()) return true;
      }

      if (el.closest("label")) return true;
      const title = el.getAttribute("title");
      if (title && title.trim()) return true;

      return false;
    };

    return [...document.querySelectorAll(selector)]
      .filter(inAccessibilityTree)
      .filter((el) => !named(el))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        id: el.getAttribute("id"),
        placeholder: el.getAttribute("placeholder"),
        text: (el.textContent ?? "").trim().slice(0, 40),
      }));
  });
}

function describe(controls: NamelessControl[]): string {
  return controls
    .map(
      (c) =>
        `  <${c.tag}${c.type ? ` type="${c.type}"` : ""}${c.name ? ` name="${c.name}"` : ""}` +
        `${c.id ? ` id="${c.id}"` : ""}>` +
        `${c.placeholder ? ` placeholder="${c.placeholder}"` : ""}` +
        `${c.text ? ` text="${c.text}"` : ""}`,
    )
    .join("\n");
}

/** Pages whose forms render without needing a dialog opened first. */
const FORM_PAGES = [
  { name: "New property (wizard step 1)", path: "/properties/new" },
  { name: "New contact", path: "/contacts/new" },
  { name: "Calculators", path: "/calculators" },
  { name: "Tasks (quick add)", path: "/tasks" },
  { name: "Keys (filters)", path: "/keys" },
  { name: "Leads (filters)", path: "/leads" },
  { name: "Settings — organization", path: "/settings/organization" },
  { name: "Settings — users", path: "/settings/users" },
  { name: "Settings — Cyprus config", path: "/settings/cyprus-config" },
];

for (const { name, path } of FORM_PAGES) {
  test(`${name}: every form control has an accessible name`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    const nameless = await findNamelessControls(page);
    expect(
      nameless,
      `${nameless.length} control(s) on ${path} have no accessible name:\n${describe(nameless)}`,
    ).toEqual([]);
  });
}

test("New property wizard step 2: every control has an accessible name", async ({ page }) => {
  await page.goto("/properties/new", { waitUntil: "networkidle" });
  // step 1 gates Continue until type + district are chosen
  await page.getByLabel(/^Property type$/).click();
  await page.getByRole("option").first().click();
  await page.getByLabel(/^District$/).click();
  await page.getByRole("option").first().click();
  await page.locator("main").getByRole("button", { name: /^continue$/i }).click();

  const nameless = await findNamelessControls(page);
  expect(
    nameless,
    `step 2 has ${nameless.length} unnamed control(s):\n${describe(nameless)}`,
  ).toEqual([]);
});

test("Add lead dialog: every control has an accessible name", async ({ page }) => {
  await page.goto("/leads", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /add lead/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const nameless = await findNamelessControls(page);
  expect(
    nameless,
    `add-lead dialog has ${nameless.length} unnamed control(s):\n${describe(nameless)}`,
  ).toEqual([]);
});

/**
 * The specific controls named in finding A11Y-1, pinned by the label the user
 * reads. These are the assertions that would have failed before the fix.
 */
test("[A11Y-1] the property wizard selects are reachable by their visible label", async ({
  page,
}) => {
  await page.goto("/properties/new", { waitUntil: "networkidle" });
  for (const label of [/^Kind$/, /^Property type$/, /^Transaction$/, /^District$/]) {
    await expect(page.getByLabel(label), `no control named ${label}`).toBeVisible();
  }
});

test("[A11Y-1] the add-lead selects are reachable by their visible label", async ({ page }) => {
  await page.goto("/leads", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /add lead/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/^Source$/)).toBeVisible();
  await expect(dialog.getByLabel(/^Channel$/)).toBeVisible();
  await expect(dialog.getByLabel(/link contact/i)).toBeVisible();
});

test("[A11Y-1] checkbox groups are exposed as named groups, not orphan labels", async ({
  page,
}) => {
  // Languages / Contact types are several checkboxes under one label, so they
  // take role="group" + aria-labelledby rather than htmlFor.
  await page.goto("/contacts/new", { waitUntil: "networkidle" });
  await expect(page.getByRole("group", { name: /languages/i })).toBeVisible();
  await expect(page.getByRole("group", { name: /contact types/i })).toBeVisible();
});
