import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PROPERTIES_LIST_CONTEXT_KEY } from "@/lib/constants/list-context";
import { assessLineage, type LineageNode } from "@/lib/services/property-lineage";
import { describeHold } from "@/lib/queries/container-availability";

// the matrix's actions and router, outside a Next app: rendering needs neither
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/actions/units", () => ({
  createPaymentPlan: vi.fn(),
  createPriceListVersion: vi.fn(),
  createUnit: vi.fn(),
  updateUnitStatus: vi.fn(),
}));

const { BackToListLink, rememberedListHref } = await import("@/components/features/properties/back-to-list-link");
const { PropertyBreadcrumb } = await import("@/components/features/properties/property-breadcrumb");
const { AvailabilityOverview } = await import("@/components/features/properties/availability-overview");
const { UnitsMatrix } = await import("@/components/features/properties/units-matrix");

/**
 * A05 as the server renders it: the breadcrumb (with its anomalies), the first
 * crumb's remembered list view, the Hold column and the row anchor, and the
 * read-only availability across phases.
 */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const node = (over: Partial<LineageNode> & Pick<LineageNode, "id" | "kind" | "reference">): LineageNode => ({
  title: null,
  visibility: "private",
  parent_id: null,
  ...over,
});
const PROJECT = node({ id: "proj-id", kind: "project", reference: "PAF0002", title: "Seafront" });
const PHASE = node({ id: "ph1-id", kind: "phase", reference: "PAF0002-P1", parent_id: "proj-id" });

describe("rememberedListHref — the first crumb", () => {
  const storage = (value: string | null) => ({ getItem: (k: string) => (k === PROPERTIES_LIST_CONTEXT_KEY ? value : null) });

  it("returns the list view this tab last settled on", () => {
    expect(rememberedListHref(storage("/properties?status=available&page=3"))).toBe(
      "/properties?status=available&page=3",
    );
    expect(rememberedListHref(storage("/properties/map?district=x"))).toBe("/properties/map?district=x");
  });

  it("falls back to the bare list for nothing, a foreign value, a throwing storage, or no storage", () => {
    expect(rememberedListHref(storage(null))).toBe("/properties");
    expect(rememberedListHref(storage("https://evil.example/properties"))).toBe("/properties");
    expect(rememberedListHref(storage("//evil.example"))).toBe("/properties");
    expect(rememberedListHref(storage("/contacts"))).toBe("/properties");
    expect(
      rememberedListHref({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toBe("/properties");
    expect(rememberedListHref(undefined)).toBe("/properties");
  });

  it("renders the bare list on the server — the remembered view is the browser's to apply", () => {
    expect(renderToStaticMarkup(createElement(BackToListLink))).toContain('href="/properties"');
  });
});

describe("PropertyBreadcrumb", () => {
  it("a unit under a phase: Properties › project › phase › unit, the last item current", () => {
    const row = { id: "u1", kind: "unit", parent_id: "ph1-id" };
    const lineage = assessLineage(row, { state: "found", node: PHASE }, { state: "found", node: PROJECT });
    const html = renderToStaticMarkup(
      createElement(PropertyBreadcrumb, { lineage, current: { label: "PAF0002-P1-A101", mono: true } }),
    );
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(text(html)).toBe("Properties › PAF0002 Project › PAF0002-P1 Phase › PAF0002-P1-A101");
    expect(html).toContain('href="/properties/proj-id"');
    expect(html).toContain('href="/properties/ph1-id"');
    expect(html).toMatch(/<li aria-current="page"[^>]*>[\s\S]*PAF0002-P1-A101/);
    expect(html).toContain('title="PAF0002 — Seafront"');
  });

  it("a standalone: just Properties › its reference", () => {
    const html = renderToStaticMarkup(
      createElement(PropertyBreadcrumb, {
        lineage: assessLineage({ id: "s", kind: "standalone", parent_id: null }),
        current: { label: "PAF0100", mono: true },
      }),
    );
    expect(text(html)).toBe("Properties › PAF0100");
  });

  it("a units page: the record itself is a crumb and 'Units' is current", () => {
    const html = renderToStaticMarkup(
      createElement(PropertyBreadcrumb, {
        lineage: assessLineage({ id: "ph1-id", kind: "phase", parent_id: "proj-id" }, { state: "found", node: PROJECT }),
        self: { id: "ph1-id", reference: "PAF0002-P1", kind: "phase" },
        current: { label: "Units" },
      }),
    );
    expect(text(html)).toBe("Properties › PAF0002 Project › PAF0002-P1 Phase › Units");
  });

  it("an anomaly is a warning in the trail, and nothing is guessed in its place", () => {
    const standalone = node({ id: "s-id", kind: "standalone", reference: "PAF0100" });
    const wrong = assessLineage({ id: "u1", kind: "unit", parent_id: "s-id" }, { state: "found", node: standalone });
    const html = renderToStaticMarkup(createElement(PropertyBreadcrumb, { lineage: wrong, current: { label: "X" } }));
    expect(html).toContain('data-lineage-issue="unexpected_parent_kind"');
    expect(text(html)).toContain(
      "A unit belongs to a project or a phase, but this one is recorded under PAF0100, a standalone. Tell an admin.",
    );

    const hidden = assessLineage({ id: "u1", kind: "unit", parent_id: "x" }, { state: "absent" });
    const hiddenHtml = renderToStaticMarkup(createElement(PropertyBreadcrumb, { lineage: hidden, current: { label: "X" } }));
    expect(text(hiddenHtml)).toBe(
      "Properties › Its parent record is not visible to you — it may belong to another organisation. Tell an admin. › X",
    );
  });

  it("an archived ancestor says so", () => {
    const lineage = assessLineage(
      { id: "u1", kind: "unit", parent_id: "ph1-id" },
      { state: "found", node: { ...PHASE, visibility: "archived" } },
      { state: "found", node: PROJECT },
    );
    expect(text(renderToStaticMarkup(createElement(PropertyBreadcrumb, { lineage, current: { label: "X" } })))).toContain(
      "PAF0002-P1 Phase · archived",
    );
  });
});

const NOW = new Date("2026-10-19T10:00:00Z");
const liveHold = {
  reservationId: "r1",
  propertyId: "u1",
  status: "held" as const,
  heldFrom: "2026-10-01T09:00:00Z",
  expiresAt: "2026-11-12T09:00:00Z",
  buyer: "Buyer One",
};

describe("UnitsMatrix — the Hold column and the row anchor", () => {
  const unit = (id: string, status: string, hold = describeHold(status, null, NOW)) => ({
    id,
    reference: `REF-${id}`,
    unit_number: "101",
    block: "A",
    property_type: "apartment",
    bedrooms: 2,
    covered_area_sqm: 85,
    asking_price: 250000,
    status,
    floor_number: 1,
    hold,
  });

  it("each row is an anchor the unit page links to; the linked one is marked", () => {
    const html = renderToStaticMarkup(
      createElement(UnitsMatrix, {
        units: [unit("u1", "available"), unit("u2", "available")],
        canManage: false,
        highlightId: "u2",
      }),
    );
    expect(html).toContain('id="unit-u1"');
    expect(html).toMatch(/<tr[^>]*id="unit-u2"[^>]*aria-current="true"/);
    expect(html).not.toMatch(/<tr[^>]*id="unit-u1"[^>]*aria-current/);
  });

  it("shows the live hold, its buyer, and where status and hold disagree", () => {
    const html = renderToStaticMarkup(
      createElement(UnitsMatrix, {
        units: [
          unit("u1", "available", describeHold("available", liveHold, NOW)),
          unit("u2", "reserved"),
          unit("u3", "sold"),
        ],
        canManage: false,
      }),
    );
    const t = text(html);
    expect(t).toContain("Hold");
    expect(t).toContain("Held to 12 Nov 2026 · Buyer One");
    expect(t).toContain("Status still says Available");
    expect(t).toContain("Reserved, but no live hold is recorded");
  });

  it("says what an empty matrix means where it is given words for it", () => {
    const html = renderToStaticMarkup(
      createElement(UnitsMatrix, { units: [], canManage: false, emptyText: "None — this project's units are in its phases (above)." }),
    );
    expect(text(html)).toContain("None — this project's units are in its phases (above).");
    expect(html).toMatch(/colspan="9"/i);
  });
});

describe("AvailabilityOverview — read-only, grouped by phase", () => {
  const u = (id: string, parent_id: string, over: Record<string, unknown> = {}) => {
    const row = {
      id,
      parent_id,
      reference: `R-${id}`,
      unit_number: id,
      block: null,
      property_type: "apartment",
      transaction_type: "sale",
      bedrooms: 2,
      covered_area_sqm: 85,
      asking_price: 250000,
      rent_price_month: null,
      status: "available",
      delivery_date: "2027-06-30",
      ...over,
    };
    return { ...row, hold: describeHold(row.status as string, null, NOW) };
  };

  const render = () =>
    renderToStaticMarkup(
      createElement(AvailabilityOverview, {
        project: { id: "proj-id", reference: "PAF0002", delivery_date: "2028-03-31" },
        phases: [
          { id: "ph2-id", reference: "PAF0002-P2", title: "Phase 2", status: "available", delivery_date: "2029-10-31", construction_status: null },
          { id: "ph1-id", reference: "PAF0002-P1", title: "Phase 1", status: "available", delivery_date: "2027-06-30", construction_status: "structure" },
        ],
        units: [
          u("p2a", "ph2-id", { delivery_date: "2029-10-31" }),
          u("p1a", "ph1-id", { status: "sold" }),
          { ...u("p1b", "ph1-id", { status: "reserved" }), hold: describeHold("reserved", { ...liveHold, propertyId: "p1b" }, NOW) },
          u("d1", "proj-id", { delivery_date: "2028-03-31", transaction_type: "rent", asking_price: null, rent_price_month: 1200 }),
          u("p1c", "ph1-id", { delivery_date: "2027-12-31" }),
        ],
      }),
    );

  it("direct units first, then each phase by reference, each with its OWN delivery date and available count", () => {
    const html = render();
    const groups = [...html.matchAll(/data-phase-group="([^"]+)"/g)].map((m) => m[1]);
    expect(groups).toEqual(["direct", "PAF0002-P1", "PAF0002-P2"]);
    const t = text(html);
    expect(t).toContain("Every unit in PAF0002, by phase — 3 of 5 available.");
    expect(t).toContain("Directly under PAF0002 delivery 31 Mar 2028 1 of 1 available");
    expect(t).toContain("PAF0002-P1 Phase 1 delivery 30 Jun 2027 · structure 1 of 3 available · 1 reserved · 1 sold");
    expect(t).toContain("PAF0002-P2 Phase 2 delivery 31 Oct 2029 1 of 1 available");
    expect(html).toContain('href="/properties/ph1-id/units"');
  });

  it("each unit: size, price (a let unit's rent), status, hold, and a delivery date marked only where it differs", () => {
    const t = text(render());
    expect(t).toContain("R-d1 Apartment 2 85 m² €1.200/mo");
    expect(t).toContain("Held to 12 Nov 2026 · Buyer One");
    expect(t).toContain("31 Dec 2027 differs from the phase");
    expect(t.match(/differs from the/g)).toHaveLength(1);
  });

  it("edits nothing: no status control, no form, no button", () => {
    const html = render();
    expect(html).not.toMatch(/<(form|select|button)\b/);
    expect(html).not.toContain("Status of ");
  });
});
