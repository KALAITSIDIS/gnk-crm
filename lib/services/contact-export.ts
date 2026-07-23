import { type CsvColumn } from "./csv";
import { formatPhone } from "./phone";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Column mapping for the contacts CSV export (IMPROVEMENTS B10). Kept out of the
 * route handler so it is unit-testable without a request or database: the route
 * only wires this to an RLS-scoped query. Columns are a superset of the on-screen
 * table — a CSV is where the detail the cramped table omits belongs.
 */

/** PostgREST select list backing `ContactExportRow`; shared with the route. */
export const CONTACT_EXPORT_SELECT =
  "display_name, contact_kind, phone_e164, email, contact_types, temperature, source, nationality, languages, assigned_agent_id, created_at";

export interface ContactExportRow {
  display_name: string | null;
  contact_kind: string | null;
  phone_e164: string | null;
  email: string | null;
  contact_types: string[] | null;
  temperature: string | null;
  source: string | null;
  nationality: string | null;
  languages: string[] | null;
  assigned_agent_id: string | null;
  created_at: string | null;
}

/**
 * `agentName` resolves an assigned agent id to a display name, and must already
 * carry the "(inactive)" suffix for deactivated agents — the caller builds it
 * the same way the list page does, so an inactive agent's contacts never export
 * as unassigned.
 */
export function contactCsvColumns(
  agentName: Map<string, string>,
): CsvColumn<ContactExportRow>[] {
  return [
    { header: "Name", value: (c) => c.display_name },
    { header: "Kind", value: (c) => c.contact_kind },
    { header: "Phone", value: (c) => (c.phone_e164 ? formatPhone(c.phone_e164) : "") },
    { header: "Email", value: (c) => c.email },
    {
      header: "Types",
      value: (c) => (c.contact_types ?? []).map((t) => t.replace(/_/g, " ")).join("; "),
    },
    { header: "Temperature", value: (c) => c.temperature },
    { header: "Source", value: (c) => c.source },
    { header: "Nationality", value: (c) => c.nationality },
    { header: "Languages", value: (c) => (c.languages ?? []).join("; ") },
    {
      header: "Agent",
      value: (c) => (c.assigned_agent_id ? (agentName.get(c.assigned_agent_id) ?? "") : ""),
    },
    { header: "Added", value: (c) => formatDateTime(c.created_at) },
  ];
}
