import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { logListExport } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { zonedDateRangeToUtc } from "@/lib/utils/tz";
import {
  agentPerformanceCsv,
  isPriceReductions,
  isReportKey,
  isTimeToClose,
  priceReductionsCsv,
  reportObject,
  reportRows,
  sourceRoiCsv,
  stageConversionCsv,
  stageConversionView,
  timeToCloseCsv,
  timeToCloseRows,
  withExcluded,
  withSourceSplits,
  withStageSplits,
  withWindow,
  type AgentPerformanceRow,
  type PriceReductions,
  type SourceRoiRow,
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
  // An RPC error, or an answer that is not the report, is a failed export —
  // never a header-only file that reads as an empty window (F06; the stage
  // report has done this since 0130).
  const failed = () => NextResponse.json({ error: "Export failed." }, { status: 500 });

  switch (report) {
    case "agent_performance": {
      const view = reportRows<AgentPerformanceRow>(await supabase.rpc("report_agent_performance", win));
      if (view.status === "error") return failed();
      const rows = view.rows;
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
      csv = toCsv(withWindow(agentPerformanceCsv(names), from, to), rows);
      rowCount = rows.length;
      break;
    }
    case "source_roi": {
      const view = reportRows<SourceRoiRow>(await supabase.rpc("report_source_roi", win));
      if (view.status === "error") return failed();
      const rows = view.rows;
      // 0154: Spam and "Converted, deal visible" appended after From / To
      csv = toCsv(withSourceSplits(withWindow(sourceRoiCsv(), from, to)), rows);
      rowCount = rows.length;
      break;
    }
    case "time_to_close": {
      const view = reportObject<TimeToClose>(await supabase.rpc("report_time_to_close", win), isTimeToClose);
      if (view.status === "error") return failed();
      const rows = timeToCloseRows(view.value);
      csv = toCsv(withWindow(timeToCloseCsv(), from, to), rows);
      rowCount = rows.length;
      break;
    }
    case "stage_conversion": {
      const view = stageConversionView(await supabase.rpc("report_stage_conversion", win));
      if (view.status === "error") return failed();
      // 0130: no stage row, but malformed stage changes were excluded. A
      // header-only file has no row to carry the count and would read as a
      // complete, empty report, so refuse — the page shows the same window's
      // warning. (A genuinely empty window still exports its header, as every
      // export does.)
      if (view.status !== "data" && view.excluded > 0) {
        return NextResponse.json(
          {
            error:
              "Nothing to export: this window has no stage figures, and " +
              `${view.excluded} stage change(s) with an unreadable stage reference were excluded from the report.`,
          },
          { status: 422 },
        );
      }
      const rows = view.conv.stages;
      // 0154: Deal type, Moved back, Direction unknown and Stage id appended
      // after the exclusion count — blank against a database still at 0130
      csv = toCsv(
        withStageSplits(
          withExcluded(withWindow(stageConversionCsv(view.conv.note ?? ""), from, to), view.excluded),
        ),
        rows,
      );
      rowCount = rows.length;
      break;
    }
    case "price_reductions": {
      const view = reportObject<PriceReductions>(
        await supabase.rpc("report_price_reductions", win),
        isPriceReductions,
      );
      if (view.status === "error") return failed();
      const cuts = view.value.repeat_cuts;
      const ids = cuts.map((c) => c.property_id);
      const { data: props } = ids.length
        ? await supabase.from("properties").select("id, reference").in("id", ids)
        : { data: [] };
      const refs = new Map((props ?? []).map((p) => [p.id, p.reference]));
      csv = toCsv(withWindow(priceReductionsCsv(refs), from, to), cuts);
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
      "Content-Disposition": `attachment; filename="${csvFilename(`report-${report}-${from}-to-${to}`)}"`,
      "Cache-Control": "no-store",
    },
  });
}
