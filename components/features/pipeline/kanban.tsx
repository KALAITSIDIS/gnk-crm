"use client";

import Link from "next/link";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { HealthDot } from "@/components/features/shared/health-dot";
import { moveDealToStage } from "@/lib/actions/deals";
import type { HealthFactor } from "@/lib/services/health-score";
import { formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export interface KanbanStage {
  id: string;
  name: string;
  sort_order: number;
  is_won: boolean;
  is_lost: boolean;
}

export interface KanbanDeal {
  id: string;
  title: string;
  stage_id: string;
  expected_value: number | null;
  health_score: number;
  healthFactors: HealthFactor[] | null;
  agentInitials: string;
  daysInStage: number;
  propertyRef: string | null;
}

/**
 * Keyboard DnD: ←/→ hop between stage columns (doc 06 keyboard rules).
 * Space/Enter picks up and drops.
 */
const columnHopCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const { active, droppableRects, droppableContainers, collisionRect } = context;
  if (!active || !collisionRect) return undefined;

  if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return undefined;
  event.preventDefault();

  const columns = droppableContainers
    .getEnabled()
    .map((c) => ({ id: c.id, rect: droppableRects.get(c.id) }))
    .filter((c): c is { id: typeof c.id; rect: NonNullable<typeof c.rect> } => Boolean(c.rect))
    .sort((a, b) => a.rect.left - b.rect.left);
  if (columns.length === 0) return undefined;

  const currentX = collisionRect.left + collisionRect.width / 2;
  const currentIndex = columns.findIndex(
    (c) => currentX >= c.rect.left && currentX <= c.rect.right,
  );
  const nextIndex =
    event.code === "ArrowRight"
      ? Math.min(columns.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
  const target = columns[nextIndex];
  if (!target || nextIndex === currentIndex) return undefined;

  return {
    x: target.rect.left + target.rect.width / 2 - collisionRect.width / 2,
    y: target.rect.top + 40,
  };
};

function DealCard({ deal, dragging = false }: { deal: KanbanDeal; dragging?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-3 shadow-sm",
        dragging && "rotate-2 shadow-lg",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/deals/${deal.id}`}
          className="line-clamp-2 text-sm font-medium text-text-1 hover:text-brand-700"
          onClick={(e) => dragging && e.preventDefault()}
        >
          {deal.title}
        </Link>
        <HealthDot
          score={deal.health_score}
          factors={deal.healthFactors}
          className="mt-1"
        />
      </div>
      <div className="flex items-center justify-between text-xs text-text-2">
        <span className="font-semibold tabular-nums text-text-1">
          {formatMoney(deal.expected_value)}
        </span>
        {deal.propertyRef ? <span className="font-mono">{deal.propertyRef}</span> : null}
      </div>
      <div className="flex items-center justify-between text-xs text-text-3">
        <span className="flex size-5 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700">
          {deal.agentInitials}
        </span>
        <span>{deal.daysInStage}d in stage</span>
      </div>
    </div>
  );
}

function DraggableCard({ deal }: { deal: KanbanDeal }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn("touch-none", isDragging && "opacity-40")}
    >
      <DealCard deal={deal} />
    </div>
  );
}

function StageColumn({
  stage,
  deals,
}: {
  stage: KanbanStage;
  deals: KanbanDeal[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = deals.reduce((sum, d) => sum + (d.expected_value ?? 0), 0);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-64 shrink-0 flex-col gap-2 rounded-[10px] border border-border bg-surface-2 p-2",
        isOver && "ring-2 ring-brand-500",
        (stage.is_won || stage.is_lost) && "opacity-80",
      )}
    >
      <div className="flex items-center justify-between px-1 pt-1">
        <span className="text-[13px] font-semibold text-text-1">
          {stage.name}
          {stage.is_won ? " ✓" : stage.is_lost ? " ✕" : ""}
        </span>
        <span className="text-xs tabular-nums text-text-3">{deals.length}</span>
      </div>
      <span className="px-1 text-xs tabular-nums text-text-2">{formatMoney(total)}</span>
      <div className="flex min-h-16 flex-col gap-2">
        {deals.map((deal) => (
          <DraggableCard key={deal.id} deal={deal} />
        ))}
      </div>
    </div>
  );
}

export function KanbanBoard({
  stages,
  deals,
}: {
  stages: KanbanStage[];
  deals: KanbanDeal[];
}) {
  const [isPending, startTransition] = useTransition();
  const [optimisticDeals, applyMove] = useOptimistic(
    deals,
    (state, move: { dealId: string; stageId: string }) =>
      state.map((d) => (d.id === move.dealId ? { ...d, stage_id: move.stageId } : d)),
  );
  const [active, setActive] = useState<KanbanDeal | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnHopCoordinates }),
  );

  const byStage = useMemo(() => {
    const map = new Map<string, KanbanDeal[]>();
    for (const stage of stages) map.set(stage.id, []);
    for (const deal of optimisticDeals) {
      map.get(deal.stage_id)?.push(deal);
    }
    return map;
  }, [stages, optimisticDeals]);

  const onDragStart = (event: DragStartEvent) => {
    setActive(optimisticDeals.find((d) => d.id === event.active.id) ?? null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActive(null);
    const dealId = String(event.active.id);
    const stageId = event.over ? String(event.over.id) : null;
    if (!stageId) return;
    const deal = optimisticDeals.find((d) => d.id === dealId);
    if (!deal || deal.stage_id === stageId) return;

    startTransition(async () => {
      applyMove({ dealId, stageId });
      try {
        await moveDealToStage(dealId, stageId);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Move failed");
      }
    });
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div
        className={cn("flex gap-3 overflow-x-auto pb-2", isPending && "pointer-events-none opacity-70")}
      >
        {stages.map((stage) => (
          <StageColumn key={stage.id} stage={stage} deals={byStage.get(stage.id) ?? []} />
        ))}
      </div>
      <DragOverlay>{active ? <DealCard deal={active} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}
