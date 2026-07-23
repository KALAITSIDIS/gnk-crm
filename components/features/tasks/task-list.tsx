"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { quickAddTask, toggleTaskDone, type TaskActionState } from "@/lib/actions/tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export interface TaskItem {
  id: string;
  title: string;
  dueAt: string | null;
  isDone: boolean;
  overdue: boolean;
  propertyId: string | null;
  propertyRef: string | null;
  isAuto: boolean; // mandate renewal etc. (system-generated)
}

export function QuickAddTask() {
  const initial: TaskActionState = { error: null, savedAt: null };
  const [state, formAction, pending] = useActionState(quickAddTask, initial);
  const formRef = useRef<HTMLFormElement>(null);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Task added");
      formRef.current?.reset();
    }
  }, [state.savedAt]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface p-3"
    >
      {/* placeholder is not an accessible name — it disappears on input and
          is not exposed reliably; the due-date sibling already did this (A11Y-1) */}
      <Input
        name="title"
        aria-label="Task title"
        placeholder="Quick task…"
        required
        className="h-10 min-w-0 flex-1 basis-40"
      />
      <Input name="due_date" type="date" className="h-10 w-40" aria-label="Due date" />
      <Button type="submit" disabled={pending} className="h-10">
        <Plus className="size-4" /> {pending ? "Adding…" : "Add"}
      </Button>
      {state.error ? (
        <p role="alert" className="w-full text-sm text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function TaskRow({ task }: { task: TaskItem }) {
  const [pending, start] = useTransition();

  const toggle = (next: boolean) =>
    start(async () => {
      const { error } = await toggleTaskDone(task.id, next);
      if (error) toast.error(error);
      else toast.success(next ? "Done" : "Reopened");
    });

  return (
    <li
      className={cn(
        "flex min-h-11 items-center gap-3 py-2",
        pending && "pointer-events-none opacity-60",
      )}
    >
      <Checkbox
        checked={task.isDone}
        onCheckedChange={(v) => toggle(v === true)}
        aria-label={task.isDone ? `Reopen: ${task.title}` : `Complete: ${task.title}`}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm",
            task.isDone ? "text-text-3 line-through" : "text-text-1",
          )}
        >
          {task.title}
        </span>
        {task.isAuto ? <span className="text-[10px] uppercase tracking-wide text-text-3">auto</span> : null}
      </span>
      {task.propertyId && task.propertyRef ? (
        <Link
          href={`/properties/${task.propertyId}`}
          className="shrink-0 font-mono text-xs text-brand-700 hover:underline"
        >
          {task.propertyRef}
        </Link>
      ) : null}
      {task.dueAt ? (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            task.overdue && !task.isDone ? "font-medium text-danger" : "text-text-3",
          )}
        >
          {formatDate(task.dueAt)}
        </span>
      ) : null}
    </li>
  );
}

export function TaskSection({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: TaskItem[];
  emptyText: string;
}) {
  return (
    <section className="rounded-[10px] border border-border bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-1">
        {title}
        <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-text-2">
          {items.length}
        </span>
      </h2>
      {items.length === 0 ? (
        <p className="py-2 text-sm text-text-3">{emptyText}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {items.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
