import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  assertNoProblems,
  assertShellRendered,
  fixtureProfile,
  isLocal,
  serviceClient,
  watchForProblems,
} from "./helpers";

/**
 * A08 (review 2026-10-18): what the shell gives a keyboard, a screen reader
 * and a phone.
 *
 *  - the sidebar is a named nav whose current link says so (aria-current),
 *    not by colour alone;
 *  - a keyboard-focused link shows a solid 2px outline — white on the navy
 *    sidebar and drawer, --ring (#2E6DA4) on white — while a ui primitive
 *    keeps its own ring and gets no second one (the one rule in
 *    app/globals.css @layer base);
 *  - below `sm` the header has an icon-only "Search" button that opens the
 *    same Global search dialog, and closing it returns focus to the button
 *    that is on screen;
 *  - every settings section opens with an <h2> naming it.
 *
 * Computed styles and focus are what a unit test cannot see; the colours'
 * contrast is measured in tests/unit/palette-parity.test.ts. Runs in the
 * desktop AND mobile projects. Read-only, except the one local-only test
 * that seeds two contacts for the search results (and deletes them).
 *
 * The outline is drawn 2px OUTSIDE the element, so a scroll box with no
 * padding cuts it off (A08 review): `outlineClipping` measures the outline's
 * box against the padding box of every clipping ancestor.
 */

/** Tailwind's `sm` — below it the wide search box is hidden. */
const narrowerThanSm = (testInfo: TestInfo) => (testInfo.project.use.viewport?.width ?? 1280) < 640;
/** Tailwind's `md` — below it the sidebar is behind the hamburger. */
const narrowerThanMd = (testInfo: TestInfo) => (testInfo.project.use.viewport?.width ?? 1280) < 768;

const WHITE = "rgb(255, 255, 255)";
const RING = "rgb(46, 109, 164)"; // --ring = --brand-500 #2E6DA4

/**
 * Press Tab until `target` holds focus. Keyboard focus is what `:focus-visible`
 * answers to; a programmatic `.focus()` is not a reliable stand-in.
 */
async function tabTo(page: Page, target: Locator, max = 80): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab never reached the target in ${max} presses`);
}

/**
 * The focus style the element SETTLES on — what is on screen for as long as it
 * holds focus. The nav and settings links carry `transition-colors`, and
 * Tailwind v4's list includes `outline-color`: on focus the outline fades from
 * the `* { outline-ring/50 }` colour to its focus colour over 150 ms, so a read
 * taken on the frame of the Tab press is a mid-fade mix (measured 2026-10-19:
 * oklab(… / 0.52) one frame in, rgb(255, 255, 255) once settled). It waits for
 * the element's running transitions, but no longer than FADE_CAP_MS — a fade
 * slower than that is read mid-way and fails the colour check.
 */
const FADE_CAP_MS = 300;

async function focusStyle(target: Locator) {
  return target.evaluate(async (el, capMs) => {
    const settled = Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, capMs))]);
    const s = getComputedStyle(el);
    return {
      focusVisible: el.matches(":focus-visible"),
      outlineStyle: s.outlineStyle,
      outlineWidth: parseFloat(s.outlineWidth),
      outlineColor: s.outlineColor,
      boxShadow: s.boxShadow,
    };
  }, FADE_CAP_MS);
}

/**
 * Where a clipping ancestor cuts the target's focus outline: for each
 * ancestor whose overflow is not `visible`, the edges of the outline's box
 * (the element's border box grown by outline-width + outline-offset) that
 * fall outside that ancestor's padding box. Empty means the whole outline
 * is drawn. Measured at the current scroll position.
 */
async function outlineClipping(target: Locator): Promise<string[]> {
  return target.evaluate((el) => {
    const s = getComputedStyle(el);
    const grow = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
    const r = el.getBoundingClientRect();
    const box = { left: r.left - grow, top: r.top - grow, right: r.right + grow, bottom: r.bottom + grow };
    const cuts: string[] = [];
    for (let a = el.parentElement; a; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.overflowX === "visible" && as.overflowY === "visible") continue;
      const ar = a.getBoundingClientRect();
      const pad = {
        left: ar.left + a.clientLeft,
        top: ar.top + a.clientTop,
        right: ar.left + a.clientLeft + a.clientWidth,
        bottom: ar.top + a.clientTop + a.clientHeight,
      };
      const name = `${a.tagName.toLowerCase()}.${[...a.classList].join(".")}`;
      const tol = 0.5;
      if (box.left < pad.left - tol) cuts.push(`${name}: left by ${(pad.left - box.left).toFixed(1)}px`);
      if (box.right > pad.right + tol) cuts.push(`${name}: right by ${(box.right - pad.right).toFixed(1)}px`);
      if (box.top < pad.top - tol) cuts.push(`${name}: top by ${(pad.top - box.top).toFixed(1)}px`);
      if (box.bottom > pad.bottom + tol) cuts.push(`${name}: bottom by ${(box.bottom - pad.bottom).toFixed(1)}px`);
    }
    return cuts;
  });
}

/** The visible main nav: the sidebar on a desktop, the drawer (opened here) on a phone. */
async function mainNav(page: Page, testInfo: TestInfo): Promise<Locator> {
  if (narrowerThanMd(testInfo)) {
    await page.getByRole("button", { name: "Open menu" }).click();
  }
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav, "exactly one Main nav is displayed").toHaveCount(1);
  await expect(nav).toBeVisible();
  return nav;
}

test.describe("[A08] the main nav says where you are", () => {
  test("the current module's link is aria-current=page; on its sub-page, aria-current=true", async ({ page }, testInfo) => {
    const problems = watchForProblems(page);
    await page.goto("/contacts", { waitUntil: "networkidle" });
    await assertShellRendered(page);
    let nav = await mainNav(page, testInfo);
    await expect(nav.getByRole("link", { name: "Contacts" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
    await expect(nav.locator("[aria-current]"), "one current link, not two").toHaveCount(1);

    await page.goto("/contacts/new", { waitUntil: "networkidle" });
    nav = await mainNav(page, testInfo);
    await expect(nav.getByRole("link", { name: "Contacts" })).toHaveAttribute("aria-current", "true");
    await expect(nav.locator('[aria-current="page"]'), "a sub-page is not the module's own page").toHaveCount(0);
    assertNoProblems(problems, "main nav aria-current");
  });

  test("a keyboard-focused nav link shows a solid white outline on the navy", async ({ page }, testInfo) => {
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    const nav = await mainNav(page, testInfo);
    const link = nav.getByRole("link", { name: "Contacts" });
    await tabTo(page, link);
    const s = await focusStyle(link);
    expect(s.focusVisible, "Tab focus matches :focus-visible").toBe(true);
    expect(s.outlineStyle).toBe("solid");
    expect(s.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(s.outlineColor, "white on --brand-950, not --ring").toBe(WHITE);
  });

  test("the FIRST nav link's outline is drawn whole — the drawer's scroll box does not cut its top edge", async ({ page }, testInfo) => {
    await page.goto("/contacts", { waitUntil: "networkidle" });
    const nav = await mainNav(page, testInfo);
    const first = nav.getByRole("link").first();
    await expect(first).toHaveText("Dashboard");
    await tabTo(page, first);
    expect((await focusStyle(first)).outlineStyle).toBe("solid");
    expect(await outlineClipping(first), "no clipping ancestor cuts the outline").toEqual([]);
  });
});

test.describe("[A08] focus outline on light surfaces", () => {
  test("a settings tab shows the --ring outline; the header's ui Button keeps only its own ring", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "networkidle" });

    // header first: Tab only moves forward, and the header precedes <main>.
    // The Security link is a Button primitive (asChild): `outline-none` plus
    // its own ring — the base rule must not draw a second one around it.
    const security = page.locator("header").getByRole("link", { name: "Security", exact: true });
    await tabTo(page, security);
    const b = await focusStyle(security);
    expect(b.focusVisible).toBe(true);
    expect(b.outlineStyle, "no outline on a primitive (no double ring)").toBe("none");
    expect(b.boxShadow, "the primitive's own ring is still there").not.toBe("none");

    const tab = page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Users" });
    await tabTo(page, tab);
    const t = await focusStyle(tab);
    expect(t.focusVisible).toBe(true);
    expect(t.outlineStyle).toBe("solid");
    expect(t.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(t.outlineColor).toBe(RING);
  });
});

test.describe("[A08] global search on every width", () => {
  test("one trigger is on screen, it opens Global search, and focus comes back to it", async ({ page }, testInfo) => {
    const problems = watchForProblems(page);
    await page.goto("/dashboard", { waitUntil: "networkidle" });
    const header = page.locator("header");
    const phoneTrigger = header.locator('button[aria-label="Search"]');
    const wideTrigger = header.locator("button", { hasText: "Search properties, contacts" });

    const shown = narrowerThanSm(testInfo) ? phoneTrigger : wideTrigger;
    const hidden = narrowerThanSm(testInfo) ? wideTrigger : phoneTrigger;
    await expect(shown).toBeVisible();
    await expect(hidden).toBeHidden();
    if (narrowerThanSm(testInfo)) {
      await expect(header.getByRole("button", { name: "Search", exact: true })).toBeVisible();
      await assertNoHorizontalOverflow(page, "header with the phone search button");
    }

    await shown.click();
    const dialog = page.getByRole("dialog", { name: "Global search" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("Search properties, contacts…")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(shown, "focus returns to the trigger on screen, not to <body>").toBeFocused();
    assertNoProblems(problems, "global search");
  });

  test("a keyboard-focused search result shows its whole outline — the results' scroll box cuts no edge", async ({ page }, testInfo) => {
    test.skip(!isLocal(), "seeds and deletes two contacts through the service client — local only");
    const svc = serviceClient();
    const { orgId } = await fixtureProfile(svc);
    const NAME = `E2EFocusClip${testInfo.project.name.replace(/\W/g, "")}`;
    const clean = () => svc.from("contacts").delete().eq("org_id", orgId).ilike("first_name", `${NAME}%`);
    await clean();
    const { error } = await svc.from("contacts").insert([
      { org_id: orgId, first_name: `${NAME}One`, contact_types: ["buyer"] },
      { org_id: orgId, first_name: `${NAME}Two`, contact_types: ["buyer"] },
    ]);
    expect(error, "seeding the two contacts").toBeNull();
    try {
      await page.goto("/dashboard", { waitUntil: "networkidle" });
      const header = page.locator("header");
      await (narrowerThanSm(testInfo)
        ? header.locator('button[aria-label="Search"]')
        : header.locator("button", { hasText: "Search properties, contacts" })
      ).click();
      const dialog = page.getByRole("dialog", { name: "Global search" });
      const input = dialog.getByPlaceholder("Search properties, contacts…");
      await expect(input).toBeFocused();
      await input.fill(NAME);
      const results = dialog.getByRole("button", { name: new RegExp(NAME) });
      await expect(results).toHaveCount(2);

      // Tab from the input: the first result, then the last
      for (const target of [results.first(), results.last()]) {
        await tabTo(page, target, 10);
        const s = await focusStyle(target);
        expect(s.focusVisible).toBe(true);
        expect(s.outlineStyle).toBe("solid");
        expect(s.outlineColor).toBe(RING);
        expect(await outlineClipping(target), "no clipping ancestor cuts the outline").toEqual([]);
      }
    } finally {
      await clean();
    }
  });
});

/**
 * Every settings section, in tab order, with the <h2> it opens with — the tab
 * label, except the Overview, whose heading names what it is. Mirrors
 * SETTINGS_SECTIONS (components/features/settings/settings-nav.tsx); the unit
 * test tests/unit/shell-navigation.test.ts holds the component to that list.
 */
const SETTINGS_HEADINGS: { path: string; tab: string; heading: string }[] = [
  { path: "/settings", tab: "Overview", heading: "Activation readiness" },
  { path: "/settings/organization", tab: "Organization", heading: "Organization" },
  { path: "/settings/users", tab: "Users", heading: "Users" },
  { path: "/settings/stages", tab: "Deal stages", heading: "Deal stages" },
  { path: "/settings/locations", tab: "Locations", heading: "Locations" },
  { path: "/settings/nudges", tab: "Nudges", heading: "Nudges" },
  { path: "/settings/lead-routing", tab: "Lead routing", heading: "Lead routing" },
  { path: "/settings/lead-escalation", tab: "Lead escalation", heading: "Lead escalation" },
  { path: "/settings/cyprus-config", tab: "Cyprus config", heading: "Cyprus config" },
  { path: "/settings/portals", tab: "Portals", heading: "Portals" },
  { path: "/settings/retention", tab: "Data retention", heading: "Data retention" },
];

test.describe("[A08] every settings section opens with an <h2> naming it", () => {
  for (const s of SETTINGS_HEADINGS) {
    test(`${s.path}: <h2> "${s.heading}"`, async ({ page }) => {
      await page.goto(s.path, { waitUntil: "networkidle" });
      const main = page.locator("main");
      await expect(main.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
      await expect(main.getByRole("heading", { level: 2 }).first()).toHaveText(s.heading);
      await expect(
        page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: s.tab, exact: true }),
      ).toHaveAttribute("aria-current", "page");
    });
  }
});
