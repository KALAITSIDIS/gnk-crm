"use client";

import { useTransition } from "react";
import { CheckCircle2, UserX, XCircle } from "lucide-react";
import { toast } from "sonner";
import { updateViewingStatus } from "@/lib/actions/viewings";
import type { ViewingStatusAction } from "@/lib/validators/viewings";
import { Button } from "@/components/ui/button";

/** Complete / cancel / no-show actions for a scheduled viewing (T4.3). */
export function ViewingStatusActions({ viewingId }: { viewingId: string }) {
  const [pending, start] = useTransition();

  const run = (next: ViewingStatusAction, done: string) =>
    start(async () => {
      const { error } = await updateViewingStatus(viewingId, next);
      if (error) toast.error(error);
      else toast.success(done);
    });

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={pending} onClick={() => run("completed", "Marked completed")}>
        <CheckCircle2 className="size-4" /> Mark completed
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => run("cancelled", "Viewing cancelled")}
      >
        <XCircle className="size-4" /> Cancel
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => run("no_show", "Marked no-show")}
      >
        <UserX className="size-4" /> No-show
      </Button>
    </div>
  );
}
