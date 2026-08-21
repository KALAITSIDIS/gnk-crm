"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { Layers, Plus } from "lucide-react";
import { toast } from "sonner";
import { createPhase, type UnitActionState } from "@/lib/actions/units";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/utils/format";

const initialState: UnitActionState = { error: null, savedAt: null };

export interface PhaseRow {
  id: string;
  reference: string;
  title: string | null;
  status: string;
  delivery_date: string | null;
  unitCount: number;
}

/**
 * Phases of a project (BACKLOG audit finding 11).
 *
 * `phase` has been in the enum since 0001 with three read paths branching on
 * it, and nothing could create one. Units already accept a phase as their
 * parent, so this was the missing middle of a hierarchy the schema always
 * described.
 *
 * Each phase links to its OWN units page — the matrix, the generator and the
 * price lists all key off `parent_id`, so they work unchanged for a phase.
 */
export function PhasesSection({
  projectId,
  projectReference,
  phases,
  canManage,
}: {
  projectId: string;
  projectReference: string;
  phases: PhaseRow[];
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState(createPhase, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Phase created");
    }
  }, [state.savedAt]);

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4">
      <div>
        <h3 className="text-base font-semibold text-text-1">Phases</h3>
        <p className="mt-1 text-xs text-text-3">
          A project that hands over in stages. Each phase holds its own units, price lists and
          delivery date.
        </p>
      </div>

      {phases.length === 0 ? (
        <p className="text-sm text-text-3">
          No phases — units are added to the project directly. Add one only if this project really
          hands over in stages.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {phases.map((ph) => (
            <li key={ph.id}>
              <Link
                href={`/properties/${ph.id}/units`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 hover:text-brand-700"
              >
                <Layers className="size-4 shrink-0 self-center text-text-3" />
                <span className="font-mono text-sm font-medium text-brand-700">
                  {ph.reference}
                </span>
                <span className="text-sm text-text-1">{ph.title ?? "—"}</span>
                <span className="ml-auto flex items-center gap-3 text-xs text-text-2">
                  {ph.delivery_date ? <span>delivery {formatDate(ph.delivery_date)}</span> : null}
                  <span className="tabular-nums">
                    {ph.unitCount} unit{ph.unitCount === 1 ? "" : "s"}
                  </span>
                  <StatusBadge status={ph.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={formAction} className="flex flex-col gap-3 border-t border-border/60 pt-3">
          <input type="hidden" name="project_id" value={projectId} />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phase-code">Phase code *</Label>
              <Input id="phase-code" name="code" placeholder="P1" maxLength={6} required />
              <p className="text-xs text-text-3">
                Becomes {projectReference}-<span className="font-mono">P1</span>, and every unit
                under it.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phase-name">Name</Label>
              <Input id="phase-name" name="name" placeholder="Phase 1 — seafront block" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phase-delivery">Expected delivery</Label>
              <Input id="phase-delivery" name="delivery_date" type="date" />
              <p className="text-xs text-text-3">Its own date, not the project&apos;s.</p>
            </div>
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <div>
            <Button type="submit" size="sm" disabled={pending}>
              <Plus className="size-4" /> {pending ? "Creating…" : "Add phase"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
