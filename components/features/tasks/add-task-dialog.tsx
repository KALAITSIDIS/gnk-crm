"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { ListPlus } from "lucide-react";
import { toast } from "sonner";
import { quickAddTask, type TaskActionState } from "@/lib/actions/tasks";
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

/**
 * "Add task here" on a detail page (audit WF-5) — the same quickAddTask the
 * /tasks page uses, with the entity pre-linked through a hidden input so the
 * task lands on this record's timeline instead of floating free. Mounted on
 * property/contact/deal detail pages, deliberately NOT on /tasks (whose
 * happy-path spec pins the first /add|create/i button as the quick-add
 * submit).
 */
export function AddTaskDialog({
  entity,
  entityLabel,
}: {
  entity: { property_id?: string; contact_id?: string; deal_id?: string };
  entityLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const initial: TaskActionState = { error: null, savedAt: null };
  const [state, formAction, pending] = useActionState(quickAddTask, initial);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Task added");
      setOpen(false);
    }
  }, [state.savedAt]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-task-title">Task</Label>
            <Input id="add-task-title" name="title" required placeholder="Call back about…" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-task-due">Due date</Label>
            <Input id="add-task-due" name="due_date" type="date" />
          </div>
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
