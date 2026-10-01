import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { auditFilters, logListExport, vet } from "@/lib/services/export-audit";
import {
  CONTACT_LANGUAGES,
  CONTACT_TYPES,
  LEAD_SOURCES,
  TEMPERATURES,
} from "@/lib/validators/contacts";
import { toCsv, csvFilename } from "@/lib/services/csv";
import {
  CONTACT_EXPORT_SELECT,
  contactCsvColumns,
  type ContactExportRow,
} from "@/lib/services/contact-export";
import {
  applyContactListFilters,
  parseContactListFilters,
} from "@/lib/queries/contacts-list";

// A generous ceiling so an export is never silently truncated at the list's
// page size, while still bounding the work (PERF-2: unbounded reads are a DoS
// on themselves). Well above any realistic single-desk contact book; revisit
// with streaming if a client ever approaches it.
const EXPORT_CAP = 10_000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // URLSearchParams.entries() yields string pairs, so this is Record<string,string>
  // — assignable to ContactSearchParams for parsing. It is NOT what the audit
  // record holds: the search box (`q`) matches names, phones and e-mails, so
  // the record gets the parsed filters' shape (auditFilters).
  const sp: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filters = parseContactListFilters(sp);

  // Names for the Agent column, including deactivated agents so their contacts
  // don't export as unassigned — mirrors the list page exactly.
  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id, full_name, is_active")
    .order("full_name");
  const agentName = new Map(
    (profileRows ?? []).map((p) => [p.id, p.is_active ? p.full_name : `${p.full_name} (inactive)`]),
  );

  const base = supabase.from("contacts").select(CONTACT_EXPORT_SELECT);
  const { data, error } = await applyContactListFilters(base, filters)
    .order("created_at", { ascending: false })
    .range(0, EXPORT_CAP - 1);

  if (error) {
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }

  const rows = (data ?? []) as ContactExportRow[];

  // Audit the export BEFORE handing over the CSV — no PII leaves without a
  // record of who took it. logListExport throws on failure, which 500s the GET.
  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "contacts",
    count: rows.length,
    // nationality is a free-text input and q the search box: recorded as used,
    // never as typed (T-export-filter-shape)
    filters: auditFilters(filters, {
      type: vet.oneOf(CONTACT_TYPES),
      temperature: vet.oneOf(TEMPERATURES),
      source: vet.oneOf(LEAD_SOURCES),
      agent: vet.uuid,
      language: vet.oneOf(CONTACT_LANGUAGES),
      archived: vet.flag,
    }),
  });

  const csv = toCsv(contactCsvColumns(agentName), rows);
  const filename = csvFilename(filters.archived ? "contacts-archived" : "contacts");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
