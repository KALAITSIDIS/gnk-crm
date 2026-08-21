import { type CsvColumn } from "./csv";
import { parseLocationPoint } from "@/lib/utils/geo";

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
  "reference, kind, property_type, transaction_type, status, visibility, title, address, bedrooms, bathrooms, covered_area_sqm, plot_area_sqm, asking_price, rent_price_month, quality_score, title_deed_status, permit_status, location, districts(name), areas(name), owner:contacts!owner_contact_id(display_name), developer:contacts!developer_contact_id(display_name), agent:profiles!assigned_agent_id(full_name)";

type Multilang = { en?: string } | null;
type MandateEmbedRow = { type: string; status: string };

export interface PropertyExportRow {
  reference: string | null;
  kind: string | null;
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
  title_deed_status: string | null;
  permit_status: string | null;
  /** PostGIS point, EWKB hex from the API — decoded for the CSV */
  location: unknown;
  districts: { name?: Multilang } | null;
  areas: { name?: Multilang } | null;
  owner: { display_name: string | null } | null;
  developer: { display_name: string | null } | null;
  agent: { full_name: string | null } | null;
  mandates: MandateEmbedRow[] | null;
}

const en = (m: Multilang | undefined): string => (m?.en ?? "").trim();
const num = (v: number | string | null): string => (v === null || v === "" ? "" : String(v));

/** One half of the map point, or "" when the property has no coordinates. */
function coord(location: unknown, part: "lat" | "lng"): string {
  const point = parseLocationPoint(location);
  return point === null ? "" : String(point[part]);
}

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
    // the list hides units by default, so the CSV has to say which it holds
    { header: "Kind", value: (p) => p.kind },
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
    // audit finding 14: an export that cannot be grouped by developer, or sent
    // to the agent who owns the listing, is not much use in either conversation
    { header: "Owner", value: (p) => p.owner?.display_name ?? "" },
    { header: "Developer", value: (p) => p.developer?.display_name ?? "" },
    { header: "Agent", value: (p) => p.agent?.full_name ?? "" },
    { header: "Title deed", value: (p) => p.title_deed_status },
    { header: "Permit", value: (p) => p.permit_status },
    // split, so a spreadsheet can plot them without anyone parsing a string
    { header: "Latitude", value: (p) => coord(p.location, "lat") },
    { header: "Longitude", value: (p) => coord(p.location, "lng") },
    { header: "Quality", value: (p) => (p.quality_score === null ? "" : String(p.quality_score)) },
  ];
}
