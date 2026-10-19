"use client";

import { useActionState, useRef, useState } from "react";
import { ListPlus } from "lucide-react";
import { toast } from "sonner";
import { listTaskAssignees, quickAddTask, type TaskActionState } from "@/lib/actions/tasks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AssigneeField, DueTimeField } from "@/components/features/tasks/task-fields";
import type { TaskAssignee } from "@/lib/validators/tasks";

/**
 * "Add task here" on a detail page (audit WF-5) — the same quickAddTask the
 * /tasks page uses, with the entity pre-linked through a hidden input so the
 * task lands on this record's timeline instead of floating free. Mounted on
 * the property, contact, deal and viewing pages (the viewing since A02),
 * deliberately NOT on /tasks (whose happy-path spec pins the first
 * /add|create/i button as the quick-add submit).
 *
 * A02: a "More" disclosure adds a time of day and the colleague the task is
 * for. The pages that mount this were not handed the colleague list, so the
 * dialog reads it the first time it opens (`listTaskAssignees`); until it
 * arrives, or if it fails, no choice is offered and the task stays with its
 * creator.
 */
export function AddTaskDialog({
  entity,
  entityLabel,
}: {
  entity: {
    property_id?: string;
    contact_id?: string;
    deal_id?: string;
    viewing_id?: string;
    lead_id?: string;
  };
  entityLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [assignees, setAssignees] = useState<TaskAssignee[] | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requested = useRef(false);

  const initial: TaskActionState = { error: null, savedAt: null };
  const [state, formAction, pending] = useActionState(
    async (prev: TaskActionState, formData: FormData) => {
      const result = await quickAddTask(prev, formData);
      if (!result.error) {
        toast.success("Task added");
        if (result.notice) toast.warning(result.notice);
        setOpen(false);
      }
      return result;
    },
    initial,
  );

  const loadAssignees = () => {
    if (requested.current) return;
    requested.current = true;
    const failed = (message: string) => {
      setLoadError(message);
      requested.current = false; // the next opening asks again
    };
    listTaskAssignees().then(
      (r) => {
        setMeId(r.meId);
        if (r.error) return failed(r.error);
        setLoadError(null);
        setAssignees(r.assignees);
      },
      () => failed("Colleagues could not be loaded."),
    );
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) loadAssignees();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <ListPlus className="size-4" /> Add task
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add task — {entityLabel}</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          {entity.property_id ? (
            <input type="hidden" name="property_id" value={entity.property_id} />
          ) : null}
          {entity.contact_id ? (
            <input type="hidden" name="contact_id" value={entity.contact_id} />
          ) : null}
          {entity.deal_id ? <input type="hidden" name="deal_id" value={entity.deal_id} /> : null}
          {entity.viewing_id ? (
            <input type="hidden" name="viewing_id" value={entity.viewing_id} />
          ) : null}
          {entity.lead_id ? <input type="hidden" name="lead_id" value={entity.lead_id} /> : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-task-title">Task</Label>
            <Input id="add-task-title" name="title" required placeholder="Call back about…" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-task-due">Due date</Label>
            <Input id="add-task-due" name="due_date" type="date" />
          </div>
          <details>
            <summary className="w-fit cursor-pointer select-none text-xs font-medium text-text-2 hover:text-text-1">
              More — time, assign to
            </summary>
            <div className="mt-2 flex flex-col gap-3">
              <DueTimeField id="add-task-time" />
              <AssigneeField
                id="add-task-assignee"
                assignees={assignees}
                meId={meId}
                loadError={loadError}
              />
            </div>
          </details>
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add task"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
