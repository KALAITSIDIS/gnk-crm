"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, UserX, XCircle } from "lucide-react";
import { toast } from "sonner";
import { updateViewingStatus } from "@/lib/actions/viewings";
import type { ViewingStatusAction } from "@/lib/validators/viewings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ConfirmableAction = Exclude<ViewingStatusAction, "completed">;

/* Status moves are one-way (no reopen path), so the two "did not happen"
 * actions confirm before committing; completing stays one tap. */
const CONFIRM_COPY: Record<
  ConfirmableAction,
  { title: string; body: string; cta: string; done: string }
> = {
  cancelled: {
    title: "Cancel this viewing?",
    body: "The viewing moves to cancelled permanently — there is no undo.",
    cta: "Cancel viewing",
    done: "Viewing cancelled",
  },
  no_show: {
    title: "Mark as no-show?",
    body: "The viewing moves to no-show permanently — there is no undo.",
    cta: "Mark no-show",
    done: "Marked no-show",
  },
};

/** Complete / cancel / no-show actions for a scheduled viewing (T4.3). */
export function ViewingStatusActions({ viewingId }: { viewingId: string }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState<ConfirmableAction | null>(null);

  const run = (next: ViewingStatusAction, done: string) =>
    start(async () => {
      const { error } = await updateViewingStatus(viewingId, next);
      if (error) toast.error(error);
      else toast.success(done);
    });

  const copy = confirming ? CONFIRM_COPY[confirming] : null;

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={pending} onClick={() => run("completed", "Marked completed")}>
        <CheckCircle2 className="size-4" /> Mark completed
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setConfirming("cancelled")}
      >
        <XCircle className="size-4" /> Cancel
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setConfirming("no_show")}
      >
        <UserX className="size-4" /> No-show
      </Button>

      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{copy?.title}</DialogTitle>
            <DialogDescription>{copy?.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
              Keep viewing
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (confirming) run(confirming, CONFIRM_COPY[confirming].done);
                setConfirming(null);
              }}
            >
              {copy?.cta}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
