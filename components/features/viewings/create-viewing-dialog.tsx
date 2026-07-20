"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CalendarPlus, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import {
  checkViewingConflicts,
  createViewing,
  type ConflictHit,
  type ViewingActionState,
} from "@/lib/actions/viewings";
import type { EntityOption } from "@/lib/actions/entity-search";
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
import { VIEWING_DURATIONS } from "@/lib/validators/viewings";

const initialState: ViewingActionState = { error: null, savedAt: null, viewingId: null };

export function CreateViewingDialog({
  defaultAgent = null,
  defaultProperty = null,
  triggerLabel = "New viewing",
}: {
  defaultAgent?: EntityOption | null;
  defaultProperty?: EntityOption | null;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createViewing, initialState);
  const lastToasted = useRef<number | null>(null);

  const [agentId, setAgentId] = useState<string | null>(defaultAgent?.id ?? null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [durationMin, setDurationMin] = useState(30);
  const [conflicts, setConflicts] = useState<ConflictHit[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The dialog CONTENT remounts on close, but this component doesn't — reset
  // the draft state too, or the conflict check would reuse the previous
  // agent/duration while the remounted fields show the defaults.
  const resetDraft = () => {
    setAgentId(defaultAgent?.id ?? null);
    setScheduledAt("");
    setDurationMin(30);
    setConflicts([]);
  };

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Viewing scheduled");
      setOpen(false);
      resetDraft();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetDraft is stable in behavior
  }, [state.savedAt]);

  // Live double-booking check whenever agent / time / duration change. All
  // state writes live inside the debounced callback (not the effect body) so
  // the check stays off the render path.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (!agentId || !scheduledAt) {
        setConflicts([]);
        return;
      }
      setConflicts(await checkViewingConflicts({ agentId, scheduledAt, durationMin }));
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [agentId, scheduledAt, durationMin]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) resetDraft();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <CalendarPlus className="size-4" /> {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule viewing</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <EntityPicker
            name="property_id"
            kind="property"
            label="Property"
            initial={defaultProperty}
            placeholder="Search reference or title…"
          />
          <EntityPicker
            name="contact_id"
            kind="contact"
            label="Contact"
            placeholder="Search name, phone…"
          />
          <EntityPicker
            name="agent_id"
            kind="agent"
            label="Agent"
            initial={defaultAgent}
            placeholder="Search agent…"
            onChange={(o) => setAgentId(o?.id ?? null)}
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="viewing-when">Date &amp; time</Label>
              <Input
                id="viewing-when"
                type="datetime-local"
                name="scheduled_at"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="viewing-duration">Duration</Label>
              <Select
                name="duration_min"
                defaultValue="30"
                onValueChange={(v) => setDurationMin(Number(v))}
              >
                <SelectTrigger id="viewing-duration">
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
                  This agent already has {conflicts.length} viewing
                  {conflicts.length > 1 ? "s" : ""} then:
                </p>
                <ul className="mt-1 list-disc pl-4 text-xs">
                  {conflicts.map((c) => (
                    <li key={c.id}>
                      {c.timeLabel}
                      {c.propertyRef ? ` · ${c.propertyRef}` : ""}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs">You can still schedule it.</p>
              </div>
            </div>
          ) : null}

          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Scheduling…" : "Schedule viewing"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
