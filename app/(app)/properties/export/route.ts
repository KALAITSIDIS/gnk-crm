import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { auditFilters, logListExport, vet } from "@/lib/services/export-audit";
import {
  MANDATE_FILTERS,
  PROPERTY_KINDS,
  PROPERTY_SCOPES,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
  VISIBILITY_LEVELS,
} from "@/lib/validators/properties";
import { toCsv, csvFilename } from "@/lib/services/csv";
import {
  PROPERTY_EXPORT_BASE_SELECT,
  propertyCsvColumns,
  type PropertyExportRow,
} from "@/lib/services/property-export";
import {
  applyPropertyListFilters,
  fetchMandateExcludeIds,
  mandateEmbed,
  parsePropertyFilters,
} from "@/lib/queries/properties-list";

// See the contacts export for the rationale; 10k is well above any single desk.
const EXPORT_CAP = 10_000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const sp: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filters = parsePropertyFilters(sp);

  // Same mandate pre-query + embed choice the list page makes, so the export
  // selects exactly the rows the filtered list shows.
  const excludeIds = await fetchMandateExcludeIds(supabase, filters);
  const base = supabase
    .from("properties")
    .select(`${PROPERTY_EXPORT_BASE_SELECT}, ${mandateEmbed(filters)}`);

  const { data, error } = await applyPropertyListFilters(base, filters, excludeIds)
    .order("created_at", { ascending: false })
    .range(0, EXPORT_CAP - 1);

  if (error) {
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as PropertyExportRow[];

  // Audit BEFORE returning the CSV — no PII leaves without a record (fail-closed).
  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "properties",
    count: rows.length,
    // q (reference, title, owner) recorded as used, never as typed; view and
    // page are how the list was shown, not which rows it held
    filters: auditFilters(
      { ...filters, view: undefined, page: undefined },
      {
        district: vet.uuid,
        area: vet.uuid,
        type: vet.oneOf(PROPERTY_TYPES),
        transaction: vet.oneOf(TRANSACTION_TYPES),
        status: vet.oneOf(PROPERTY_STATUSES),
        visibility: vet.oneOf(VISIBILITY_LEVELS),
        beds: vet.number,
        price_min: vet.number,
        price_max: vet.number,
        mandate: vet.oneOf(MANDATE_FILTERS),
        kind: vet.oneOf(PROPERTY_KINDS),
        scope: vet.oneOf(PROPERTY_SCOPES),
      },
    ),
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
