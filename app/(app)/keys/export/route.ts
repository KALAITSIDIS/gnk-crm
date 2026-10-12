import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { auditFilters, logListExport, vet } from "@/lib/services/export-audit";
import { KEY_SCOPES } from "@/lib/validators/keys";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { KEY_EXPORT_SELECT, keyCsvColumns, type KeyExportRow } from "@/lib/services/key-export";
import {
  applyKeyListFilters,
  parseKeyFilters,
  withKeySearchEmbed,
  type KeySearchParams,
} from "@/lib/queries/keys-list";
import { exportInvalid, readExportRows } from "@/lib/services/export-read";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // every value of a repeated parameter, so `parseKeyFilters` reads the FIRST —
  // as the page does (Object.fromEntries kept the last: a URL the page refused
  // exported another search). T-keys-search-length
  const params = request.nextUrl.searchParams;
  const sp: KeySearchParams = Object.fromEntries([...new Set(params.keys())].map((k) => [k, params.getAll(k)]));
  // a search the register would refuse is refused here too, before any key is
  // read: never the unfiltered register as this search's file
  const { filters, refusal } = parseKeyFilters(sp);
  if (!filters) return exportInvalid(refusal);

  // the list page's search, reference included, in every page request
  const read = await readExportRows(
    (from, to) =>
      applyKeyListFilters(supabase.from("property_keys").select(withKeySearchEmbed(KEY_EXPORT_SELECT, filters)), filters)
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to),
    "keys",
  );
  if ("refused" in read) return read.refused;
  const rows = read.rows as unknown as KeyExportRow[];

  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "keys",
    count: rows.length,
    // q searches the holder's name: recorded as used, never as typed
    filters: auditFilters(filters, { status: vet.oneOf(KEY_SCOPES) }),
  });

  const csv = toCsv(keyCsvColumns(), rows);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename("keys")}"`,
      "Cache-Control": "no-store",
    },
  });
}
