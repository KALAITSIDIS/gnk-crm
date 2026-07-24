import { type CsvColumn } from "./csv";
import { formatPhone } from "./phone";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Column mapping for the leads CSV export (IMPROVEMENTS B10). Pure and
 * unit-testable; the route wires it to an RLS-scoped query. `agentName` resolves
 * the assigned agent (with the "(inactive)" suffix), built by the caller the same
 * way the inbox does.
 */

export const LEAD_EXPORT_SELECT =
  "received_at, status, source, channel, message, first_response_at, lost_reason, assigned_agent_id, contacts(display_name, phone_e164), properties(reference)";

export interface LeadExportRow {
  received_at: string | null;
  status: string | null;
  source: string | null;
  channel: string | null;
  message: string | null;
  first_response_at: string | null;
  lost_reason: string | null;
  assigned_agent_id: string | null;
  contacts: { display_name: string | null; phone_e164: string | null } | null;
  properties: { reference: string | null } | null;
}

export function leadCsvColumns(agentName: Map<string, string>): CsvColumn<LeadExportRow>[] {
  return [
    { header: "Received", value: (l) => formatDateTime(l.received_at) },
    { header: "Status", value: (l) => l.status },
    { header: "Source", value: (l) => l.source },
    { header: "Channel", value: (l) => l.channel },
    { header: "Contact", value: (l) => l.contacts?.display_name ?? "" },
    { header: "Phone", value: (l) => (l.contacts?.phone_e164 ? formatPhone(l.contacts.phone_e164) : "") },
    { header: "Property", value: (l) => l.properties?.reference ?? "" },
    { header: "Message", value: (l) => l.message },
    { header: "First response", value: (l) => (l.first_response_at ? formatDateTime(l.first_response_at) : "") },
    { header: "Agent", value: (l) => (l.assigned_agent_id ? (agentName.get(l.assigned_agent_id) ?? "") : "") },
    { header: "Lost reason", value: (l) => l.lost_reason },
  ];
}
