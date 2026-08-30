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
  defaultContact = null,
  defaultDealId = null,
  triggerLabel = "New viewing",
}: {
  defaultAgent?: EntityOption | null;
  defaultProperty?: EntityOption | null;
  /** WF-3: the deal page prefills its buyer so the viewing lands linked */
  defaultContact?: EntityOption | null;
  /** WF-3: the schema accepted deal_id since T4.1 — nothing ever sent it */
  defaultDealId?: string | null;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createViewing, initialState);
  const lastToasted = useRef<number | null>(null);

  const [agentId, setAgentId] = useState<string | null>(defaultAgent?.id ?? null);
  const [propertyId, setPropertyId] = useState<string | null>(defaultProperty?.id ?? null);
  const [contactId, setContactId] = useState<string | null>(defaultContact?.id ?? null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [durationMin, setDurationMin] = useState(30);
  const [conflicts, setConflicts] = useState<ConflictHit[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The dialog CONTENT remounts on close, but this component doesn't — reset
  // the draft state too, or the conflict check would reuse the previous
  // agent/duration while the remounted fields show the defaults.
  const resetDraft = () => {
    setAgentId(defaultAgent?.id ?? null);
    setPropertyId(defaultProperty?.id ?? null);
    setContactId(defaultContact?.id ?? null);
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

  // Live double-booking check whenever a diary axis / time / duration change
  // (agent, property, or buyer — audit WF-6). All state writes live inside the
  // debounced callback (not the effect body) so the check stays off the render
  // path.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if ((!agentId && !propertyId && !contactId) || !scheduledAt) {
        setConflicts([]);
        return;
      }
      setConflicts(
        await checkViewingConflicts({ agentId, propertyId, contactId, scheduledAt, durationMin }),
      );
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [agentId, propertyId, contactId, scheduledAt, durationMin]);

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
          {defaultDealId ? <input type="hidden" name="deal_id" value={defaultDealId} /> : null}
          <EntityPicker
            name="property_id"
            kind="property"
            label="Property"
            initial={defaultProperty}
            placeholder="Search reference or title…"
            onChange={(o) => setPropertyId(o?.id ?? null)}
          />
          <EntityPicker
            name="contact_id"
            kind="contact"
            label="Contact"
            initial={defaultContact}
            placeholder="Search name, phone…"
            onChange={(o) => setContactId(o?.id ?? null)}
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
                  {conflicts.length} overlapping viewing{conflicts.length > 1 ? "s" : ""}:
                </p>
                <ul className="mt-1 list-disc pl-4 text-xs">
                  {conflicts.map((c) => (
                    <li key={c.id}>
                      {c.timeLabel}
                      {c.propertyRef ? ` · ${c.propertyRef}` : ""} ·{" "}
                      {c.reason === "agent"
                        ? "agent's diary"
                        : c.reason === "property"
                          ? "same property"
                          : "same buyer"}
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
