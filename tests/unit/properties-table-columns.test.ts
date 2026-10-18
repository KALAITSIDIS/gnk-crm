import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  priceCell,
  PropertiesCards,
  PropertiesTable,
  type PropertyRow,
} from "@/components/features/properties/list";

/**
 * The properties table as the server renders it (A03 review).
 *
 * 1. Nothing a column shows is lost below the width that shows the column. The
 *    priority split hid Score and Visibility below 1680 px with no stand-in, so
 *    on a 1280–1600 px laptop nobody could see whether a listing was public, and
 *    the list could be sorted by a score that was not on screen. Now those two
 *    are columns from 2xl (1536 px) and, below it, the FIRST things on the
 *    title cell's second line — truncation takes the end of a line, not them.
 * 2. Under "Rent" the Price column shows the figure the list is sorted and
 *    bracketed by: the monthly rent, a sale_or_rent row's included. It showed
 *    a sale_or_rent row's asking price between two rents.
 */

const row = (over: Partial<PropertyRow> & { id: string; reference: string }): PropertyRow => ({
  kind: "standalone",
  property_type: "apartment",
  transaction_type: "sale",
  status: "available",
  visibility: "public",
  title: "Sea view flat",
  district: "Paphos",
  area: "Peyia",
  bedrooms: 2,
  covered_area_sqm: 90,
  plot_area_sqm: null,
  building_density_pct: null,
  asking_price: 350000,
  rent_price_month: null,
  quality_score: 72,
  mandate: "none",
  thumb: null,
  ...over,
});

const table = (rows: PropertyRow[], props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PropertiesTable, { rows, ...props }));

/** The class list of the element whose text content starts with `text`. */
function classOfHeader(html: string, text: string): string | null {
  const m = new RegExp(`<th[^>]*class="([^"]*)"[^>]*>(?:<[^>]+>)*${text}`).exec(html);
  return m ? m[1] : null;
}

describe("the table's columns by width (A03 review)", () => {
  it("Score and Visibility are columns from 2xl (1536 px), not only from 1680 px", () => {
    const html = table([row({ id: "a", reference: "PAF0001" })]);
    for (const header of ["Score", "Visibility"]) {
      const cls = classOfHeader(html, header);
      expect(cls, `${header} header`).not.toBeNull();
      expect(cls).toMatch(/\bhidden\b/);
      expect(cls).toMatch(/\b2xl:table-cell\b/);
      expect(cls).not.toMatch(/min-\[1680px\]:table-cell/);
    }
    // photo and type stay at 1680 px: at 1536 they do not fit beside the rest
    expect(classOfHeader(html, "Type")).toMatch(/min-\[1680px\]:table-cell/);
  });

  it("below 2xl the title cell's second line carries the visibility and the score, first", () => {
    const html = table([row({ id: "a", reference: "PAF0001", visibility: "vip", quality_score: 41 })]);
    // the truncating second line of the title cell
    const line = /<div class="truncate text-xs text-text-3 min-\[1680px\]:hidden">([\s\S]*?)<\/div>/.exec(html);
    expect(line, "the title cell's second line").not.toBeNull();
    // it OPENS with the stand-in, which only the 2xl columns replace
    expect(line![1].startsWith('<span class="2xl:hidden" data-testid="property-row-standing">')).toBe(true);
    // first on the line, so truncation takes the end of it, never these two
    expect(line![1].replace(/<[^>]*>/g, "")).toMatch(/^VIP · Score 41 · Apartment/);
  });
});

describe("the price shown is the price the list reads (A03 review)", () => {
  const saleOrRent = row({
    id: "b",
    reference: "PAF0002",
    transaction_type: "sale_or_rent",
    asking_price: 350000,
    rent_price_month: 1200,
  });
  const rental = row({ id: "c", reference: "PAF0003", transaction_type: "rent", asking_price: null, rent_price_month: 900 });
  const noRent = row({ id: "d", reference: "PAF0004", transaction_type: "sale_or_rent", rent_price_month: null });

  it("under Rent, a sale_or_rent row shows its monthly rent — the sort key — not its asking price", () => {
    expect(priceCell(saleOrRent, true)).toBe(priceCell(row({ id: "x", reference: "X", transaction_type: "rent", rent_price_month: 1200 })));
    expect(priceCell(saleOrRent, true)).toMatch(/\/mo$/);
    expect(priceCell(rental, true)).toMatch(/\/mo$/);
    // placed LAST by a rent sort (nulls last): it shows no rent, not its asking price
    expect(priceCell(noRent, true)).toBe("—");
  });

  it("without the Rent filter nothing changes: sale_or_rent shows its asking price, a rental its rent", () => {
    expect(priceCell(saleOrRent)).not.toMatch(/\/mo$/);
    expect(priceCell(rental)).toMatch(/\/mo$/);
  });

  it("the table and the cards both take the context", () => {
    const rentTable = table([saleOrRent], { rent: true });
    const saleTable = table([saleOrRent]);
    expect(rentTable).toContain(priceCell(saleOrRent, true));
    expect(rentTable).not.toContain(priceCell(saleOrRent));
    expect(saleTable).toContain(priceCell(saleOrRent));

    const rentCards = renderToStaticMarkup(createElement(PropertiesCards, { rows: [saleOrRent], rent: true }));
    expect(rentCards).toContain(priceCell(saleOrRent, true));
    expect(rentCards).not.toContain(priceCell(saleOrRent));
  });
});
