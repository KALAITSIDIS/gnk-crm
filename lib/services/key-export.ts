import { type CsvColumn } from "./csv";

/**
 * Column mapping for the keys register CSV export (IMPROVEMENTS B10). Pure and
 * unit-testable; the route wires it to an RLS-scoped query.
 */

export const KEY_EXPORT_SELECT =
  "key_code, description, status, current_holder_name, properties(reference)";

export interface KeyExportRow {
  key_code: string | null;
  description: string | null;
  status: string | null;
  current_holder_name: string | null;
  properties: { reference: string | null } | null;
}

export function keyCsvColumns(): CsvColumn<KeyExportRow>[] {
  return [
    { header: "Key code", value: (k) => k.key_code },
    { header: "Property", value: (k) => k.properties?.reference ?? "" },
    { header: "Description", value: (k) => k.description },
    { header: "Status", value: (k) => k.status },
    { header: "Holder", value: (k) => k.current_holder_name },
  ];
}
