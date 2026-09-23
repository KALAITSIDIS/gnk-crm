"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRightCircle,
  Check,
  Eraser,
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
  createContactFromEnquiry,
  linkLeadContact,
  logConversation,
  markCalled,
  markContacted,
  reassignLead,
  redactLead,
  type LeadActionState,
} from "@/lib/actions/leads";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import type { EntityOption } from "@/lib/actions/entity-search";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
  isRedacted,
  source,
  mayLink,
  suggestion = null,
}: {
  leadId: string;
  isMine: boolean;
  isUnassigned: boolean;
  isOpen: boolean;
  hasResponse: boolean;
  hasContact: boolean;
  isAdmin: boolean;
  status: string;
  isRedacted: boolean;
  /** `website` leads carry the person in their message — one click makes the contact (0098) */
  source: string;
  /**
   * `leads_update` in the app's words (mayLinkLeadContact): an admin, or an
   * agent on their own or an unassigned lead. A listing manager may write no
   * lead, so is offered neither Link contact nor Create contact — the second
   * used to create the contact and then fail the link, leaving an orphan.
   */
  mayLink: boolean;
  /**
   * The row's "Possible existing contact" state (T-enquiry-contact-
   * suggestions). While it lists candidates, "Create contact" is not offered:
   * the dedup check refuses a contact whose phone or e-mail an active contact
   * already holds, so it could only end in the match the row already shows —
   * Review and link is the way forward. Nor when the header could not be read:
   * Create contact reads the same header and could only fail.
   */
  suggestion?: string | null;
}) {
  const [isPending, startTransition] = useTransition();
  // Audit CRM-06: eight buttons wrapped to three rows on a phone, with the
  // two that matter on the move — Called and Log — lost among six that do
  // not. Below the tablet breakpoint the secondary actions sit behind "More".
  const [more, setMore] = useState(false);
  const act = (fn: () => Promise<void>, success: string) =>
    startTransition(async () => {
      try {
        await fn();
        toast.success(success);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Action failed");
      }
    });

  // Article 17 for an enquiry nobody has linked: a linked lead is erased
  // through its contact. Offered on closed leads too — a spam or lost
  // enquiry still holds the person's details.
  const redact =
    isAdmin && !hasContact && !isRedacted ? (
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={isPending}
        title="Replaces the person's message and contact details. Cannot be undone."
        onClick={() => {
          if (
            !confirm(
              "Redact this enquiry? The person's message and contact details are replaced and cannot be recovered.",
            )
          )
            return;
          act(() => redactLead(leadId), "Enquiry redacted");
        }}
      >
        <Eraser className="size-3.5" /> Redact
      </Button>
    ) : null;

  // Closed leads carry no forward actions, but an admin can still reopen a
  // lost/spam lead that was closed by mistake — and redact it.
  if (!isOpen) {
    const correct =
      isAdmin && (status === "lost" || status === "spam") ? (
        <CorrectLeadDialog leadId={leadId} canReopen canReset={false} />
      ) : null;
    if (!correct && !redact) return null;
    return (
      <div className="flex items-center gap-1">
        {correct}
        {redact}
      </div>
    );
  }

  // Doc 04 lockdown, mirrored in the UI: only the assigned agent, an admin, or
  // anyone on an unassigned lead may work it. Rendering the buttons for other
  // agents produced silent no-op updates with bogus success toasts (audit fix).
  const canWork = isMine || isUnassigned || isAdmin;
  const canLinkContact = !hasContact && mayLink && !isRedacted;

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
      {canWork && !hasResponse ? (
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
      {canWork ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={isPending}
          onClick={() => act(() => markCalled(leadId), "Call logged")}
        >
          <Phone className="size-3.5" /> Called
        </Button>
      ) : null}
      {canWork ? <LogConversationDialog leadId={leadId} /> : null}
      {canLinkContact && source === "website" && suggestion !== "matches" && suggestion !== "unreadable" ? (
        <CreateContactFromEnquiryButton leadId={leadId} />
      ) : null}
      {canWork ? <ConvertLeadDialog leadId={leadId} hasContact={hasContact} /> : null}
      <div className={cn("contents", !more && "max-md:hidden")}>
        {canLinkContact ? <LinkContactDialog leadId={leadId} /> : null}
        {isAdmin ? <ReassignDialog leadId={leadId} /> : null}
        {isAdmin && hasResponse ? (
          <CorrectLeadDialog leadId={leadId} canReopen={false} canReset />
        ) : null}
        {canWork ? <CloseLeadDialog leadId={leadId} /> : null}
        {redact}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 text-xs md:hidden"
        aria-expanded={more}
        onClick={() => setMore((v) => !v)}
      >
        {more ? "Less" : "More…"}
      </Button>
    </div>
  );
}

/**
 * "Create contact" for a website enquiry (0098, audit LR-08): the name,
 * e-mail and phone in the message become the contact, the lead is linked, and
 * a buyer's brief becomes a saved search — the three screens the desk used to
 * walk. Dedup applies: a match on phone or e-mail creates nothing.
 *
 * On a match it used to become a one-click "Link <name> instead" for the FIRST
 * contact the dedup check found — phone before e-mail — so when the phone and
 * the e-mail belonged to two different contacts one was picked silently. The
 * row's "Possible existing contact" panel now lists every candidate before
 * anyone clicks (T-enquiry-contact-suggestions), and this button is not shown
 * while it does; a match found here means one appeared after the page was
 * drawn, so the inbox is refreshed to show it there, with the evidence.
 */
function CreateContactFromEnquiryButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const create = () =>
    startTransition(async () => {
      try {
        const r = await createContactFromEnquiry(leadId);
        if (r.duplicate) {
          toast.error(`${r.error ?? "A matching contact already exists."} Review the match on this enquiry.`);
          router.refresh();
          return;
        }
        if (r.error) {
          toast.error(r.error);
          return;
        }
        toast.success("Contact created and linked");
        if (r.note) toast.warning(r.note);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Action failed");
      }
    });

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 text-xs"
      disabled={pending}
      title="Make the contact from the enquiry's name, e-mail and phone, link it, and save the brief as a search. Dedup applies."
      onClick={create}
    >
      <UserPlus className="size-3.5" /> {pending ? "Creating…" : "Create contact"}
    </Button>
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
        // a result, not a throw: the refusals are sentences the desk must read
        const r = await linkLeadContact(leadId, contactId);
        if (r.error) {
          toast.error(r.error);
          return;
        }
        toast.success(r.alreadyLinked ? "Already linked to that contact" : "Contact linked");
        if (r.warning) toast.warning(r.warning);
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

/*
 * The three form dialogs below keep their useActionState inside an inner
 * *Form component that only mounts while the dialog is open — closing and
 * reopening starts from a clean slate instead of showing a stale error from
 * the previous attempt (audit fix).
 */

export function ConvertLeadDialog({
  leadId,
  hasContact,
}: {
  leadId: string;
  hasContact: boolean;
}) {
  const [open, setOpen] = useState(false);

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
        {open ? (
          <ConvertLeadForm leadId={leadId} hasContact={hasContact} onDone={() => setOpen(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ConvertLeadForm({
  leadId,
  hasContact,
  onDone,
}: {
  leadId: string;
  hasContact: boolean;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(convertLead, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Lead converted to deal");
      onDone();
    }
  }, [state.savedAt, onDone]);

  return (
    <>
      {!hasContact ? (
        <p className="text-sm text-warning">
          This lead has no contact linked — link or create the contact first.
        </p>
      ) : null}
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="lead_id" value={leadId} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="convert-deal-type">Deal type</Label>
          <Select name="deal_type" defaultValue="sale">
            <SelectTrigger id="convert-deal-type">
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
    </>
  );
}

export function LogConversationDialog({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);

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
        {open ? <LogConversationForm leadId={leadId} onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LogConversationForm({ leadId, onDone }: { leadId: string; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(logConversation, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Conversation logged");
      onDone();
    }
  }, [state.savedAt, onDone]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="lead_id" value={leadId} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="log-channel">Channel</Label>
        <Select name="channel" defaultValue="phone">
          <SelectTrigger id="log-channel">
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
  );
}

export function CloseLeadDialog({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);

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
        {open ? <CloseLeadForm leadId={leadId} onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CloseLeadForm({ leadId, onDone }: { leadId: string; onDone: () => void }) {
  const [outcome, setOutcome] = useState<"lost" | "spam">("lost");
  const [state, formAction, pending] = useActionState(closeLead, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Lead closed");
      onDone();
    }
  }, [state.savedAt, onDone]);

  return (
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
  );
}
