"use client";

import { useActionState, useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { updateTask, type TaskActionState } from "@/lib/actions/tasks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AssigneeField, DueTimeField } from "@/components/features/tasks/task-fields";
import { dueFormValues, type TaskAssignee, type TaskRights } from "@/lib/validators/tasks";

/**
 * Edit a task (A02). Offered only for what the viewer may change (`taskRights`):
 * a human task's title, date and time; and, for an admin or the creator who
 * holds it, who it is for. An automatic reminder offers the assignee alone —
 * its rule owns the title and the due date, which is its cycle key.
 *
 * The outcome is handled where the action returns, not in an effect: a saved
 * task can change section (overdue → upcoming) or leave this view entirely
 * (handed on), and the row that owned this dialog unmounts with it.
 */
export function EditTaskDialog({
  task,
  rights,
  assignees,
  meId,
}: {
  task: {
    id: string;
    title: string;
    dueAt: string | null;
    assigneeId: string | null;
    assigneeName: string | null;
    isAuto: boolean;
  };
  rights: TaskRights;
  assignees: TaskAssignee[];
  meId: string;
}) {
  const [open, setOpen] = useState(false);
  const initial: TaskActionState = { error: null, savedAt: null };
  const [state, formAction, pending] = useActionState(
    async (prev: TaskActionState, formData: FormData) => {
      const result = await updateTask(prev, formData);
      if (!result.error) {
        toast.success("Task saved");
        if (result.notice) toast.warning(result.notice);
        setOpen(false);
      }
      return result;
    },
    initial,
  );
  const due = dueFormValues(task.dueAt);
  const editsDetails = rights.editDetails && !task.isAuto;
  const prefix = `edit-task-${task.id}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Edit: ${task.title}`}>
          <Pencil className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
          {editsDetails ? null : (
            <DialogDescription>
              {task.isAuto
                ? "An automatic reminder: its rule sets the title and the due date. You can give it to someone else."
                : "You can give this task to someone else."}
            </DialogDescription>
          )}
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="task_id" value={task.id} />
          {editsDetails ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${prefix}-title`}>Task</Label>
                <Input id={`${prefix}-title`} name="title" required defaultValue={task.title} />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={`${prefix}-due`}>Due date</Label>
                  <Input
                    id={`${prefix}-due`}
                    name="due_date"
                    type="date"
                    defaultValue={due.due_date}
                    className="h-10"
                  />
                </div>
                <DueTimeField id={`${prefix}-time`} defaultValue={due.due_time} />
              </div>
            </>
          ) : (
            <p className="truncate text-sm text-text-1">{task.title}</p>
          )}
          {rights.reassign ? (
            <AssigneeField
              id={`${prefix}-assignee`}
              assignees={assignees}
              meId={meId}
              defaultValue={task.assigneeId}
              missingLabel={
                task.assigneeId === null
                  ? "Nobody — choose a colleague"
                  : `${task.assigneeName ?? "A former colleague"} — choose an active colleague`
              }
            />
          ) : null}
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
