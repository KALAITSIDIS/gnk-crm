import { AlertTriangle, Download } from "lucide-react";
import {
  CreateViewingDialog,
} from "@/components/features/viewings/create-viewing-dialog";
import { Button } from "@/components/ui/button";
import {
  ViewingsCalendar,
  type CalendarViewing,
} from "@/components/features/viewings/viewings-calendar";
import { getCurrentProfile } from "@/lib/services/auth";
import { computeConflictIds } from "@/lib/services/viewings";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import { zonedDateRangeToUtc, zonedParts } from "@/lib/utils/tz";
import {
  WINDOW_DAYS_AHEAD,
  WINDOW_DAYS_BACK,
  calendarWindow,
  parseDayKey,
  type CalendarViewMode,
} from "@/lib/services/calendar-window";
import type { ViewingStatus } from "@/lib/validators/viewings";

export const dynamic = "force-dynamic";

/**
 * Calendar fetch window (audit 2026-07-22 PERF-2; anchored 2026-07-24, B1
 * follow-up).
 *
 * A calendar is not a list, so row pagination is the wrong shape — the fix is
 * a BOUNDED window plus honest disclosure. The previous query was
 * `.gte(now-90d)` with no upper bound and `.limit(500)`, ordered ascending:
 * at the cap it silently dropped the FURTHEST-FUTURE viewings, so bookings
 * simply stopped appearing past some date with nothing on screen to say so.
 *
 * The window was then pinned to `now` while the calendar's anchor lived in
 * client state, so stepping past a year ahead left the loaded range and drew an
 * EMPTY week — the same silent lie in a different place. The anchor now travels
 * in `?d=` and the window follows it.
 */
const WINDOW_ROW_CAP = 2000;

type SearchParams = { [key: string]: string | string[] | undefined };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const VIEW_MODES: readonly CalendarViewMode[] = ["week", "day", "list", "route"];

export default async function ViewingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const todayKey = zonedParts(new Date()).dayKey;
  // Anchor from the URL so the window can follow the user; today by default.
  const anchorKey = parseDayKey(first(sp.d), todayKey);
  const rawView = first(sp.view);
  const view: CalendarViewMode = VIEW_MODES.includes(rawView as CalendarViewMode)
    ? (rawView as CalendarViewMode)
    : "week";

  const windowKeys = calendarWindow(anchorKey);
  const { gte: since, lt: until } = zonedDateRangeToUtc(windowKeys.fromKey, windowKeys.toKey);

  const [viewingsRes, upcomingRes] = await Promise.all([
    supabase
      .from("viewings")
      .select(
        `id, scheduled_at, duration_min, status, property_id, agent_id,
         route_date, route_order,
         properties(reference),
         contacts(display_name),
         agent:profiles!agent_id(full_name)`,
        { count: "exact" },
      )
      .gte("scheduled_at", since!)
      .lt("scheduled_at", until!)
      .order("scheduled_at", { ascending: true })
      .limit(WINDOW_ROW_CAP),
    // exact upcoming count — independent of the window and the cap, so the
    // header stays true even when the calendar itself is truncated
    supabase
      .from("viewings")
      .select("id", { count: "exact", head: true })
      .eq("status", "scheduled")
      .gte("scheduled_at", new Date().toISOString()),
  ]);

  const rows = unwrapRows(viewingsRes, "viewings");
  const windowTotal = viewingsRes.count ?? rows.length;
  const truncated = windowTotal > rows.length;

  const conflictIds = computeConflictIds(
    rows
      .filter((r) => r.status === "scheduled")
      .map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        startMs: new Date(r.scheduled_at).getTime(),
        durationMin: r.duration_min,
      })),
  );

  const viewings: CalendarViewing[] = rows.map((r) => {
    const { dayKey, minutes, timeLabel } = zonedParts(r.scheduled_at);
    return {
      id: r.id,
      propertyId: r.property_id,
      propertyRef: (r.properties as { reference: string } | null)?.reference ?? null,
      contactName: (r.contacts as { display_name: string | null } | null)?.display_name ?? "—",
      agentName: (r.agent as { full_name: string } | null)?.full_name ?? "—",
      agentId: r.agent_id,
      status: r.status as ViewingStatus,
      durationMin: r.duration_min,
      dayKey,
      startMinutes: minutes,
      timeLabel,
      conflict: conflictIds.has(r.id),
      routeDate: r.route_date,
      routeOrder: r.route_order,
    };
  });

  const upcomingCount = upcomingRes.count ?? 0;

  const defaultAgent =
    profile.role === "agent"
      ? { id: profile.id, label: profile.fullName, sublabel: "me" }
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Viewings</h1>
          <p className="text-sm text-text-2">
            {upcomingCount} upcoming
            {conflictIds.size > 0 ? (
              <span className="text-warning"> · {conflictIds.size} in a booking clash</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Exports EVERY viewing (all time), not just the calendar window.
              Plain anchor: file download. */}
          <Button asChild variant="outline">
            <a href="/viewings/export" download>
              <Download className="size-4" /> Export CSV
            </a>
          </Button>
          <CreateViewingDialog defaultAgent={defaultAgent} />
        </div>
      </div>

      {truncated ? (
        <p className="flex items-start gap-2 rounded-[10px] border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-text-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            Showing the first <span className="tabular-nums">{viewings.length}</span> of{" "}
            <span className="tabular-nums">{windowTotal}</span> viewings in this window (
            {WINDOW_DAYS_BACK} days back to {WINDOW_DAYS_AHEAD} days ahead of{" "}
            {anchorKey === todayKey ? "today" : anchorKey}). Later bookings are not on this
            calendar.
          </span>
        </p>
      ) : null}

      <ViewingsCalendar
        // remount when the server reloads around a new anchor/view, so the
        // calendar's local state re-seeds from the freshly loaded window
        key={`${anchorKey}:${view}`}
        viewings={viewings}
        todayKey={todayKey}
        anchorKey={anchorKey}
        view={view}
        windowFromKey={windowKeys.fromKey}
        windowToKey={windowKeys.toKey}
        currentUserId={profile.id}
        isAdmin={profile.role === "admin"}
      />
    </div>
  );
}
