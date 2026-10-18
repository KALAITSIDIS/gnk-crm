import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A08 (review 2026-10-18), the parts a server render can prove:
 *
 *  - the sidebar is `<nav aria-label="Main">` and marks the current module
 *    with aria-current — "page" on the module's own page, "true" on one of
 *    its sub-pages — never by colour alone;
 *  - every settings section opens with an `<h2>` naming it, drawn once by the
 *    settings layout from the tabs' own list (SETTINGS_SECTIONS), and the
 *    panels inside a section do not open competing `<h2>`s;
 *  - the contacts filter bar names every control (a placeholder or a
 *    Select's current value is not a name);
 *  - global search has a second, icon-only trigger for phones on the same
 *    dialog.
 *
 * Focus outlines, the triggers' display at each width and focus return are
 * browser facts: tests/e2e/shell-navigation.spec.ts. Colour contrast:
 * tests/unit/palette-parity.test.ts.
 */

const nav = vi.hoisted(() => ({ pathname: "/dashboard", search: "" }));
const auth = vi.hoisted(() => ({ role: "admin" as string }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => `[${key}]` }));
vi.mock("@/lib/actions/entity-search", () => ({ searchEntities: vi.fn(async () => []) }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "u-1", orgId: "org-1", role: auth.role, fullName: "Admin Person" }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

const { SidebarNav } = await import("@/components/features/shared/sidebar-nav");
const { SETTINGS_SECTIONS } = await import("@/components/features/settings/settings-nav");
const { SettingsSectionHeading, settingsSectionHeading } = await import(
  "@/components/features/settings/settings-section-heading"
);
const { ContactsFilters } = await import("@/components/features/contacts/filters");
const { GlobalSearch } = await import("@/components/features/shared/global-search");
const { default: SettingsLayout } = await import("@/app/(app)/settings/layout");

const root = join(import.meta.dirname, "..", "..");

const html = (element: ReactElement) => renderToStaticMarkup(element).replace(/&amp;/g, "&");

/** Every opening tag of `tag` in the markup (attributes included). */
const tags = (markup: string, tag: string) => markup.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? [];

/** Source with its comments removed, so a comment that mentions `<h2>` is not one. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const attr = (tagText: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tagText)?.[1] ?? null;

beforeEach(() => {
  nav.pathname = "/dashboard";
  nav.search = "";
  auth.role = "admin";
});

describe("the sidebar names itself and marks the current module", () => {
  /** href -> aria-current of every link in the rendered sidebar */
  function currents(pathname: string): Map<string, string | null> {
    nav.pathname = pathname;
    const markup = html(createElement(SidebarNav));
    expect(markup).toMatch(/^<nav aria-label="Main"/);
    return new Map(tags(markup, "a").map((a) => [attr(a, "href")!, attr(a, "aria-current")]));
  }

  it("the module's own page is aria-current=page, and no other link is current", () => {
    const links = currents("/contacts");
    expect(links.get("/contacts")).toBe("page");
    expect([...links.values()].filter((v) => v !== null)).toEqual(["page"]);
  });

  it("a record or /new under the module is aria-current=true (the current section, not the page)", () => {
    for (const path of ["/contacts/1d3c2b0a-0000-4000-8000-000000000001", "/contacts/new"]) {
      const links = currents(path);
      expect(links.get("/contacts"), path).toBe("true");
      expect([...links.values()].filter((v) => v !== null), path).toEqual(["true"]);
    }
    expect(currents("/settings/users").get("/settings")).toBe("true");
    expect(currents("/settings").get("/settings")).toBe("page");
  });

  it("a path that only starts with a module's letters is not that module", () => {
    const links = currents("/contactsx");
    expect([...links.values()].filter((v) => v !== null)).toEqual([]);
  });
});

describe("every settings section opens with an <h2> naming it", () => {
  it("each tab's path has a heading: the tab label, the Overview its own name", () => {
    for (const s of SETTINGS_SECTIONS) {
      const expected = s.href === "/settings" ? "Activation readiness" : s.label;
      expect(settingsSectionHeading(s.href), s.href).toBe(expected);
    }
  });

  it("there is no heading off the settings sections, or under a section's sub-path", () => {
    for (const path of ["/dashboard", "/settings/unknown", "/settings/users/x", "/settingsx", ""]) {
      expect(settingsSectionHeading(path), path).toBeNull();
    }
  });

  it("renders as an <h2> with exactly that text, and nothing off the sections", () => {
    nav.pathname = "/settings/lead-routing";
    expect(html(createElement(SettingsSectionHeading))).toMatch(/^<h2 [^>]*>Lead routing<\/h2>$/);
    nav.pathname = "/settings/nowhere";
    expect(html(createElement(SettingsSectionHeading))).toBe("");
  });

  it("every tab points at a settings page that exists", () => {
    for (const s of SETTINGS_SECTIONS) {
      const page = join(root, "app", "(app)", ...s.href.split("/").filter(Boolean), "page.tsx");
      expect(existsSync(page), s.href + " has no page.tsx").toBe(true);
    }
  });

  it("the settings layout draws it after the h1 and the tabs — for admins only", async () => {
    nav.pathname = "/settings/users";
    const child = createElement("p", null, "CHILD");
    const admin = html((await SettingsLayout({ children: child })) as ReactElement);
    const h1 = admin.indexOf("<h1");
    const tabs = admin.indexOf('aria-label="Settings sections"');
    const h2 = admin.indexOf("<h2");
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(tabs).toBeGreaterThan(h1);
    expect(h2).toBeGreaterThan(tabs);
    expect(admin.indexOf("CHILD")).toBeGreaterThan(h2);
    expect(admin).toMatch(/<h2 [^>]*>Users<\/h2>/);

    auth.role = "agent";
    const agent = html((await SettingsLayout({ children: child })) as ReactElement);
    expect(agent).not.toContain("<h2");
    expect(agent).not.toContain("CHILD");
  });

  it("the settings panels open no <h2> of their own under the section's (A08 demoted them to <h3>)", () => {
    // Rendered on /security, not under the settings layout: their <h2> IS
    // that page's section heading.
    const notUnderSettings = new Set(["security-panel.tsx", "change-password-form.tsx"]);
    // Known residue, other owners' files in the 2026-10-18 review: the
    // deal-health note's <h2> (stream D edits that copy) and each portal
    // card's <h2> (the portal session). Each is a one-word h2 -> h3.
    const residue = new Set(["nudge-thresholds-panel.tsx", "portal-card.tsx"]);
    const dir = join(root, "components", "features", "settings");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx") && !notUnderSettings.has(f) && !residue.has(f))
      .filter((f) => /<h2[\s>]/.test(code(readFileSync(join(dir, f), "utf8"))))
      .filter((f) => f !== "settings-section-heading.tsx");
    const pages = readdirSync(join(root, "app", "(app)", "settings"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith("page.tsx"))
      .filter((f) => /<h2[\s>]/.test(code(readFileSync(join(root, "app", "(app)", "settings", f), "utf8"))));
    expect([...offenders, ...pages]).toEqual([]);
  });
});

describe("the contacts filter bar names every control", () => {
  it("each text box and each Select trigger has an aria-label — placeholders and values are not names", () => {
    nav.pathname = "/contacts";
    const markup = html(createElement(ContactsFilters, { agents: [{ id: "a-1", full_name: "Agent One" }] }));
    const inputs = tags(markup, "input").filter((t) => attr(t, "type") !== "hidden");
    const triggers = tags(markup, "button").filter((t) => attr(t, "role") === "combobox");
    expect(inputs.length, "search + nationality").toBe(2);
    expect(triggers.length, "type, temperature, source, agent, language, show").toBe(6);
    const names = [...inputs, ...triggers].map((t) => attr(t, "aria-label") ?? "(none)");
    expect(names.sort()).toEqual(
      ["Search contacts", "Contact type", "Temperature", "Source", "Agent", "Language", "Nationality", "Show"].sort(),
    );
  });
});

describe("global search has a phone trigger on the same dialog", () => {
  it("two dialog triggers: the wide box from sm up, an icon-only Search button below sm", () => {
    const markup = html(createElement(GlobalSearch));
    const triggers = tags(markup, "button").filter((t) => attr(t, "aria-haspopup") === "dialog");
    expect(triggers).toHaveLength(2);
    const [wide, phone] = triggers;
    expect(attr(wide, "class")).toMatch(/(^|\s)hidden(\s|$)/);
    expect(attr(wide, "class")).toMatch(/(^|\s)sm:flex(\s|$)/);
    expect(attr(wide, "aria-label")).toBeNull();
    expect(attr(phone, "aria-label")).toBe("Search");
    expect(attr(phone, "class")).toMatch(/(^|\s)sm:hidden(\s|$)/);
    expect(attr(phone, "type")).toBe("button");
    // both open the one dialog, which is closed until asked for
    expect(markup).not.toContain('role="dialog"');
  });
});
