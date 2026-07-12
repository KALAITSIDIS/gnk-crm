import {
  CreateViewingDialog,
} from "@/components/features/viewings/create-viewing-dialog";
import {
  ViewingsCalendar,
  type CalendarViewing,
} from "@/components/features/viewings/viewings-calendar";
import { getCurrentProfile } from "@/lib/services/auth";
import { computeConflictIds } from "@/lib/services/viewings";
import { createClient } from "@/lib/supabase/server";
import { zonedParts } from "@/lib/utils/tz";
import type { ViewingStatus } from "@/lib/validators/viewings";

export const dynamic = "force-dynamic";

export default async function ViewingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // recent + all future, so the calendar can page back a little
  /* eslint-disable-next-line react-hooks/purity -- server component renders per-request; the clock read bounds the fetch window */
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { data: rows } = await supabase
    .from("viewings")
    .select(
      `id, scheduled_at, duration_min, status, property_id, agent_id,
       properties(reference),
       contacts(display_name),
       agent:profiles!agent_id(full_name)`,
    )
    .gte("scheduled_at", since)
    .order("scheduled_at", { ascending: true })
    .limit(500);

  const conflictIds = computeConflictIds(
    (rows ?? [])
      .filter((r) => r.status === "scheduled")
      .map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        startMs: new Date(r.scheduled_at).getTime(),
        durationMin: r.duration_min,
      })),
  );

  const viewings: CalendarViewing[] = (rows ?? []).map((r) => {
    const { dayKey, minutes, timeLabel } = zonedParts(r.scheduled_at);
    return {
      id: r.id,
      propertyId: r.property_id,
      propertyRef: (r.properties as { reference: string } | null)?.reference ?? null,
      contactName: (r.contacts as { display_name: string | null } | null)?.display_name ?? "—",
      agentName: (r.agent as { full_name: string } | null)?.full_name ?? "—",
      status: r.status as ViewingStatus,
      durationMin: r.duration_min,
      dayKey,
      startMinutes: minutes,
      timeLabel,
      conflict: conflictIds.has(r.id),
    };
  });

  const todayKey = zonedParts(new Date()).dayKey;
  const upcomingCount = viewings.filter(
    (v) => v.dayKey >= todayKey && v.status === "scheduled",
  ).length;

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
        <CreateViewingDialog defaultAgent={defaultAgent} />
      </div>

      <ViewingsCalendar viewings={viewings} todayKey={todayKey} />
    </div>
  );
}
