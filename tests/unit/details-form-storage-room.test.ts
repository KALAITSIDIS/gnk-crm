import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the form's actions and hooks, outside a Next app: rendering needs neither
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/actions/properties", () => ({ updatePropertySection: vi.fn() }));
vi.mock("@/lib/actions/geo", () => ({ fetchLocationFallback: vi.fn(), resolveMapsShortLink: vi.fn() }));

const { DetailsForm } = await import("@/components/features/properties/detail-forms");

/**
 * F02: the Details tab shows ONE "Storage room" control — the Features box,
 * which posts `features=storage_room` — and no `has_storage` field. It used to
 * show two under the same label (an "Areas & rooms" box bound to the
 * has_storage column, and the Features box), saved independently, and they
 * drifted. Rendered the way the server renders it.
 */
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
        updated_at: "2026-10-18T09:00:00.000000+00:00",
        ...property,
      },
      areas: [],
    }),
  );

/** The one label holding the Storage room box: its whole markup. */
function storageLabels(html: string): string[] {
  return [...html.matchAll(/<label\b(?:(?!<\/label>)[\s\S])*<\/label>/g)]
    .map((m) => m[0])
    .filter((l) => l.includes("Storage room"));
}

describe("the Details form's storage room", () => {
  it("has exactly one control labelled 'Storage room' — the Features box, posting features=storage_room — and no has_storage field", () => {
    const html = markup({ features: ["storage_room"], has_storage: true });
    expect(html.match(/Storage room/g)).toHaveLength(1);
    expect(html).not.toContain("has_storage");
    const labels = storageLabels(html);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/role="checkbox"/);
    expect(labels[0]).toMatch(/value="storage_room"/);
    expect(labels[0]).toMatch(/aria-checked="true"/);
  });

  it("shows the feature, never the column: a row written before 0152 with the column set and the feature absent renders unticked", () => {
    const [label] = storageLabels(markup({ features: ["sea_view"], has_storage: true }));
    expect(label).toMatch(/aria-checked="false"/);
  });
});
