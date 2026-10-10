import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { auditFilters, logListExport, vet } from "@/lib/services/export-audit";
import { KEY_SCOPES } from "@/lib/validators/keys";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { KEY_EXPORT_SELECT, keyCsvColumns, type KeyExportRow } from "@/lib/services/key-export";
import {
  applyKeyListFilters,
  fetchKeyMatchedPropertyIds,
  parseKeyFilters,
} from "@/lib/queries/keys-list";
import { exportFailed, readExportRows } from "@/lib/services/export-read";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const sp: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filters = parseKeyFilters(sp);

  // a failed reference lookup would silently drop the keys it should find
  const matchedPropertyIds = await fetchKeyMatchedPropertyIds(supabase, filters).catch(() => null);
  if (!matchedPropertyIds) return exportFailed();
  const read = await readExportRows(
    (from, to) =>
      applyKeyListFilters(supabase.from("property_keys").select(KEY_EXPORT_SELECT), filters, matchedPropertyIds)
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
