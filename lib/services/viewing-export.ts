import { type CsvColumn } from "./csv";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Column mapping for the viewings CSV export (IMPROVEMENTS B10). Pure and
 * unit-testable. The viewings screen is a calendar with no user filters — it
 * shows a bounded time window for display only — so the export deliberately
 * covers EVERY viewing (all time): past viewings and their signed slips are
 * exactly what commission reporting needs. The slip columns are RLS-scoped, so
 * an agent only sees slips they are allowed to.
 */

export const VIEWING_EXPORT_SELECT =
  "scheduled_at, status, duration_min, route_date, properties(reference), contacts(display_name), agent:profiles!agent_id(full_name), viewing_slips(signer_name, signed_at)";

export interface ViewingExportRow {
  scheduled_at: string | null;
  status: string | null;
  duration_min: number | null;
  route_date: string | null;
  properties: { reference: string | null } | null;
  contacts: { display_name: string | null } | null;
  agent: { full_name: string | null } | null;
  viewing_slips: { signer_name: string | null; signed_at: string | null }[] | null;
}

export function viewingCsvColumns(): CsvColumn<ViewingExportRow>[] {
  return [
    { header: "Scheduled", value: (v) => formatDateTime(v.scheduled_at) },
    { header: "Status", value: (v) => v.status },
    { header: "Duration (min)", value: (v) => (v.duration_min === null ? "" : String(v.duration_min)) },
    { header: "Property", value: (v) => v.properties?.reference ?? "" },
    { header: "Attendee", value: (v) => v.contacts?.display_name ?? "" },
    { header: "Agent", value: (v) => v.agent?.full_name ?? "" },
    { header: "Signed by", value: (v) => v.viewing_slips?.[0]?.signer_name ?? "" },
    {
      header: "Signed at",
      value: (v) => (v.viewing_slips?.[0]?.signed_at ? formatDateTime(v.viewing_slips[0].signed_at) : ""),
    },
    { header: "Route date", value: (v) => v.route_date },
  ];
}
