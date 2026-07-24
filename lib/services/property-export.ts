import { type CsvColumn } from "./csv";

/**
 * Column mapping for the properties CSV export (IMPROVEMENTS B10). Pure and
 * unit-testable; the route wires it to an RLS-scoped query. The mandate part of
 * the SELECT is dynamic (inner-joined when filtering by mandate), so it is
 * appended by the caller — see `mandateEmbed` in `lib/queries/properties-list.ts`.
 *
 * Money and area values are written as raw numbers, not formatted currency, so a
 * spreadsheet can sum them. A missing value is an empty cell, never "0".
 */

/** SELECT columns excluding the dynamic mandate embed the route appends. */
export const PROPERTY_EXPORT_BASE_SELECT =
  "reference, property_type, transaction_type, status, visibility, title, address, bedrooms, bathrooms, covered_area_sqm, plot_area_sqm, asking_price, rent_price_month, quality_score, districts(name), areas(name)";

type Multilang = { en?: string } | null;
type MandateEmbedRow = { type: string; status: string };

export interface PropertyExportRow {
  reference: string | null;
  property_type: string | null;
  transaction_type: string | null;
  status: string | null;
  visibility: string | null;
  title: Multilang;
  address: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  covered_area_sqm: number | string | null;
  plot_area_sqm: number | string | null;
  asking_price: number | string | null;
  rent_price_month: number | string | null;
  quality_score: number | null;
  districts: { name?: Multilang } | null;
  areas: { name?: Multilang } | null;
  mandates: MandateEmbedRow[] | null;
}

const en = (m: Multilang | undefined): string => (m?.en ?? "").trim();
const num = (v: number | string | null): string => (v === null || v === "" ? "" : String(v));

/** Mandate badge state, same rule as the list page: active wins, else expired, else none. */
function mandateState(mandates: MandateEmbedRow[] | null): string {
  const list = mandates ?? [];
  const active = list.find((m) => m.status === "active");
  if (active) return active.type;
  if (list.some((m) => m.status === "expired")) return "expired";
  return "none";
}

export function propertyCsvColumns(): CsvColumn<PropertyExportRow>[] {
  return [
    { header: "Reference", value: (p) => p.reference },
    { header: "Type", value: (p) => p.property_type },
    { header: "Transaction", value: (p) => p.transaction_type },
    { header: "Status", value: (p) => p.status },
    { header: "Visibility", value: (p) => p.visibility },
    { header: "Title", value: (p) => en(p.title) },
    { header: "District", value: (p) => en(p.districts?.name) },
    { header: "Area", value: (p) => en(p.areas?.name) },
    { header: "Address", value: (p) => p.address },
    { header: "Bedrooms", value: (p) => (p.bedrooms === null ? "" : String(p.bedrooms)) },
    { header: "Bathrooms", value: (p) => (p.bathrooms === null ? "" : String(p.bathrooms)) },
    { header: "Covered m²", value: (p) => num(p.covered_area_sqm) },
    { header: "Plot m²", value: (p) => num(p.plot_area_sqm) },
    { header: "Asking price", value: (p) => num(p.asking_price) },
    { header: "Rent/month", value: (p) => num(p.rent_price_month) },
    { header: "Mandate", value: (p) => mandateState(p.mandates) },
    { header: "Quality", value: (p) => (p.quality_score === null ? "" : String(p.quality_score)) },
  ];
}
