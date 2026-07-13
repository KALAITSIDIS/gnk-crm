"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import { RouteBuilder } from "@/components/features/viewings/route-builder";
import { Button } from "@/components/ui/button";
import type { ViewingStatus } from "@/lib/validators/viewings";
import { cn } from "@/lib/utils";

export interface CalendarViewing {
  id: string;
  propertyId: string;
  propertyRef: string | null;
  contactName: string;
  agentName: string;
  agentId: string;
  status: ViewingStatus;
  durationMin: number;
  dayKey: string;
  startMinutes: number;
  timeLabel: string;
  conflict: boolean;
  routeDate: string | null;
  routeOrder: number | null;
}

type ViewMode = "week" | "day" | "list" | "route";

const STATUS_TONES: Record<ViewingStatus, string> = {
  scheduled: "bg-brand-100 text-brand-700",
  completed: "bg-success/10 text-success",
  cancelled: "bg-surface-2 text-text-3 line-through",
  no_show: "bg-danger/10 text-danger",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* date-only helpers — operate at UTC noon so DST never shifts the day */
function keyToUtcNoon(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}
function utcNoonToKey(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}
function addDays(key: string, n: number): string {
  return utcNoonToKey(keyToUtcNoon(key) + n * 86_400_000);
}
function weekStart(key: string): string {
  const dow = new Date(keyToUtcNoon(key)).getUTCDay(); // 0=Sun
  return addDays(key, -((dow + 6) % 7)); // Monday-start
}
function dayHeader(key: string): { wd: string; dom: number } {
  const dt = new Date(keyToUtcNoon(key));
  return { wd: WEEKDAYS[dt.getUTCDay()], dom: dt.getUTCDate() };
}
function longDay(key: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(keyToUtcNoon(key)));
}

function ViewingCard({ v, showAgent }: { v: CalendarViewing; showAgent: boolean }) {
  return (
    <Link
      href={`/viewings/${v.id}`}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg border p-2 text-xs transition-colors hover:border-brand-300",
        v.conflict ? "border-warning/60 bg-warning/5" : "border-border bg-surface",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-semibold tabular-nums text-text-1">{v.timeLabel}</span>
        <span className="text-text-3">{v.durationMin}m</span>
        {v.conflict ? (
          <TriangleAlert
            className="size-3.5 text-warning"
            aria-label="Agent double-booked at this time"
          />
        ) : null}
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize",
            STATUS_TONES[v.status],
          )}
        >
          {v.status.replace("_", " ")}
        </span>
      </div>
      {v.propertyRef ? (
        <span className="truncate font-mono text-[11px] text-text-2">{v.propertyRef}</span>
      ) : null}
      <span className="truncate text-text-2">{v.contactName}</span>
      {showAgent ? <span className="truncate text-text-3">{v.agentName}</span> : null}
    </Link>
  );
}

export function ViewingsCalendar({
  viewings,
  todayKey,
  currentUserId,
  isAdmin,
}: {
  viewings: CalendarViewing[];
  todayKey: string;
  currentUserId: string;
  isAdmin: boolean;
}) {
  const [view, setView] = useState<ViewMode>("week");
  const [anchor, setAnchor] = useState(todayKey);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarViewing[]>();
    for (const v of viewings) {
      const arr = map.get(v.dayKey) ?? [];
      arr.push(v);
      map.set(v.dayKey, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.startMinutes - b.startMinutes);
    return map;
  }, [viewings]);

  const weekDays = useMemo(() => {
    const start = weekStart(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [anchor]);

  const upcoming = useMemo(() => {
    const days = [...byDay.keys()].filter((k) => k >= todayKey).sort();
    return days.map((k) => ({ day: k, items: byDay.get(k)! }));
  }, [byDay, todayKey]);

  const step = (dir: 1 | -1) => setAnchor((a) => addDays(a, dir * (view === "week" ? 7 : 1)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {(["week", "day", "list", "route"] as ViewMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setView(m)}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium capitalize transition-colors",
                view === m ? "bg-brand-100 text-brand-700" : "text-text-2 hover:text-text-1",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {view !== "list" ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => step(-1)} aria-label="Previous">
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAnchor(todayKey)}>
              Today
            </Button>
            <Button variant="outline" size="sm" onClick={() => step(1)} aria-label="Next">
              <ChevronRight className="size-4" />
            </Button>
            <span className="ml-1 text-sm font-medium text-text-1">
              {view === "week"
                ? `${dayHeader(weekDays[0]).dom} – ${longDay(weekDays[6])}`
                : longDay(anchor)}
            </span>
          </div>
        ) : null}
      </div>

      {view === "week" ? (
        <div className="overflow-x-auto">
          <div className="grid min-w-[840px] grid-cols-7 gap-2">
            {weekDays.map((key) => {
              const { wd, dom } = dayHeader(key);
              const items = byDay.get(key) ?? [];
              const isToday = key === todayKey;
              return (
                <div key={key} className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAnchor(key);
                      setView("day");
                    }}
                    className={cn(
                      "rounded-lg border px-2 py-1 text-left text-xs font-medium",
                      isToday
                        ? "border-brand-300 bg-brand-100 text-brand-700"
                        : "border-border text-text-2 hover:bg-surface-2",
                    )}
                  >
                    {wd} <span className="tabular-nums">{dom}</span>
                  </button>
                  <div className="flex flex-col gap-1.5">
                    {items.map((v) => (
                      <ViewingCard key={v.id} v={v} showAgent={false} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {view === "day" ? (
        <div className="flex flex-col gap-2">
          {(byDay.get(anchor) ?? []).length === 0 ? (
            <EmptyDay />
          ) : (
            (byDay.get(anchor) ?? []).map((v) => <ViewingCard key={v.id} v={v} showAgent />)
          )}
        </div>
      ) : null}

      {view === "route" ? (
        <RouteBuilder
          key={anchor}
          dayKey={anchor}
          stops={(byDay.get(anchor) ?? []).filter(
            (v) => v.status === "scheduled" && (isAdmin || v.agentId === currentUserId),
          )}
        />
      ) : null}

      {view === "list" ? (
        <div className="flex flex-col gap-4">
          {upcoming.length === 0 ? (
            <EmptyDay label="No upcoming viewings." />
          ) : (
            upcoming.map(({ day, items }) => (
              <div key={day} className="flex flex-col gap-2">
                <h3
                  className={cn(
                    "text-sm font-semibold",
                    day === todayKey ? "text-brand-700" : "text-text-1",
                  )}
                >
                  {day === todayKey ? "Today · " : ""}
                  {longDay(day)}
                </h3>
                {items.map((v) => (
                  <ViewingCard key={v.id} v={v} showAgent />
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function EmptyDay({ label = "No viewings this day." }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border bg-surface py-12">
      <CalendarDays className="size-7 text-text-3" />
      <p className="text-sm text-text-2">{label}</p>
    </div>
  );
}
