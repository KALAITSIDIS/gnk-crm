import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { auditFilters, logListExport, vet } from "@/lib/services/export-audit";
import {
  MANDATE_FILTERS,
  PROPERTY_KIND_FILTERS,
  PROPERTY_SCOPES,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
  VISIBILITY_LEVELS,
  type PropertyFilterKey,
} from "@/lib/validators/properties";
import { toCsv, csvFilename } from "@/lib/services/csv";
import {
  PROPERTY_EXPORT_BASE_SELECT,
  propertyCsvColumns,
  type PropertyExportRow,
} from "@/lib/services/property-export";
import {
  applyPropertyListFilters,
  applyPropertyListOrder,
  mandateEmbed,
  parsePropertyFilters,
} from "@/lib/queries/properties-list";
import { readExportRows } from "@/lib/services/export-read";

/**
 * How each filter is recorded on the export's audit line
 * (T-export-filter-shape): a value passing its check is kept, anything else
 * that was set is recorded only as used.
 *
 * EVERY filter but the search is named here, and the type makes it so (A03):
 * `FilterVetting` is a Partial, so a filter added to the list and forgotten
 * here used to be recorded silently as `true` — the plot and density bounds
 * would have reached the chain as "used" rather than as the numbers they are.
 * `q` is deliberately absent: the search matches a title or an address and is
 * only ever recorded as used.
 */
const VETTING = {
  district: vet.uuid,
  area: vet.uuid,
  type: vet.oneOf(PROPERTY_TYPES),
  transaction: vet.oneOf(TRANSACTION_TYPES),
  status: vet.oneOf(PROPERTY_STATUSES),
  visibility: vet.oneOf(VISIBILITY_LEVELS),
  beds: vet.number,
  price_min: vet.number,
  price_max: vet.number,
  plot_min: vet.number,
  plot_max: vet.number,
  density_min: vet.number,
  mandate: vet.oneOf(MANDATE_FILTERS),
  kind: vet.oneOf(PROPERTY_KIND_FILTERS),
  scope: vet.oneOf(PROPERTY_SCOPES),
} satisfies Record<Exclude<PropertyFilterKey, "q">, (value: unknown) => boolean>;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const sp: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filters = parsePropertyFilters(sp);

  // The same embeds, filters and ORDER the list page applies, so the export
  // selects exactly the rows the filtered list shows, in the order it shows
  // them — the mandate filters included, in each page request
  // (T-mandate-filter-anti-join), and the list's sort (A03).
  const read = await readExportRows(
    (from, to) =>
      applyPropertyListOrder(
        applyPropertyListFilters(
          supabase.from("properties").select(`${PROPERTY_EXPORT_BASE_SELECT}, ${mandateEmbed(filters)}`),
          filters,
        ),
        filters,
      ).range(from, to),
    "properties",
  );
  if ("refused" in read) return read.refused;
  const rows = read.rows as unknown as PropertyExportRow[];

  // Audit BEFORE returning the CSV — no PII leaves without a record (fail-closed).
  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "properties",
    count: rows.length,
    // q (reference, title, owner) recorded as used, never as typed; view,
    // sort and page are how the list was shown, not which rows it held
    filters: auditFilters({ ...filters, view: undefined, sort: undefined, page: undefined }, VETTING),
  });

  const csv = toCsv(propertyCsvColumns(), rows);
  const filename = csvFilename(filters.scope === "archived" ? "properties-archived" : "properties");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
