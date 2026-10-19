import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mapsLinkName, PropertyMapList } from "@/components/features/properties/map-fallback";
import { toGeoJson, type MappableProperty } from "@/lib/services/property-map";

/**
 * The map page's list names each Google Maps link for a screen reader (F08
 * review).
 *
 * The link's extra words sat in an `sr-only` span. Tailwind's sr-only is
 * `position: absolute`, which makes the span display:block, and accessible
 * name computation pads a non-inline child with spaces — so the link was named
 * "Open in Google Maps : REF (opens in a new tab)", and the e2e that looked it
 * up by "Open in Google Maps: REF" matched nothing. The whole name now sits on
 * the anchor, starting with the visible text.
 */

const property = (over: Partial<MappableProperty>): MappableProperty => ({
  id: "p1",
  reference: "PAF-0001",
  location: { lat: 34.82, lng: 32.39 },
  areaCentroid: null,
  districtCentroid: null,
  title: "Sea view flat",
  price: 350000,
  isRent: false,
  thumbPath: null,
  ...over,
});

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("PropertyMapList — the Google Maps links' names (F08 review)", () => {
  const html = renderToStaticMarkup(
    createElement(PropertyMapList, {
      features: toGeoJson([
        property({}),
        property({ id: "p2", reference: "PAF-0002", location: null, areaCentroid: { lat: 34.9, lng: 32.3 } }),
      ]).features,
    }),
  );
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].filter(([, attrs]) =>
    attrs.includes('target="_blank"'),
  );

  it("every row's link carries its whole name on the anchor: the visible text, the reference, the new tab", () => {
    expect(anchors).toHaveLength(2);
    const names = anchors.map(([, attrs]) => decode(/aria-label="([^"]*)"/.exec(attrs)?.[1] ?? ""));
    expect(names).toEqual([
      "Open in Google Maps: PAF-0001 (opens in a new tab)",
      "Open in Google Maps: PAF-0002 (opens in a new tab)",
    ]);
    expect(names[0]).toBe(mapsLinkName("PAF-0001"));
  });

  it("no visually hidden text inside the link to be padded into the name", () => {
    for (const [, , inner] of anchors) {
      expect(inner).not.toMatch(/sr-only/);
      // the visible text is what the name starts with (label in name)
      expect(inner.replace(/<[^>]*>/g, "").trim()).toBe("Open in Google Maps");
    }
  });

  it("the link still opens a new tab without sending the CRM URL as the Referer", () => {
    for (const [, attrs] of anchors) {
      expect(attrs).toMatch(/rel="noopener noreferrer"/);
    }
  });
});
