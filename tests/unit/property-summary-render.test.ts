import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PropertySummary } from "@/components/features/properties/property-summary";
import { PropertyTabs } from "@/components/features/properties/property-tabs";

/**
 * A08 PR 3 — the summary strip as the server renders it, without a database
 * (supabase/tests/property-summary.test.ts drives it through the real page and
 * RLS). Pins what the layout promises — two columns on a phone, four from lg,
 * the next action across two — that the cells are a <dl> of terms and values
 * under a named region, and that the strip prints only the fields it is
 * about: handed the whole property row, as the page hands it, the owner's net
 * price, the floor price and the internal notes never reach the markup.
 */

type Props = ComponentProps<typeof PropertySummary>;

const ROW = {
  id: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01",
  reference: "PAF0042",
  kind: "standalone",
  status: "available",
  visibility: "public",
  transaction_type: "sale",
  asking_price: 265000,
  rent_price_month: null,
  owner_contact_id: "c1",
  developer_contact_id: null,
  assigned_agent_id: "a1",
  // the row's other columns, which the strip must not print
  owner_net_price: 199123,
  min_acceptable_price: 233777,
  internal_notes: "owner will take a quick offer",
  title: { en: "Sea-view flat" },
};

const render = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(
      PropertyTabs,
      { initialTab: "overview" } as ComponentProps<typeof PropertyTabs>,
      createElement(PropertySummary, {
        property: ROW,
        contacts: new Map([["c1", { id: "c1", label: "Andreas Owner" }]]),
        agent: { full_name: "Maria Agent", is_active: true },
        nextTask: { id: "t1", title: "Call the owner", due_at: "2026-10-21T20:59:00Z" },
        nextViewing: { id: "v1", scheduled_at: "2026-10-23T11:00:00Z" },
        mandates: [{ type: "exclusive", status: "active", expiry_date: "2027-01-12" }],
        mandatesComplete: true,
        quality: {
          missing: [{ key: "cover", label: "Cover photo", points: 5 }],
          warnings: [],
          essentialsMissing: [{ key: "cover", label: "Cover photo", points: 5 }],
        } as unknown as Props["quality"],
        viewerIsAdmin: true,
        now: new Date("2026-10-19T09:00:00Z"),
        ...over,
      }),
    ),
  );

const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

describe("PropertySummary (rendered)", () => {
  it("a named region holding one <dl>: two columns on a phone, four from lg, the next action across two", () => {
    const html = render();
    // inside the Tabs root, as on the page
    expect(html).toMatch(/^<div [^>]*data-slot="tabs"[^>]*><section aria-labelledby="property-summary-heading"/);
    expect(html).toContain('<h2 id="property-summary-heading" class="sr-only">Summary</h2>');
    const dl = html.match(/<dl class="([^"]+)">/)?.[1] ?? "";
    expect(dl.split(" ")).toEqual(expect.arrayContaining(["grid", "grid-cols-2", "lg:grid-cols-4"]));
    expect(html).toMatch(/<div class="min-w-0 col-span-2" data-summary="next">/);
    const cells = [...html.matchAll(/data-summary="([a-z]+)"><dt[^>]*>([^<]+)<\/dt><dd/g)].map((m) => [m[1], m[2]]);
    expect(cells).toEqual([
      ["price", "Price"],
      ["availability", "Availability"],
      ["party", "Owner"],
      ["agent", "Responsible agent"],
      ["next", "Next action"],
      ["mandate", "Mandate"],
      ["outstanding", "Outstanding"],
    ]);
  });

  it("the words: each cell from its rule", () => {
    const text = words(render());
    expect(text).toContain("Price €265.000");
    expect(text).toContain("Availability Available · on the website");
    expect(text).toContain("Owner Andreas Owner");
    expect(text).toContain("Responsible agent Maria Agent");
    expect(text).toContain("Next action Next task: Call the owner · due 21 Oct 2026");
    expect(text).toContain("Mandate Exclusive · expires 12 Jan 2027");
    expect(text).toContain("Outstanding 1 item — see Listing readiness · incl. website essentials");
  });

  it("the links: the owner's contact, the Mandate tab, the readiness panel; one Add task", () => {
    const html = render();
    expect(html).toContain('href="/contacts/c1"');
    expect(html).toContain(`href="/properties/${ROW.id}?tab=mandate"`);
    expect(html).toContain('href="#listing-readiness"');
    expect(html.match(/Add task/g)).toHaveLength(1);
    const viewingFirst = render({ nextTask: null });
    expect(viewingFirst).toContain('href="/viewings/v1"');
  });

  it("only the fields it is about: no net price, floor price, notes or listing title", () => {
    const html = render();
    for (const secret of ["199123", "199.123", "233777", "233.777", "quick offer", "Sea-view"]) {
      expect(html, secret).not.toContain(secret);
    }
  });
});
