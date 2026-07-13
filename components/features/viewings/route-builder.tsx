"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Printer, Route, Save } from "lucide-react";
import { toast } from "sonner";
import { saveViewingRoute } from "@/lib/actions/viewings";
import { initialRouteOrder } from "@/lib/services/viewings";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface RouteStop {
  id: string;
  timeLabel: string;
  startMinutes: number;
  durationMin: number;
  propertyRef: string | null;
  contactName: string;
  agentName: string;
  routeDate: string | null;
  routeOrder: number | null;
}

function StopRow({ stop, index }: { stop: RouteStop; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stop.id,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm",
        isDragging && "z-10 opacity-80 shadow-md",
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold tabular-nums text-brand-700">
        {index + 1}
      </span>
      <span className="w-12 shrink-0 font-semibold tabular-nums text-text-1">{stop.timeLabel}</span>
      <span className="w-24 shrink-0 truncate font-mono text-xs text-text-2">
        {stop.propertyRef ?? "—"}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-2">{stop.contactName}</span>
      <span className="hidden shrink-0 text-xs text-text-3 sm:block">{stop.agentName}</span>
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder stop ${index + 1}`}
        className="cursor-grab touch-none rounded p-1 text-text-3 hover:bg-surface-2 hover:text-text-1 active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>
    </li>
  );
}

/**
 * Day route builder (T4.4): drag the day's scheduled viewings into visiting
 * order, save (stamps route_date + route_order), print the day sheet.
 */
export function RouteBuilder({ dayKey, stops }: { dayKey: string; stops: RouteStop[] }) {
  const [order, setOrder] = useState<RouteStop[]>(() => initialRouteOrder(stops, dayKey));
  const [pending, startTransition] = useTransition();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrder((current) => {
      const from = current.findIndex((s) => s.id === active.id);
      const to = current.findIndex((s) => s.id === over.id);
      return arrayMove(current, from, to);
    });
  };

  const save = () =>
    startTransition(async () => {
      const { error } = await saveViewingRoute(
        dayKey,
        order.map((s) => s.id),
      );
      if (error) toast.error(error);
      else toast.success("Route saved");
    });

  if (stops.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border bg-surface py-12">
        <Route className="size-7 text-text-3" />
        <p className="text-sm text-text-2">No scheduled viewings this day to route.</p>
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className="text-sm text-text-2">
        Drag into visiting order, then save. The printable sheet follows this order.
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={order.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-1.5">
            {order.map((stop, i) => (
              <StopRow key={stop.id} stop={stop} index={i} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={save}>
          <Save className="size-4" /> {pending ? "Saving…" : "Save route"}
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/route-sheet?date=${dayKey}`} target="_blank">
            <Printer className="size-4" /> Day sheet
          </Link>
        </Button>
      </div>
    </div>
  );
}
