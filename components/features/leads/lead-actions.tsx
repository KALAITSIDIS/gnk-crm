"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { ArrowRightCircle, Check, Hand, MessageSquarePlus, Phone, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  claimLead,
  closeLead,
  convertLead,
  logConversation,
  markCalled,
  markContacted,
  type LeadActionState,
} from "@/lib/actions/leads";
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
import { Textarea } from "@/components/ui/textarea";
import { COMM_CHANNELS } from "@/lib/validators/contacts";

const initialState: LeadActionState = { error: null, savedAt: null };

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function LeadRowActions({
  leadId,
  isMine,
  isUnassigned,
  isOpen,
  hasResponse,
  hasContact,
}: {
  leadId: string;
  isMine: boolean;
  isUnassigned: boolean;
  isOpen: boolean;
  hasResponse: boolean;
  hasContact: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const act = (fn: () => Promise<void>, success: string) =>
    startTransition(async () => {
      try {
        await fn();
        toast.success(success);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Action failed");
      }
    });

  if (!isOpen) return null;

  return (
    <div className="flex items-center gap-1">
      {isUnassigned ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={isPending}
          onClick={() => act(() => claimLead(leadId), "Lead claimed")}
        >
          <Hand className="size-3.5" /> Claim
        </Button>
      ) : null}
      {(isMine || isUnassigned) && !hasResponse ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={isPending}
          onClick={() => act(() => markContacted(leadId), "Marked contacted")}
          title="Stamps first response time"
        >
          <Check className="size-3.5" /> Contacted
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={isPending}
        onClick={() => act(() => markCalled(leadId), "Call logged")}
      >
        <Phone className="size-3.5" /> Called
      </Button>
      <LogConversationDialog leadId={leadId} />
      <ConvertLeadDialog leadId={leadId} hasContact={hasContact} />
      <CloseLeadDialog leadId={leadId} />
    </div>
  );
}

const DEAL_TYPES = ["sale", "rental", "antiparoxi", "advisory"] as const;

export function ConvertLeadDialog({
  leadId,
  hasContact,
}: {
  leadId: string;
  hasContact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(convertLead, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Lead converted to deal");
      setOpen(false);
    }
  }, [state.savedAt]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="default"
          size="sm"
          className="h-7 text-xs"
          title={hasContact ? "Create a deal from this lead" : "Link a contact first"}
        >
          <ArrowRightCircle className="size-3.5" /> Convert
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Convert to deal</DialogTitle>
        </DialogHeader>
        {!hasContact ? (
          <p className="text-sm text-warning">
            This lead has no contact linked — link or create the contact first.
          </p>
        ) : null}
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="lead_id" value={leadId} />
          <div className="flex flex-col gap-1.5">
            <Label>Deal type</Label>
            <Select name="deal_type" defaultValue="sale">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEAL_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {labelize(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending || !hasContact}>
            {pending ? "Converting…" : "Create deal at first stage"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LogConversationDialog({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(logConversation, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Conversation logged");
      setOpen(false);
    }
  }, [state.savedAt]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs">
          <MessageSquarePlus className="size-3.5" /> Log
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Log conversation</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="lead_id" value={leadId} />
          <div className="flex flex-col gap-1.5">
            <Label>Channel</Label>
            <Select name="channel" defaultValue="phone">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMM_CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {labelize(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`note-${leadId}`}>Note</Label>
            <Textarea id={`note-${leadId}`} name="note" rows={3} required />
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Log conversation"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CloseLeadDialog({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<"lost" | "spam">("lost");
  const [state, formAction, pending] = useActionState(closeLead, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Lead closed");
      setOpen(false);
    }
  }, [state.savedAt]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 text-xs text-text-3">
          <XCircle className="size-3.5" /> Close
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Close lead</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="lead_id" value={leadId} />
          <input type="hidden" name="outcome" value={outcome} />
          <div className="flex gap-2">
            <Button
              type="button"
              variant={outcome === "lost" ? "default" : "outline"}
              size="sm"
              onClick={() => setOutcome("lost")}
            >
              Lost
            </Button>
            <Button
              type="button"
              variant={outcome === "spam" ? "default" : "outline"}
              size="sm"
              onClick={() => setOutcome("spam")}
            >
              Spam
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`reason-${leadId}`}>
              Reason {outcome === "lost" ? "(required)" : "(optional)"}
            </Label>
            <Input id={`reason-${leadId}`} name="reason" />
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} variant="destructive">
            {pending ? "Closing…" : `Mark ${outcome}`}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
