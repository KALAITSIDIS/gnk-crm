"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Check, Lock, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { addStage, deleteStage, moveStage, renameStage } from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface StageRow {
  id: string;
  name: string;
  sort_order: number;
  is_won: boolean;
  is_lost: boolean;
}

function StageLine({ stage, isFirst, isLast }: { stage: StageRow; isFirst: boolean; isLast: boolean }) {
  const [name, setName] = useState(stage.name);
  const [pending, start] = useTransition();
  const terminal = stage.is_won || stage.is_lost;
  const dirty = name.trim() !== stage.name;

  const run = (fn: () => Promise<{ error: string | null }>, done: string) =>
    start(async () => {
      const { error } = await fn();
      if (error) toast.error(error);
      else toast.success(done);
    });

  return (
    <li
      className={cn(
        "flex items-center gap-2 py-1.5",
        pending && "pointer-events-none opacity-60",
      )}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={terminal}
        className="h-8 max-w-56"
      />
      {dirty && !terminal ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => run(() => renameStage(stage.id, name), "Stage renamed")}
        >
          <Check className="size-4" />
        </Button>
      ) : null}
      {terminal ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-3">
          <Lock className="size-3" /> {stage.is_won ? "won" : "lost"}
        </span>
      ) : (
        <>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2"
            disabled={isFirst}
            aria-label={`Move ${stage.name} up`}
            onClick={() => run(() => moveStage(stage.id, "up"), "Moved")}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2"
            disabled={isLast}
            aria-label={`Move ${stage.name} down`}
            onClick={() => run(() => moveStage(stage.id, "down"), "Moved")}
          >
            <ArrowDown className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-danger hover:text-danger"
            aria-label={`Delete ${stage.name}`}
            onClick={() => run(() => deleteStage(stage.id), "Stage deleted")}
          >
            <Trash2 className="size-4" />
          </Button>
        </>
      )}
    </li>
  );
}

function AddStage({ dealType }: { dealType: string }) {
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="mt-1 flex items-center gap-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New stage name…"
        className="h-8 max-w-56"
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8"
        disabled={pending || name.trim().length === 0}
        onClick={() =>
          start(async () => {
            const { error } = await addStage(dealType, name);
            if (error) toast.error(error);
            else {
              toast.success("Stage added");
              setName("");
            }
          })
        }
      >
        <Plus className="size-4" /> Add
      </Button>
    </div>
  );
}

export function StagesEditor({ groups }: { groups: { dealType: string; stages: StageRow[] }[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {groups.map((g) => {
        const movable = g.stages.filter((s) => !s.is_won && !s.is_lost);
        return (
          <section key={g.dealType} className="rounded-[10px] border border-border bg-surface p-5">
            <h2 className="mb-2 text-sm font-semibold capitalize text-text-1">{g.dealType}</h2>
            <ul className="flex flex-col divide-y divide-border/60">
              {g.stages.map((s) => (
                <StageLine
                  key={s.id}
                  stage={s}
                  isFirst={movable[0]?.id === s.id}
                  isLast={movable.at(-1)?.id === s.id}
                />
              ))}
            </ul>
            <AddStage dealType={g.dealType} />
          </section>
        );
      })}
    </div>
  );
}
