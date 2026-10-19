import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VatConfigRow } from "@/lib/services/vat";

// the form's actions and hooks, outside a Next app: rendering needs neither
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/actions/properties", () => ({ updatePropertySection: vi.fn() }));
vi.mock("@/lib/actions/geo", () => ({ fetchLocationFallback: vi.fn(), resolveMapsShortLink: vi.fn() }));

const { DetailsForm } = await import("@/components/features/properties/detail-forms");

/**
 * F01: the Details tab's VAT panel, rendered the way the server renders it.
 * An unknown status gets figures framed as a scenario ("if it applies", an
 * amber note) and a link to the transfer fees for the same property; the
 * reduced rate is never offered for a non-dwelling; a development is judged
 * by its units, so its own type does not gate it.
 */
const CONFIG: VatConfigRow = {
  standard_rate: 0.19,
  reduced_rate: 0.05,
  reduced_rules_post_2023: {
    applies_to: "first primary residence, new property",
    reduced_area_cap_sqm: 130,
    reduced_value_cap_eur: 350000,
    max_total_area_sqm: 190,
    max_total_value_eur: 475000,
    disability_area_cap_sqm: 190,
  },
};

const markup = (property: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(DetailsForm, {
      property: {
        id: "prop-1",
        kind: "standalone",
        property_type: "apartment",
        status: "available",
        visibility: "private",
        transaction_type: "sale",
        vat_status: "unknown",
        asking_price: 300000,
        covered_area_sqm: 100,
        features: [],
        updated_at: "2026-10-18T09:00:00.000000+00:00",
        ...property,
      },
      areas: [],
      vatConfig: CONFIG,
      vatConfigVerifiedAt: "2026-08-27",
    }),
  );

/** the amber note, if the panel rendered one */
const note = (html: string) => html.match(/<div role="note"[\s\S]*?<\/div><\/div>/)?.[0] ?? null;

describe("the Details VAT panel — unknown is a scenario (F01)", () => {
  it("unknown land at €200,000: the note, the labels, one 19% band, and the way to transfer fees", () => {
    const html = markup({
      property_type: "land",
      vat_status: "unknown",
      asking_price: 200000,
      covered_area_sqm: null,
    });
    const n = note(html);
    expect(n, "an amber note above the figures").not.toBeNull();
    expect(n).toContain("VAT status: Unknown — not confirmed");
    expect(n).toContain("nothing here confirms that it does, or that it has been paid");
    expect(html).toContain("VAT (if it applies)");
    expect(html).toContain("Price including VAT (if it applies)");
    expect(html).toContain("€200.000 at 19%");
    expect(html).not.toContain(" at 5%");
    expect(html).toContain("not available for land");
    expect(html).toContain('href="/calculators?price=200000&amp;property=prop-1"');
    expect(html).toContain("Transfer fees for this price");
  });

  it("a confirmed new build: no note, no qualifier, no transfer-fee link — and the reduced band", () => {
    const html = markup({ vat_status: "new_vat" });
    expect(note(html)).toBeNull();
    expect(html).not.toContain("(if it applies)");
    expect(html).not.toContain("Transfer fees for this price");
    expect(html).toContain("€300.000 at 5%");
    expect(html).toContain("VAT thresholds verified 27 Aug 2026.");
  });

  it("a resale: no figures, no note, and the transfer-fee link", () => {
    const html = markup({ vat_status: "resale_no_vat" });
    expect(note(html)).toBeNull();
    expect(html).toContain("Transfer fees apply instead");
    expect(html).toContain('href="/calculators?price=300000&amp;property=prop-1"');
  });

  it("a development is judged by its units: its own type does not gate the rate", () => {
    const html = markup({ kind: "project", property_type: "building", vat_status: "new_vat" });
    expect(html).toContain("€300.000 at 5%");
    expect(html).not.toContain("not available for");
  });

  it("the same type on a standalone listing is refused the rate", () => {
    const html = markup({ property_type: "building", vat_status: "new_vat" });
    expect(html).toContain("not available for building");
    expect(html).not.toContain(" at 5%");
  });

  it("no asking price: the link still opens the calculators on the property, with no price", () => {
    const html = markup({ vat_status: "unknown", asking_price: null });
    expect(html).toContain('href="/calculators?property=prop-1"');
  });
});
