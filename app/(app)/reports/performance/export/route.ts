import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { logListExport } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { zonedDateRangeToUtc } from "@/lib/utils/tz";
import {
  agentPerformanceCsv,
  isReportKey,
  priceReductionsCsv,
  sourceRoiCsv,
  stageConversionCsv,
  timeToCloseCsv,
  timeToCloseRows,
  type AgentPerformanceRow,
  type PriceReductions,
  type SourceRoiRow,
  type StageConversion,
  type TimeToClose,
} from "@/lib/services/report-export";

/**
 * CSV export for the C4 reports, reusing the list-export machinery: the same
 * `toCsv` (RFC-4180, BOM, formula neutralisation) and the same
 * `logListExport` audit event, because a report export moves the same kind of
 * data as a list export and must leave the same trace.
 *
 * The RPCs are SECURITY INVOKER, so this route needs no role check of its own —
 * whatever the caller may read is what they get, exactly as on the page.
 */
const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const params = request.nextUrl.searchParams;
  const report = params.get("report");
  if (!isReportKey(report)) {
    return NextResponse.json({ error: "Unknown report." }, { status: 400 });
  }
  const from = params.get("from");
  const to = params.get("to");
  if (!isDate(from) || !isDate(to)) {
    return NextResponse.json({ error: "A from and to date are required." }, { status: 400 });
  }

  const { gte, lt } = zonedDateRangeToUtc(from, to);
  const win = { p_from: gte!, p_to: lt! };

  let csv: string;
  let rowCount: number;

  switch (report) {
    case "agent_performance": {
      const { data, error } = await supabase.rpc("report_agent_performance", win);
      if (error) return NextResponse.json({ error: "Export failed." }, { status: 500 });
      const rows = (data ?? []) as unknown as AgentPerformanceRow[];
      const ids = rows.map((r) => r.agent_id);
      const { data: profiles } = ids.length
        ? await supabase.from("profiles").select("id, full_name, is_active").in("id", ids)
        : { data: [] };
      const names = new Map(
        (profiles ?? []).map((p) => [
          p.id,
          p.is_active ? p.full_name : `${p.full_name} (inactive)`,
        ]),
      );
      csv = toCsv(agentPerformanceCsv(names), rows);
      rowCount = rows.length;
      break;
    }
    case "source_roi": {
      const { data, error } = await supabase.rpc("report_source_roi", win);
      if (error) return NextResponse.json({ error: "Export failed." }, { status: 500 });
      const rows = (data ?? []) as unknown as SourceRoiRow[];
      csv = toCsv(sourceRoiCsv(), rows);
      rowCount = rows.length;
      break;
    }
    case "time_to_close": {
      const { data, error } = await supabase.rpc("report_time_to_close", win);
      if (error) return NextResponse.json({ error: "Export failed." }, { status: 500 });
      const rows = timeToCloseRows(data as unknown as TimeToClose);
      csv = toCsv(timeToCloseCsv(), rows);
      rowCount = rows.length;
      break;
    }
    case "stage_conversion": {
      const { data, error } = await supabase.rpc("report_stage_conversion", win);
      if (error) return NextResponse.json({ error: "Export failed." }, { status: 500 });
      const rows = (data as unknown as StageConversion)?.stages ?? [];
      csv = toCsv(stageConversionCsv(), rows);
      rowCount = rows.length;
      break;
    }
    case "price_reductions": {
      const { data, error } = await supabase.rpc("report_price_reductions", win);
      if (error) return NextResponse.json({ error: "Export failed." }, { status: 500 });
      const cuts = (data as unknown as PriceReductions)?.repeat_cuts ?? [];
      const ids = cuts.map((c) => c.property_id);
      const { data: props } = ids.length
        ? await supabase.from("properties").select("id, reference").in("id", ids)
        : { data: [] };
      const refs = new Map((props ?? []).map((p) => [p.id, p.reference]));
      csv = toCsv(priceReductionsCsv(refs), cuts);
      rowCount = cuts.length;
      break;
    }
  }

  // Written BEFORE the CSV is returned, exactly as the list exports do: if the
  // audit insert fails, the export fails too.
  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: `report:${report}`,
    count: rowCount,
    filters: { from, to },
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(`report-${report}`)}"`,
      "Cache-Control": "no-store",
    },
  });
}
