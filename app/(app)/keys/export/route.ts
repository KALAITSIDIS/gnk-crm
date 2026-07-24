import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { logListExport } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { KEY_EXPORT_SELECT, keyCsvColumns, type KeyExportRow } from "@/lib/services/key-export";
import {
  applyKeyListFilters,
  fetchKeyMatchedPropertyIds,
  parseKeyFilters,
} from "@/lib/queries/keys-list";

const EXPORT_CAP = 10_000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const sp: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filters = parseKeyFilters(sp);

  const matchedPropertyIds = await fetchKeyMatchedPropertyIds(supabase, filters);
  const base = supabase.from("property_keys").select(KEY_EXPORT_SELECT);

  const { data, error } = await applyKeyListFilters(base, filters, matchedPropertyIds)
    .order("created_at", { ascending: false })
    .range(0, EXPORT_CAP - 1);

  if (error) {
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as KeyExportRow[];

  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "keys",
    count: rows.length,
    filters: sp,
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
