"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import * as Sentry from "@sentry/nextjs";
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
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { HealthDot } from "@/components/features/shared/health-dot";
import { moveDealToStage } from "@/lib/actions/deals";
import { reportRejection } from "@/lib/services/client-upload";
import type { HealthFactor } from "@/lib/services/health-score";
import { MOVE_READ_ONLY_TEXT, settleDrop } from "@/lib/services/pipeline-move";
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
  /**
   * The figure the card shows and its column sums — `dealValue()`: a won deal
   * at its confirmed final value (its estimate when none was recorded), every
   * other deal at its estimate. Display only: nothing on the board sends it
   * anywhere, and it is not the stored estimate (`deals.expected_value`).
   */
  displayValue: number | null;
  health_score: number;
  healthFactors: HealthFactor[] | null;
  agentInitials: string;
  status: "open" | "won" | "lost";
  /** Open: days since entering the stage. Won/lost: days since closing. */
  daysInStage: number;
  propertyRef: string | null;
}

/** A toast the user must read: the outcome is unknown and the board has moved under it. */
const UNTIL_DISMISSED = { duration: Infinity, closeButton: true } as const;

/**
 * A drop whose request never came back is reported where the error boundary
 * used to report it (the #158 idiom, components/features/shared/use-upload-form.ts):
 * a platform 5xx or a retired action id never reaches the server's logs.
 */
const reportLostMove = (error: unknown) =>
  Sentry.captureException(error, { tags: { lost_request: "pipeline_move" } });

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

function tenureLabel(deal: KanbanDeal): string {
  if (deal.status === "won") return `Won ${deal.daysInStage}d ago`;
  if (deal.status === "lost") return `Lost ${deal.daysInStage}d ago`;
  return `${deal.daysInStage}d in stage`;
}

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
        <span data-testid="deal-value" className="font-semibold tabular-nums text-text-1">
          {formatMoney(deal.displayValue)}
        </span>
        {deal.propertyRef ? <span className="font-mono">{deal.propertyRef}</span> : null}
      </div>
      <div className="flex items-center justify-between text-xs text-text-3">
        <span className="flex size-5 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700">
          {deal.agentInitials}
        </span>
        <span>{tenureLabel(deal)}</span>
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
  canMove,
  olderClosedHref,
}: {
  stage: KanbanStage;
  deals: KanbanDeal[];
  /** the viewer's role may move deals at all (mayMoveDeals) */
  canMove: boolean;
  /** a won/lost column: the /deals register pre-filtered to this type and outcome */
  olderClosedHref: string | null;
}) {
  // Won/lost are read-only endpoints: closing runs through the guarded flows
  // on the deal page, so their columns never accept a drop.
  const closedColumn = stage.is_won || stage.is_lost;
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled: closedColumn });
  // the sum of exactly the figures the cards below show
  const total = deals.reduce((sum, d) => sum + (d.displayValue ?? 0), 0);
  const headingId = `stage-heading-${stage.id}`;

  /**
   * Audit 2026-07-22 (UX-3): this column used to be a bare <div> with the
   * stage name in a <span>, so a screen reader met the whole board as one
   * undifferentiated run of text — no headings to jump between, no list
   * boundaries, and the bare "3" beside the name read as a stray number.
   * Automated tests had nothing to hold onto either and had to assert on
   * seeded stage NAMES; `data-stage-id` gives them the real hook.
   *
   * The cards stay inside <li>s rather than carrying the list roles
   * themselves: dnd-kit puts role="button" on the draggable via its
   * `attributes`, and overwriting that would cost the drag affordance.
   */
  return (
    <section
      ref={setNodeRef}
      data-stage-id={stage.id}
      data-stage-closed={closedColumn ? "true" : undefined}
      aria-labelledby={headingId}
      title={closedColumn ? "Deals close via the guarded flow on the deal page" : undefined}
      className={cn(
        "flex w-64 shrink-0 flex-col gap-2 rounded-[10px] border border-border bg-surface-2 p-2",
        isOver && "ring-2 ring-brand-500",
        closedColumn && "opacity-80",
      )}
    >
      <div className="flex items-center justify-between px-1 pt-1">
        <h3 id={headingId} className="text-[13px] font-semibold text-text-1">
          {stage.name}
          {stage.is_won ? " ✓" : stage.is_lost ? " ✕" : ""}
        </h3>
        {/* the bare count needs a name of its own or it reads as a loose digit */}
        <span
          className="text-xs tabular-nums text-text-3"
          aria-label={`${deals.length} ${deals.length === 1 ? "deal" : "deals"}`}
        >
          {deals.length}
        </span>
      </div>
      <span data-testid="stage-total" className="px-1 text-xs tabular-nums text-text-2">
        {formatMoney(total)}
      </span>
      <ul
        aria-label={`${stage.name} deals`}
        className="flex min-h-16 list-none flex-col gap-2"
      >
        {deals.map((deal) => (
          <li key={deal.id}>
            {/* only an open deal moves, and only for a role deals_update admits */}
            {canMove && deal.status === "open" ? (
              <DraggableCard deal={deal} />
            ) : (
              <DealCard deal={deal} />
            )}
          </li>
        ))}
      </ul>
      {closedColumn ? (
        <p className="px-1 pb-1 text-[11px] leading-snug text-text-3">
          Last 30 days — close deals from the deal page
          {/* the board keeps 30 days; the register keeps every closed deal (F05) */}
          {olderClosedHref ? (
            <>
              {" · "}
              <Link href={olderClosedHref} className="font-medium text-brand-700 hover:underline">
                Older closed deals →
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

export function KanbanBoard({
  stages,
  deals,
  canMove,
  dealType,
}: {
  stages: KanbanStage[];
  deals: KanbanDeal[];
  /**
   * The signed-in role may move deals (lib/services/pipeline-move.ts,
   * `mayMoveDeals`): false renders every card read-only and says why. ROLE
   * only — whether THIS deal may move is the server's answer.
   */
  canMove: boolean;
  /**
   * The board's deal-type tab. With it, the won and lost columns link to the
   * deals closed before the board's 30-day window — /deals for this type and
   * outcome. Without it they carry no link.
   */
  dealType?: string;
}) {
  const router = useRouter();
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

  // Screen readers announce deal titles and stage names, not raw UUIDs
  // (dnd-kit's default reads the ids).
  const announcements = useMemo<Announcements>(() => {
    const dealTitle = (id: unknown) =>
      deals.find((d) => d.id === String(id))?.title ?? "a deal";
    const stageName = (id: unknown) =>
      stages.find((s) => s.id === String(id))?.name ?? "a stage";
    return {
      onDragStart: ({ active }) => `Picked up ${dealTitle(active.id)}.`,
      onDragOver: ({ active, over }) =>
        over
          ? `${dealTitle(active.id)} is over the ${stageName(over.id)} stage.`
          : `${dealTitle(active.id)} is not over a stage.`,
      onDragEnd: ({ active, over }) =>
        over
          ? `${dealTitle(active.id)} was dropped on the ${stageName(over.id)} stage.`
          : `${dealTitle(active.id)} was dropped.`,
      onDragCancel: ({ active }) => `Moving ${dealTitle(active.id)} was cancelled.`,
    };
  }, [deals, stages]);

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

    /*
     * Every answer is settled INSIDE the transition: `settleDrop` makes the
     * call, catches a rejection rather than letting React rethrow it into
     * app/(app)/error.tsx, and — awaited here — re-reads the board for a
     * refusal or an unknown outcome before the transition ends, so the
     * optimistic revert and the fresh props land together: a card made stale
     * elsewhere (closed, reassigned, deleted) lands where the server has it,
     * not back in its old column. This body is pinned word for word
     * (tests/unit/kanban-drop-guard.test.ts); the control flow is run by
     * lib/services/pipeline-move.test.ts.
     */
    startTransition(async () => {
      applyMove({ dealId, stageId });
      await settleDrop({
        move: () => moveDealToStage(dealId, stageId),
        report: (error) => reportRejection(reportLostMove, error),
        toast: (message, sticky) => toast.error(message, sticky ? UNTIL_DISMISSED : undefined),
        refresh: () => router.refresh(),
      });
    });
  };

  return (
    <DndContext
      // Pinned id: dnd-kit otherwise derives aria-describedby from a module
      // counter, which desyncs between SSR and the StrictMode double-rendered
      // client mount (hydration mismatch).
      id="pipeline-kanban"
      sensors={sensors}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            "Press Space or Enter to pick up a deal, use the left and right arrow keys to choose a stage, and press Space or Enter again to drop it. Press Escape to cancel.",
        },
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {canMove ? null : (
        <p id="kanban-read-only" className="text-xs text-text-3">
          {MOVE_READ_ONLY_TEXT}
        </p>
      )}
      <div
        role="group"
        aria-label="Pipeline stages"
        aria-describedby={canMove ? undefined : "kanban-read-only"}
        data-testid="kanban-board"
        className={cn("flex gap-3 overflow-x-auto pb-2", isPending && "pointer-events-none opacity-70")}
      >
        {stages.map((stage) => (
          <StageColumn
            key={stage.id}
            stage={stage}
            deals={byStage.get(stage.id) ?? []}
            canMove={canMove}
            olderClosedHref={
              dealType && (stage.is_won || stage.is_lost)
                ? `/deals?${new URLSearchParams({ type: dealType, status: stage.is_won ? "won" : "lost" })}`
                : null
            }
          />
        ))}
      </div>
      <DragOverlay>{active ? <DealCard deal={active} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}
