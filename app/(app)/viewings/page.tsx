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
import { zonedParts } from "@/lib/utils/tz";
import type { ViewingStatus } from "@/lib/validators/viewings";

export const dynamic = "force-dynamic";

/**
 * Calendar fetch window (audit 2026-07-22, PERF-2).
 *
 * A calendar is not a list, so row pagination is the wrong shape — the fix is
 * a BOUNDED window plus honest disclosure. The previous query was
 * `.gte(now-90d)` with no upper bound and `.limit(500)`, ordered ascending:
 * at the cap it silently dropped the FURTHEST-FUTURE viewings, so bookings
 * simply stopped appearing past some date with nothing on screen to say so.
 * Both ends are now explicit and the cap is disclosed when reached.
 */
const WINDOW_DAYS_BACK = 90;
const WINDOW_DAYS_AHEAD = 365;
const WINDOW_ROW_CAP = 2000;

export default async function ViewingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  /* eslint-disable-next-line react-hooks/purity -- server component renders per-request; the clock read bounds the fetch window */
  const nowMs = Date.now();
  const since = new Date(nowMs - WINDOW_DAYS_BACK * 86_400_000).toISOString();
  const until = new Date(nowMs + WINDOW_DAYS_AHEAD * 86_400_000).toISOString();

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
      .gte("scheduled_at", since)
      .lte("scheduled_at", until)
      .order("scheduled_at", { ascending: true })
      .limit(WINDOW_ROW_CAP),
    // exact upcoming count — independent of the window and the cap, so the
    // header stays true even when the calendar itself is truncated
    supabase
      .from("viewings")
      .select("id", { count: "exact", head: true })
      .eq("status", "scheduled")
      .gte("scheduled_at", new Date(nowMs).toISOString()),
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

  const todayKey = zonedParts(new Date()).dayKey;
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
            {WINDOW_DAYS_BACK} days back to {WINDOW_DAYS_AHEAD} days ahead). Later bookings are
            not on this calendar.
          </span>
        </p>
      ) : null}

      <ViewingsCalendar
        viewings={viewings}
        todayKey={todayKey}
        currentUserId={profile.id}
        isAdmin={profile.role === "admin"}
      />
    </div>
  );
}
