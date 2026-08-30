"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CalendarClock, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  checkViewingConflicts,
  rescheduleViewing,
  type ConflictHit,
  type ViewingActionState,
} from "@/lib/actions/viewings";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { utcToDatetimeLocal } from "@/lib/utils/tz";
import { VIEWING_DURATIONS } from "@/lib/validators/viewings";

const initialState: ViewingActionState = { error: null, savedAt: null, viewingId: null };

const REASON_LABEL: Record<ConflictHit["reason"], string> = {
  agent: "agent's diary",
  property: "same property",
  contact: "same buyer",
};

/**
 * Move a scheduled viewing to a new time (audit WF-1) — same conflict
 * advisory as the create dialog, with this viewing excluded from its own
 * check. The action clears the day-route stamp when the day changes.
 */
export function RescheduleViewingDialog({
  viewingId,
  agentId,
  propertyId,
  contactId,
  scheduledAt,
  durationMin,
}: {
  viewingId: string;
  agentId: string;
  propertyId: string;
  contactId: string | null;
  scheduledAt: string;
  durationMin: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(rescheduleViewing, initialState);
  const lastToasted = useRef<number | null>(null);

  const [when, setWhen] = useState(() => utcToDatetimeLocal(scheduledAt));
  const [duration, setDuration] = useState(durationMin);
  const [conflicts, setConflicts] = useState<ConflictHit[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Viewing rescheduled");
      setOpen(false);
    }
  }, [state.savedAt]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (!open || !when) {
        setConflicts([]);
        return;
      }
      setConflicts(
        await checkViewingConflicts({
          agentId,
          propertyId,
          contactId,
          scheduledAt: when,
          durationMin: duration,
          excludeId: viewingId,
        }),
      );
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [open, when, duration, agentId, propertyId, contactId, viewingId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <CalendarClock className="size-4" /> Reschedule
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reschedule viewing</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="viewing_id" value={viewingId} />
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reschedule-when">New date &amp; time</Label>
              <Input
                id="reschedule-when"
                type="datetime-local"
                name="scheduled_at"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reschedule-duration">Duration</Label>
              <Select
                name="duration_min"
                defaultValue={String(durationMin)}
                onValueChange={(v) => setDuration(Number(v))}
              >
                <SelectTrigger id="reschedule-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VIEWING_DURATIONS.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {conflicts.length > 0 ? (
            <div className="flex gap-2 rounded-[10px] border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">
                  {conflicts.length} overlapping viewing{conflicts.length > 1 ? "s" : ""}:
                </p>
                <ul className="mt-1 list-disc pl-4 text-xs">
                  {conflicts.map((c) => (
                    <li key={c.id}>
                      {c.timeLabel}
                      {c.propertyRef ? ` · ${c.propertyRef}` : ""} · {REASON_LABEL[c.reason]}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs">You can still move it.</p>
              </div>
            </div>
          ) : null}

          <p className="text-xs text-text-3">
            The change is recorded on the timeline. If a confirmation sheet was generated,
            regenerate it so the printed time matches.
          </p>

          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Moving…" : "Reschedule"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
