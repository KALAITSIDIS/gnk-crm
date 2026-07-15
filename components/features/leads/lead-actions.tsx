"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  ArrowRightCircle,
  Check,
  Hand,
  MessageSquarePlus,
  Phone,
  RotateCcw,
  UserCog,
  UserPlus,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  claimLead,
  closeLead,
  convertLead,
  correctLead,
  linkLeadContact,
  logConversation,
  markCalled,
  markContacted,
  reassignLead,
  type LeadActionState,
} from "@/lib/actions/leads";
import { EntityPicker } from "@/components/features/shared/entity-picker";
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
  isAdmin,
  status,
}: {
  leadId: string;
  isMine: boolean;
  isUnassigned: boolean;
  isOpen: boolean;
  hasResponse: boolean;
  hasContact: boolean;
  isAdmin: boolean;
  status: string;
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

  // Closed leads carry no forward actions, but an admin can still reopen a
  // lost/spam lead that was closed by mistake.
  if (!isOpen) {
    if (isAdmin && (status === "lost" || status === "spam")) {
      return (
        <div className="flex items-center gap-1">
          <CorrectLeadDialog leadId={leadId} canReopen canReset={false} />
        </div>
      );
    }
    return null;
  }

  const canLinkContact = !hasContact && (isMine || isUnassigned || isAdmin);

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
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
      {canLinkContact ? <LinkContactDialog leadId={leadId} /> : null}
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
      {isAdmin ? <ReassignDialog leadId={leadId} /> : null}
      {isAdmin && hasResponse ? (
        <CorrectLeadDialog leadId={leadId} canReopen={false} canReset />
      ) : null}
      <CloseLeadDialog leadId={leadId} />
    </div>
  );
}

export function LinkContactDialog({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<EntityOption | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    if (!selected) return;
    const contactId = selected.id;
    startTransition(async () => {
      try {
        await linkLeadContact(leadId, contactId);
        toast.success("Contact linked");
        setOpen(false);
        setSelected(null);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Link failed");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          title="Link a contact to this lead"
        >
          <UserPlus className="size-3.5" /> Link contact
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Link contact</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <EntityPicker
            name="contact_id"
            kind="contact"
            label="Contact"
            placeholder="Search name, phone, email…"
            onChange={setSelected}
          />
          <p className="text-xs text-text-3">
            No match? Create the person under Contacts first, then link them here.
          </p>
          <Button onClick={save} disabled={pending || !selected}>
            {pending ? "Linking…" : "Link contact"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ReassignDialog({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<EntityOption | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    if (!selected) return;
    const agentId = selected.id;
    startTransition(async () => {
      try {
        await reassignLead(leadId, agentId);
        toast.success("Lead reassigned");
        setOpen(false);
        setSelected(null);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Reassign failed");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          title="Assign this lead to another agent"
        >
          <UserCog className="size-3.5" /> Assign
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Reassign lead</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <EntityPicker
            name="agent_id"
            kind="agent"
            label="Assign to"
            placeholder="Search agent…"
            onChange={setSelected}
          />
          <Button onClick={save} disabled={pending || !selected}>
            {pending ? "Reassigning…" : "Reassign"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CorrectLeadDialog({
  leadId,
  canReopen,
  canReset,
}: {
  leadId: string;
  canReopen: boolean;
  canReset: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [resetResponse, setResetResponse] = useState(false);
  const [pending, startTransition] = useTransition();

  const reopenOnly = canReopen && !canReset;

  const save = () => {
    // reopen-only trigger implies intent; otherwise the checkbox drives it
    const doReopen = canReopen && (reopenOnly || reopen);
    const doReset = canReset && resetResponse;
    if (!doReopen && !doReset) {
      toast.error("Pick at least one correction.");
      return;
    }
    startTransition(async () => {
      try {
        await correctLead(leadId, { reopen: doReopen, resetResponse: doReset });
        toast.success("Lead corrected");
        setOpen(false);
        setReopen(false);
        setResetResponse(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Correction failed");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-text-3"
          title={reopenOnly ? "Reopen this closed lead" : "Correct a mis-click on this lead"}
        >
          <RotateCcw className="size-3.5" /> {reopenOnly ? "Reopen" : "Correct"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{reopenOnly ? "Reopen lead" : "Correct lead"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {reopenOnly ? (
            <p className="text-sm text-text-2">
              Reopen this lead — clears the lost/spam status and returns it to the inbox.
            </p>
          ) : (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={resetResponse}
                onChange={(e) => setResetResponse(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Reset first-response timer{" "}
                <span className="text-text-3">
                  — undoes the contacted/called stamps; the lead re-enters the awaiting-first-response
                  queue. Adjusts the response-time KPI.
                </span>
              </span>
            </label>
          )}
          <Button
            onClick={save}
            disabled={pending || (!reopenOnly && !resetResponse)}
            variant={reopenOnly ? "default" : "destructive"}
          >
            {pending ? "Saving…" : reopenOnly ? "Reopen lead" : "Apply correction"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
