"use client";

import { useState, useTransition } from "react";
import { UserX } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { reassignTask } from "@/lib/actions/tasks";
import type { StrandedTask } from "@/lib/queries/stranded-tasks";
import { Button } from "@/components/ui/button";

export interface ActiveUser {
  id: string;
  fullName: string;
}

/**
 * Admin-only: the tasks no surface shows (BACKLOG T-audit-tasks).
 *
 * Rendered only when there is something to show. An always-visible "0 stranded
 * tasks" panel would be noise on a page an agent uses daily, and the whole
 * point is that these are exceptional.
 */
export function StrandedTasks({ tasks, users }: { tasks: StrandedTask[]; users: ActiveUser[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  if (tasks.length === 0) return null;

  const submit = (taskId: string) => {
    const to = choice[taskId] ?? users[0]?.id;
    if (!to) {
      toast.error("No active user to reassign to");
      return;
    }
    setBusyId(taskId);
    startTransition(async () => {
      const { error } = await reassignTask(taskId, to);
      setBusyId(null);
      if (error) toast.error(error);
      else {
        toast.success("Task reassigned");
        router.refresh();
      }
    });
  };

  return (
    <section className="rounded-[10px] border border-warning/30 bg-warning/5 p-5">
      <div className="mb-1 flex items-center gap-2">
        <UserX className="size-4 text-warning" aria-hidden />
        <h2 className="text-sm font-semibold text-text-1">
          Needs an owner ({tasks.length})
        </h2>
      </div>
      <p className="mb-3 text-xs text-text-2">
        Open tasks with no active assignee. They appear on nobody&apos;s list, including their
        own — automatic re-homing covers system nudges only, because moving a task somebody
        assigned by hand is a decision.
      </p>

      <ul className="flex flex-col gap-2">
        {tasks.map((t) => (
          <li
            key={t.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-border bg-surface p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-text-1">{t.title}</p>
              <p className="text-xs text-text-3">
                {t.reason === "unassigned"
                  ? "Unassigned"
                  : `Held by ${t.assigneeName ?? "a deactivated user"} (deactivated)`}
                {t.isAuto ? " · automatic" : ""}
                {t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleDateString()}` : ""}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <label className="sr-only" htmlFor={`reassign-${t.id}`}>
                Reassign {t.title} to
              </label>
              <select
                id={`reassign-${t.id}`}
                className="h-9 rounded-[8px] border border-border bg-surface px-2 text-sm text-text-1"
                value={choice[t.id] ?? users[0]?.id ?? ""}
                onChange={(e) => setChoice((c) => ({ ...c, [t.id]: e.target.value }))}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending && busyId === t.id}
                onClick={() => submit(t.id)}
              >
                {pending && busyId === t.id ? "Reassigning…" : "Reassign"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
