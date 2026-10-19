import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { detailsLayout, layoutFields } from "@/lib/services/property-layout";
import { detailsFormPost } from "@/lib/testing/details-form-post";

// the form's actions and hooks, outside a Next app: rendering needs neither
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/actions/properties", () => ({ updatePropertySection: vi.fn() }));
vi.mock("@/lib/actions/geo", () => ({ fetchLocationFallback: vi.fn(), resolveMapsShortLink: vi.fn() }));

const { DetailsForm } = await import("@/components/features/properties/detail-forms");

/**
 * F07: the Details tab as the server renders it, per kind of property. A plot
 * opens on its planning; a development on its build and handover; a flat as it
 * always did. What does not suit the property sits in a NATIVE <details> —
 * rendered, so its inputs post — and opens when it holds a value.
 */
const UPDATED_AT = "2026-10-18T09:00:00.000000+00:00";

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "prop-1",
    kind: "standalone",
    property_type: "apartment",
    status: "available",
    visibility: "private",
    transaction_type: "sale",
    vat_status: "unknown",
    features: [],
    location: null,
    location_approx: false,
    updated_at: UPDATED_AT,
    ...over,
  };
}

const markup = (property: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(DetailsForm, { property, areas: [] }));

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/<[^>]+>/g, "");

/** Section headings and collapsed-group summaries, in document order. */
function outline(html: string): string[] {
  return [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>|<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((m) =>
    m[1] !== undefined ? decode(m[1]) : `[details] ${decode(m[2]!)}`,
  );
}

/** The <details> element of a group: its opening tag and its whole markup. */
function detailsOf(html: string, group: string) {
  const m = new RegExp(`<details data-details-group="${group}"[^>]*>[\\s\\S]*?</details>`).exec(html);
  if (!m) return null;
  return { tag: /^<details[^>]*>/.exec(m[0])![0], body: m[0] };
}

/** Does the markup carry a control posting this layout field? */
function rendersField(html: string, field: string): boolean {
  if (field === "location") return html.includes('name="latitude"') && html.includes('name="longitude"');
  if (field === "features") return html.includes('name="features"');
  return html.includes(`name="${field}"`);
}

const LAND = row({
  property_type: "land",
  plot_area_sqm: 1200,
  planning_zone_code: "Κα6",
  building_density_pct: 60,
  water_available: true,
  bedrooms: 2,
  features: ["sea_view", "furnished"],
});

describe("a plot of land", () => {
  const html = markup(LAND);

  it("Location → Plot & planning → Access & utilities → Constraints → Pricing → Features, then the set-aside groups, then notes", () => {
    expect(outline(html)).toEqual([
      "Location",
      "Plot & planning",
      "Access & utilities",
      "Constraints",
      "Pricing",
      "VAT treatment",
      "Features",
      "[details] Building & accommodation — not usual for land · 1 recorded: Bedrooms 2",
      "[details] Build & handover — not usual for land · nothing recorded",
      "Internal notes",
    ]);
    expect(html.indexOf("Plot &amp; planning")).toBeLessThan(html.indexOf("<details"));
  });

  it("the group holding a value is OPEN, the empty one closed — and both carry their inputs", () => {
    const rooms = detailsOf(html, "building_accommodation")!;
    const build = detailsOf(html, "build_handover")!;
    expect(rooms.tag).toMatch(/\sopen=""/);
    expect(build.tag).not.toMatch(/\sopen/);
    // closed, and its inputs are still in the form — so they post
    expect(build.body).toContain('name="delivery_date"');
    expect(build.body).toContain('name="construction_status"');
    expect(rooms.body).toMatch(/name="bedrooms"[^>]*value="2"|value="2"[^>]*name="bedrooms"/);
  });

  it("renders a control for every field of its layout, each exactly once", () => {
    const fields = layoutFields(detailsLayout({ property_type: "land", kind: "standalone" }));
    for (const f of fields) expect(rendersField(html, f), f).toBe(true);
    for (const f of fields.filter((x) => x !== "features" && x !== "location")) {
      expect(html.split(`name="${f}"`).length - 1, f).toBe(1);
    }
  });

  it("water and electricity are a three-way answer, not a checkbox", () => {
    expect(html).toMatch(/<select[^>]*name="water_available"/);
    expect(html).toMatch(/<select[^>]*name="electricity_available"/);
    expect(html).not.toMatch(/role="checkbox"[^>]*id="water_available"/);
  });
});

describe("a flat: unchanged", () => {
  const html = markup(row({ bedrooms: 2, covered_area_sqm: 92 }));

  it("the sections it always had, nothing collapsed, no land panel", () => {
    expect(outline(html)).toEqual([
      "Location",
      "Pricing",
      "VAT treatment",
      "Areas & rooms",
      "Build & handover",
      "Features",
      "Internal notes",
    ]);
    expect(html).not.toContain("<details");
    for (const f of ["planning_zone_code", "building_density_pct", "water_available", "road_frontage_m"]) {
      expect(html).not.toContain(`name="${f}"`);
    }
  });

  it("renders a control for every field of its layout", () => {
    for (const f of layoutFields(detailsLayout({ property_type: "apartment", kind: "standalone" }))) {
      expect(rendersField(html, f), f).toBe(true);
    }
  });
});

describe("a development", () => {
  const html = markup(
    row({ kind: "project", property_type: "apartment", plot_area_sqm: 4000, construction_status: "under_construction" }),
  );

  it("opens on Build & handover; the rooms are set aside because each unit carries its own", () => {
    const o = outline(html);
    expect(o[0]).toBe("Build & handover");
    expect(o).toContain("[details] Building & accommodation — each unit carries its own · nothing recorded");
    expect(detailsOf(html, "building_accommodation")!.tag).not.toMatch(/\sopen/);
    expect(html).toContain("A new unit takes its construction status, delivery date and energy class from here.");
  });

  it("points at the Units matrix for prices, and labels its price and plot as a development's", () => {
    expect(html).toContain('href="/properties/prop-1/units"');
    expect(html).toContain("From price (€)");
    expect(html).toContain("Site plot (m²)");
    expect(html).not.toContain("Asking price (€)");
  });
});

describe("a rental", () => {
  it("leads its pricing with the rent; every price input is still there", () => {
    const html = markup(row({ transaction_type: "rent" }));
    expect(html.indexOf('name="rent_price_month"')).toBeLessThan(html.indexOf('name="asking_price"'));
    for (const f of ["asking_price", "min_acceptable_price", "owner_net_price", "rent_price_month"]) {
      expect(html).toContain(`name="${f}"`);
    }
  });
});

describe("the collapse is native, never a component that unmounts", () => {
  it("detail-forms.tsx uses no Radix Collapsible or Accordion", () => {
    const src = readFileSync(
      join(process.cwd(), "components", "features", "properties", "detail-forms.tsx"),
      "utf-8",
    );
    // neither imported nor rendered (the comments may name them — to forbid them)
    expect(src).not.toMatch(/import[^;]*\b(Collapsible|Accordion)\b/);
    expect(src).not.toMatch(/<(Collapsible|Accordion)\b/);
    expect(src).toContain("<details");
  });
});

describe("the test helper posts what the form renders", () => {
  it("every input's rendered value is what detailsFormPost sends for it", () => {
    for (const property of [
      LAND,
      row({ bedrooms: 0, covered_area_sqm: 92, address: "1 Odos", delivery_date: "2027-06-30" }),
      row({ kind: "project", plot_area_sqm: 4000, year_built: 2020 }),
    ]) {
      const html = markup(property);
      const posted = detailsFormPost(property);
      // inputs only: a textarea's value is its body, and these fixtures leave them empty
      const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
      let compared = 0;
      for (const tag of inputs) {
        const name = /\sname="([^"]+)"/.exec(tag)?.[1];
        if (!name || /type="(hidden|checkbox)"/.test(tag) || name === "features") continue;
        if (name === "latitude" || name === "longitude") continue; // controlled, from the map point
        const value = /\svalue="([^"]*)"/.exec(tag)?.[1] ?? "";
        expect(posted.get(name), name).toBe(value.replace(/&amp;/g, "&"));
        compared++;
      }
      expect(compared).toBeGreaterThan(10);
    }
  });
});
