import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Every control in the properties filter bar has an accessible name (A08).
 *
 * The bar was a row of placeholder-only boxes and Select triggers that a
 * screen reader announced as "combobox, Paphos" with no field name, and the
 * Table/Card toggles had only a title and no pressed state. The e2e DOM walk
 * (tests/e2e/accessibility.spec.ts FORM_PAGES, /properties) catches that in a
 * browser on CI; this renders the bar the way the server does and checks the
 * same thing on every unit run, for the URLs that change what it renders.
 *
 * A name is what the e2e walk accepts: aria-label, aria-labelledby that
 * resolves to text, a <label for>, or a title. A placeholder is NOT a name: it
 * vanishes on input and is not exposed consistently.
 */

const nav = vi.hoisted(() => ({ query: "" }));

// the bar's hooks outside a Next app: rendering needs no router
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  usePathname: () => "/properties",
  useSearchParams: () => new URLSearchParams(nav.query),
}));

const { PropertiesFilters } = await import("@/components/features/properties/filters");

const DISTRICT = "00000000-0000-4000-8000-0000000000d1";
const AREA = "00000000-0000-4000-8000-0000000000a1";
const DISTRICTS = [{ id: DISTRICT, name: "Paphos" }];
const AREAS = [{ id: AREA, districtId: DISTRICT, name: "Peyia" }];

function render(query: string): string {
  nav.query = query;
  return renderToStaticMarkup(createElement(PropertiesFilters, { districts: DISTRICTS, areas: AREAS }));
}

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

interface Tag {
  tag: string;
  attrs: Map<string, string>;
}

/** Opening tags of the given elements. React escapes `>` inside attribute values. */
function openingTags(html: string, names: readonly string[]): Tag[] {
  const re = new RegExp(`<(${names.join("|")})\\b([^>]*)>`, "g");
  return [...html.matchAll(re)].map(([, tag, body]) => {
    const attrs = new Map<string, string>();
    for (const [, key, value] of body.matchAll(/([^\s=/]+)(?:="([^"]*)")?/g)) {
      attrs.set(key, decode(value ?? ""));
    }
    return { tag, attrs };
  });
}

/** The text of the element carrying `id`, tags stripped. */
function textOfId(html: string, id: string): string | null {
  const m = new RegExp(`<(\\w+)\\b[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return m ? decode(m[2].replace(/<[^>]*>/g, "")).trim() : null;
}

/** The accessible name the e2e walk would find, or null. Never the placeholder. */
function accessibleName(html: string, { attrs }: Tag): string | null {
  const label = attrs.get("aria-label")?.trim();
  if (label) return label;
  const labelledby = attrs.get("aria-labelledby");
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => textOfId(html, id) ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  const id = attrs.get("id");
  if (id) {
    const forLabel = new RegExp(`<label\\b[^>]*\\sfor="${id}"[^>]*>([\\s\\S]*?)</label>`).exec(html);
    const text = forLabel ? decode(forLabel[1].replace(/<[^>]*>/g, "")).trim() : "";
    if (text) return text;
  }
  const title = attrs.get("title")?.trim();
  return title || null;
}

/** Form controls in the accessibility tree: what tests/e2e/accessibility.spec.ts walks. */
function controls(html: string): Tag[] {
  return openingTags(html, ["input", "select", "textarea", "button", "div", "span"]).filter((t) => {
    if (t.attrs.get("aria-hidden") === "true" || t.attrs.get("tabindex") === "-1") return false;
    if (t.tag === "input") return t.attrs.get("type") !== "hidden";
    if (t.tag === "select" || t.tag === "textarea") return true;
    return t.attrs.get("role") === "combobox";
  });
}

function namesOf(html: string): (string | null)[] {
  return controls(html).map((c) => accessibleName(html, c));
}

const FULL_SET = [
  "q=PAF",
  `district=${DISTRICT}`,
  `area=${AREA}`,
  "type=land",
  "transaction=sale",
  "status=available",
  "visibility=public",
  "kind=all",
  "mandate=active",
  "beds=2",
  "price_min=100000",
  "price_max=500000",
  "plot_min=1500",
  "plot_max=6000",
  "density_min=90",
  "scope=all",
  "sort=plot_desc",
  "view=cards",
].join("&");

const URLS: readonly [string, string][] = [
  ["the bare list", ""],
  ["every filter, bound, sort and view set", FULL_SET],
  ["archived, all kinds, the table", "scope=archived&kind=all&view=table"],
  ["values the server does not read", "district=not-a-guid&beds=-3&density_min=abc&view=grid&sort=nope"],
];

/** The field names a person reads, in the order the bar shows them. */
const FIELD_NAMES = [
  "Search properties by reference, title or address",
  "District",
  "Area",
  "Property type",
  "Transaction",
  "Status",
  "Visibility",
  "Kind",
  "Mandate",
  "Bedrooms at least",
  "Price from (€)",
  "Price up to (€)",
  "Plot area from (m²)",
  "Plot area up to (m²)",
  "Building density at least (%)",
  "Active or archived",
  "Sort",
];

describe("the properties filter bar names every control", () => {
  it.each(URLS)("%s: no control is nameless, and no two share a name", (_, query) => {
    const html = render(query);
    const all = controls(html);
    const nameless = all.filter((c) => !accessibleName(html, c));
    // described the way the e2e walk describes them: what it is, and the placeholder if any
    expect(
      nameless.map(({ tag, attrs }) =>
        [tag, ...["type", "role", "placeholder"].filter((k) => attrs.has(k)).map((k) => `${k}="${attrs.get(k)}"`)].join(" "),
      ),
    ).toEqual([]);
    const names = namesOf(html);
    expect(new Set(names).size, `duplicate names: ${names.join(" | ")}`).toBe(names.length);
  });

  it.each(URLS)("%s: the names are the field names, whatever the values", (_, query) => {
    expect(namesOf(render(query))).toEqual(FIELD_NAMES);
  });

  it("a placeholder is never the name: every placeholder sits beside a different, real name", () => {
    const html = render("");
    const withPlaceholder = controls(html).filter((c) => c.attrs.get("placeholder"));
    // the search box and the six number boxes
    expect(withPlaceholder).toHaveLength(7);
    for (const c of withPlaceholder) {
      expect(c.attrs.get("aria-label"), c.attrs.get("placeholder")).toBeTruthy();
      expect(c.attrs.get("aria-label")).not.toBe(c.attrs.get("placeholder"));
    }
  });

  it("the land bounds are a named group, described by the note that says what an unknown value does", () => {
    for (const query of ["", "plot_min=1500"]) {
      const html = render(query);
      expect(html).toMatch(/<fieldset\b[^>]*><legend class="sr-only">Land and plot<\/legend>/);
      const all = controls(html);
      const land = all.filter((c) => /^(Plot area|Building density)/.test(c.attrs.get("aria-label") ?? ""));
      expect(land.map((c) => c.attrs.get("aria-label"))).toEqual([
        "Plot area from (m²)",
        "Plot area up to (m²)",
        "Building density at least (%)",
      ]);
      for (const c of land) {
        const id = c.attrs.get("aria-describedby");
        expect(id, c.attrs.get("aria-label")).toBeTruthy();
        // the note exists once, with text, whether it is shown or screen-reader only
        expect(html.split(`id="${id}"`)).toHaveLength(2);
        expect(textOfId(html, id!)).toMatch(/left out, not counted as zero/);
      }
      // the other number boxes are not described by the land note
      const others = all.filter((c) => c.attrs.get("type") === "number" && !land.includes(c));
      expect(others).toHaveLength(3);
      for (const c of others) expect(c.attrs.get("aria-describedby")).toBeUndefined();
    }
  });
});

describe("the Table/Card toggles say which layout was chosen", () => {
  function toggles(query: string) {
    const html = render(query);
    const buttons = openingTags(html, ["button"]).filter((b) => b.attrs.has("aria-pressed"));
    return {
      html,
      named: buttons.map((b) => [b.attrs.get("aria-label"), b.attrs.get("aria-pressed")]),
    };
  }

  it.each([
    ["the automatic layout: nothing chosen, neither pressed", "", "false", "false"],
    ["an unknown view is the automatic layout", "view=grid", "false", "false"],
    ["view=table", "view=table", "true", "false"],
    ["view=cards", "view=cards", "false", "true"],
    ["the choice survives a full filter set", FULL_SET, "false", "true"],
  ])("%s", (_, query, table, cards) => {
    expect(toggles(query).named).toEqual([
      ["Table view", table],
      ["Card view", cards],
    ]);
  });

  it("the two toggles are one named group", () => {
    const { html } = toggles("");
    const group = /<div\b[^>]*role="group"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    expect(group, "no role=group around the toggles").not.toBeNull();
    expect(openingTags(group![0], ["div"])[0].attrs.get("aria-label")).toBe("Layout");
    expect(group![1]).toMatch(/aria-label="Table view"[\s\S]*aria-label="Card view"/);
  });
});
