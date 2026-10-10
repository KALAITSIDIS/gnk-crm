import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAll, fetchUpTo, type PageResult } from "@/lib/supabase/fetch-all";
import {
  EXPORT_CEILING,
  EXPORT_FAILED_MESSAGE,
  EXPORT_TOO_MANY_MESSAGE,
  EXPORT_TOO_MANY_UNFILTERED_MESSAGE,
  type ExportRefusalReason,
} from "@/lib/constants/export";

/**
 * Every record a list CSV export matches — or the answer that refuses it
 * (DECISIONS T-export-complete).
 *
 * WHY PAGED. Each route used to ask once for `.range(0, 9999)`, but PostgREST
 * caps a response at the project's `max_rows` (1000 by default) and says
 * nothing: the 1,001st record was silently missing from a 200 CSV whose audit
 * line counted what it held. Now the read pages through `fetchUpTo` — a fresh
 * query per page from `page(from, to)`, the SAME filters and the same session
 * (RLS) every time, advancing by what actually arrived, so a server capped
 * below the page size still yields every row.
 *
 * THE PAGE FACTORY MUST ORDER UNIQUELY: the list's own sort, then `id`. Offset
 * pages over a sort with ties can repeat or skip a row between requests.
 *
 * WHAT IT DOES NOT PROMISE. The pages are separate requests, so separate
 * snapshots: a record created, deleted or re-sorted WHILE an export is being
 * read can shift a page boundary — one row repeated or one skipped. A stable
 * dataset exports exactly; an export racing an edit of the same list can be
 * off by the rows that moved. One snapshot would need one statement (a
 * function returning the whole set), which nothing here justifies at this size.
 *
 * REFUSALS ARE ANSWERS, NOT FILES. Past `EXPORT_CEILING` nothing is returned
 * (422, reason `too_many`); a failed page fails the whole export (500,
 * `failed`) — never the pages read before it. Neither is audited: no record
 * left. The download button shows the message (`components/features/shared/export-csv-button.tsx`).
 */
export async function readExportRows<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  list: string,
  { filterable = true }: { filterable?: boolean } = {},
): Promise<{ rows: T[] } | { refused: NextResponse }> {
  try {
    const read = await fetchUpTo(page, `${list} export`, EXPORT_CEILING);
    if (read.more) {
      return { refused: refuse("too_many", filterable ? EXPORT_TOO_MANY_MESSAGE : EXPORT_TOO_MANY_UNFILTERED_MESSAGE) };
    }
    return { rows: read.rows };
  } catch {
    return { refused: refuse("failed", EXPORT_FAILED_MESSAGE) };
  }
}

/**
 * The Agent column's names — every profile of the org, inactive ones marked, so
 * their records do not export as unassigned. Paged like the rows, and a failed
 * read FAILS the export (null): an empty map would ship a complete-looking CSV
 * with every Agent cell blank.
 */
export async function readAgentNames(
  supabase: SupabaseClient<Database>,
): Promise<Map<string, string> | null> {
  try {
    const profiles = await fetchAll(
      (from, to) =>
        supabase.from("profiles").select("id, full_name, is_active").order("id").range(from, to),
      "profiles",
    );
    return new Map(profiles.map((p) => [p.id, p.is_active ? p.full_name : `${p.full_name} (inactive)`]));
  } catch {
    return null;
  }
}

/** The answer for an export that failed before any row was read. */
export const exportFailed = (): NextResponse => refuse("failed", EXPORT_FAILED_MESSAGE);

function refuse(reason: ExportRefusalReason, error: string): NextResponse {
  return NextResponse.json(
    { error, reason },
    { status: reason === "too_many" ? 422 : 500, headers: { "Cache-Control": "no-store" } },
  );
}
