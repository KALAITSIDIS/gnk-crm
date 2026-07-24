import { type CsvColumn } from "./csv";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Column mapping for the deals CSV export (IMPROVEMENTS B10). Pure and
 * unit-testable; the route wires it to an RLS-scoped query. Money is a raw number
 * so a spreadsheet can sum it. Buyer/seller are aliased contact embeds.
 */

export const DEAL_EXPORT_SELECT =
  "title, deal_type, status, expected_value, commission_split_notes, won_at, lost_at, lost_reason, created_at, agent_id, deal_stages(name), properties(reference), buyer:contacts!buyer_contact_id(display_name), seller:contacts!seller_contact_id(display_name)";

export interface DealExportRow {
  title: string | null;
  deal_type: string | null;
  status: string | null;
  expected_value: number | string | null;
  commission_split_notes: string | null;
  won_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  created_at: string | null;
  agent_id: string | null;
  deal_stages: { name: string | null } | null;
  properties: { reference: string | null } | null;
  buyer: { display_name: string | null } | null;
  seller: { display_name: string | null } | null;
}

const num = (v: number | string | null): string => (v === null || v === "" ? "" : String(v));

export function dealCsvColumns(agentName: Map<string, string>): CsvColumn<DealExportRow>[] {
  return [
    { header: "Title", value: (d) => d.title },
    { header: "Type", value: (d) => d.deal_type },
    { header: "Stage", value: (d) => d.deal_stages?.name ?? "" },
    { header: "Status", value: (d) => d.status },
    { header: "Expected value", value: (d) => num(d.expected_value) },
    { header: "Property", value: (d) => d.properties?.reference ?? "" },
    { header: "Buyer", value: (d) => d.buyer?.display_name ?? "" },
    { header: "Seller", value: (d) => d.seller?.display_name ?? "" },
    { header: "Agent", value: (d) => (d.agent_id ? (agentName.get(d.agent_id) ?? "") : "") },
    { header: "Commission notes", value: (d) => d.commission_split_notes },
    { header: "Won", value: (d) => (d.won_at ? formatDateTime(d.won_at) : "") },
    { header: "Lost", value: (d) => (d.lost_at ? formatDateTime(d.lost_at) : "") },
    { header: "Lost reason", value: (d) => d.lost_reason },
    { header: "Created", value: (d) => formatDateTime(d.created_at) },
  ];
}
