"use client";

import { useActionState, useRef, useTransition } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { quickAddTask, toggleTaskDone, type TaskActionState } from "@/lib/actions/tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { EditTaskDialog } from "@/components/features/tasks/edit-task-dialog";
import { AssigneeField, DueTimeField } from "@/components/features/tasks/task-fields";
import { formatTaskDue, type TaskAssignee, type TaskRights } from "@/lib/validators/tasks";
import { cn } from "@/lib/utils";

export interface TaskItem {
  id: string;
  title: string;
  dueAt: string | null;
  isDone: boolean;
  overdue: boolean;
  propertyId: string | null;
  propertyRef: string | null;
  /**
   * The property chip's link when the task's subject IS the property — it
   * opens the tab the task is about (`?tab=reservation`, `mandate`, `buyers`;
   * lib/services/task-target.ts). Null: the chip opens the property plainly.
   */
  propertyHref: string | null;
  /**
   * Where a follow-up nudge points — the deal it is about, or the viewing whose
   * feedback is missing (B7). A nudge the agent cannot act on in one click is a
   * nudge they will learn to ignore. Null for tasks with no subject, and when
   * the property chip already carries the link.
   */
  href: string | null;
  hrefLabel: string | null;
  isAuto: boolean; // system-generated: `tasks.kind` is set (renewal or nudge)
  assigneeId: string | null;
  /** the holder's name as the page knows it (null: nobody, or not read) */
  assigneeName: string | null;
  /**
   * Who holds it, shown under the title in the Delegated and Team views ("For
   * Maria K." / "Unassigned"); null in Mine, where it is always me.
   */
  ownerLabel: string | null;
  /** what the viewer may do to it (lib/validators/tasks.ts `taskRights`) */
  rights: TaskRights;
}

/**
 * The /tasks quick add (T5.5): one line — title, date, Add — with a "More"
 * disclosure for a time of day and the colleague it is for (A02). The
 * disclosure is a native <details>: its fields stay in the form while it is
 * closed, so their defaults (all day; me) post either way.
 */
export function QuickAddTask({ assignees, meId }: { assignees: TaskAssignee[]; meId: string }) {
  const initial: TaskActionState = { error: null, savedAt: null };
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(
    async (prev: TaskActionState, formData: FormData) => {
      const result = await quickAddTask(prev, formData);
      if (!result.error) {
        toast.success("Task added");
        if (result.notice) toast.warning(result.notice);
        formRef.current?.reset();
      }
      return result;
    },
    initial,
  );

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
      <details className="group w-full">
        <summary className="w-fit cursor-pointer select-none text-xs font-medium text-text-2 hover:text-text-1">
          More — time, assign to
        </summary>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DueTimeField id="quick-task-time" />
          <AssigneeField id="quick-task-assignee" assignees={assignees} meId={meId} />
        </div>
      </details>
      {state.error ? (
        <p role="alert" className="w-full text-sm text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function TaskRow({
  task,
  assignees,
  meId,
}: {
  task: TaskItem;
  assignees: TaskAssignee[];
  meId: string;
}) {
  const [pending, start] = useTransition();

  const toggle = (next: boolean) =>
    start(async () => {
      const { error } = await toggleTaskDone(task.id, next);
      if (error) toast.error(error);
      else toast.success(next ? "Done" : "Reopened");
    });

  const canEdit = !task.isDone && (task.rights.editDetails || task.rights.reassign);

  return (
    <li
      className={cn(
        "flex min-h-11 items-center gap-3 py-2",
        pending && "pointer-events-none opacity-60",
      )}
    >
      {task.rights.complete ? (
        <Checkbox
          checked={task.isDone}
          onCheckedChange={(v) => toggle(v === true)}
          aria-label={task.isDone ? `Reopen: ${task.title}` : `Complete: ${task.title}`}
        />
      ) : (
        // A delegated task is ticked by the person who holds it (tasks_update):
        // no checkbox that would only answer "not allowed".
        <span className="size-4 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm",
            task.isDone ? "text-text-3 line-through" : "text-text-1",
          )}
        >
          {task.title}
        </span>
        {/* The due date sits under the title (A02): with a time of day it is
            "19 Oct 2026, 10:30", and beside the links and the edit button a
            row of fixed-width items would widen a phone screen. */}
        {task.dueAt || task.isAuto || task.ownerLabel ? (
          <span className="flex min-w-0 items-center gap-2 text-xs text-text-3">
            {task.dueAt ? (
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  task.overdue && !task.isDone ? "font-medium text-danger" : "text-text-3",
                )}
              >
                {formatTaskDue(task.dueAt)}
              </span>
            ) : null}
            {task.isAuto ? (
              <span className="shrink-0 text-[10px] uppercase tracking-wide">auto</span>
            ) : null}
            {task.ownerLabel ? <span className="truncate">{task.ownerLabel}</span> : null}
          </span>
        ) : null}
      </span>
      {task.href && task.hrefLabel ? (
        <Link
          href={task.href}
          title={task.hrefLabel}
          className="max-w-24 shrink-0 truncate text-xs text-brand-700 hover:underline"
        >
          {task.hrefLabel}
        </Link>
      ) : null}
      {task.propertyId && task.propertyRef ? (
        <Link
          href={task.propertyHref ?? `/properties/${task.propertyId}`}
          className="shrink-0 font-mono text-xs text-brand-700 hover:underline"
        >
          {task.propertyRef}
        </Link>
      ) : null}
      {canEdit ? (
        <EditTaskDialog
          task={{
            id: task.id,
            title: task.title,
            dueAt: task.dueAt,
            assigneeId: task.assigneeId,
            assigneeName: task.assigneeName,
            isAuto: task.isAuto,
          }}
          rights={task.rights}
          assignees={assignees}
          meId={meId}
        />
      ) : null}
    </li>
  );
}

export function TaskSection({
  title,
  items,
  emptyText,
  assignees,
  meId,
}: {
  title: string;
  items: TaskItem[];
  emptyText: string;
  assignees: TaskAssignee[];
  meId: string;
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
            <TaskRow key={t.id} task={t} assignees={assignees} meId={meId} />
          ))}
        </ul>
      )}
    </section>
  );
}
