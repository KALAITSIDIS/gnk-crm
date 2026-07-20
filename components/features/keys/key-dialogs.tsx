"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  Handshake,
  History,
  KeyRound,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import {
  checkoutKey,
  listKeyMovements,
  markLostKey,
  registerKey,
  returnKey,
  transferKey,
  updateKey,
  type KeyActionState,
  type KeyMovementRow,
} from "@/lib/actions/keys";
import type { EntityOption } from "@/lib/actions/entity-search";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/utils/format";

const initialState: KeyActionState = { error: null, savedAt: null };

/** Toast + close the dialog once, when a new save lands. */
function useSaved(state: KeyActionState, message: string, close: () => void) {
  const lastToasted = useRef<number | null>(null);
  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success(message);
      close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.savedAt]);
}

function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  );
}

export function RegisterKeyDialog({
  defaultProperty = null,
}: {
  defaultProperty?: EntityOption | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(registerKey, initialState);
  useSaved(state, "Key registered", () => setOpen(false));

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Register key
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Register key</DialogTitle>
          </DialogHeader>
          <form action={formAction} className="flex flex-col gap-3">
            <EntityPicker
              name="property_id"
              kind="property"
              label="Property"
              initial={defaultProperty}
              placeholder="Search reference…"
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-code">Key code</Label>
              <Input id="key-code" name="key_code" placeholder="e.g. K-014" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-desc">Description</Label>
              <Input id="key-desc" name="description" placeholder="Front door + pool gate" />
            </div>
            <FormError error={state.error} />
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Register"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

const MOVEMENT_LABELS: Record<string, string> = {
  checkout: "Checked out",
  return: "Returned to office",
  transfer: "Handed to owner",
  mark_lost: "Marked lost",
};

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="ghost" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function KeyMovementActions({
  keyId,
  keyCode,
  description,
  status,
  canEdit,
}: {
  keyId: string;
  keyCode: string;
  description: string | null;
  status: string;
  canEdit: boolean;
}) {
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [outState, outAction, outPending] = useActionState(checkoutKey, initialState);
  const [inState, inAction, inPending] = useActionState(returnKey, initialState);
  const [transferState, transferAction, transferPending] = useActionState(
    transferKey,
    initialState,
  );
  const [lostState, lostAction, lostPending] = useActionState(markLostKey, initialState);
  const [editState, editAction, editPending] = useActionState(updateKey, initialState);

  useSaved(outState, "Key checked out", () => setCheckoutOpen(false));
  useSaved(inState, "Key returned", () => setReturnOpen(false));
  useSaved(transferState, "Key handed to owner", () => setTransferOpen(false));
  useSaved(lostState, "Key marked lost", () => setLostOpen(false));
  useSaved(editState, "Key updated", () => setEditOpen(false));

  const [movements, setMovements] = useState<KeyMovementRow[] | null>(null);
  const [historyLoading, startHistory] = useTransition();
  const openHistory = () => {
    setHistoryOpen(true);
    startHistory(async () => {
      setMovements(await listKeyMovements(keyId));
    });
  };

  const isLost = status === "lost";

  return (
    <div className="flex items-center gap-1.5">
      {status === "in_office" ? (
        <Button size="sm" variant="outline" onClick={() => setCheckoutOpen(true)}>
          <LogOut className="size-4" /> Check out
        </Button>
      ) : null}
      {status === "checked_out" || status === "with_owner" ? (
        <Button size="sm" variant="outline" onClick={() => setReturnOpen(true)}>
          <LogIn className="size-4" /> Return
        </Button>
      ) : null}
      {isLost ? (
        <Button size="sm" variant="outline" onClick={() => setReturnOpen(true)}>
          <LogIn className="size-4" /> Recover
        </Button>
      ) : null}

      {status === "in_office" || status === "checked_out" ? (
        <IconAction label="Hand to owner" onClick={() => setTransferOpen(true)}>
          <Handshake className="size-4" />
        </IconAction>
      ) : null}
      {!isLost ? (
        <IconAction label="Mark lost" onClick={() => setLostOpen(true)}>
          <TriangleAlert className="size-4" />
        </IconAction>
      ) : null}
      {canEdit ? (
        <IconAction label="Edit key" onClick={() => setEditOpen(true)}>
          <Pencil className="size-4" />
        </IconAction>
      ) : null}
      <IconAction label="History" onClick={openHistory}>
        <History className="size-4" />
      </IconAction>

      <Dialog open={checkoutOpen} onOpenChange={setCheckoutOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Check out key {keyCode}</DialogTitle>
          </DialogHeader>
          <form action={outAction} className="flex flex-col gap-3">
            <input type="hidden" name="key_id" value={keyId} />
            <EntityPicker
              name="holder_profile_id"
              kind="agent"
              label="Staff holder"
              placeholder="Search staff…"
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="holder-name">…or external holder</Label>
              <Input id="holder-name" name="holder_name" placeholder="e.g. Lawyer A. Georgiou" />
              <p className="text-xs text-text-3">If a staff member is picked, they are the holder.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="out-note">Note</Label>
              <Textarea id="out-note" name="note" rows={2} />
            </div>
            <FormError error={outState.error} />
            <Button type="submit" disabled={outPending}>
              <KeyRound className="size-4" /> {outPending ? "Saving…" : "Check out"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{isLost ? `Recover key ${keyCode}` : `Return key ${keyCode}`}</DialogTitle>
          </DialogHeader>
          <form action={inAction} className="flex flex-col gap-3">
            <input type="hidden" name="key_id" value={keyId} />
            {isLost ? (
              <p className="text-sm text-text-2">
                The key was found — it goes back on the office board.
              </p>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="in-note">Note</Label>
              <Textarea id="in-note" name="note" rows={2} />
            </div>
            <FormError error={inState.error} />
            <Button type="submit" disabled={inPending}>
              {inPending ? "Saving…" : "Return to office"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Hand key {keyCode} to owner</DialogTitle>
          </DialogHeader>
          <form action={transferAction} className="flex flex-col gap-3">
            <input type="hidden" name="key_id" value={keyId} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transfer-holder">Owner name (optional)</Label>
              <Input id="transfer-holder" name="holder_name" placeholder="e.g. M. Ioannou" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transfer-note">Note</Label>
              <Textarea id="transfer-note" name="note" rows={2} />
            </div>
            <FormError error={transferState.error} />
            <Button type="submit" disabled={transferPending}>
              <Handshake className="size-4" /> {transferPending ? "Saving…" : "Hand to owner"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={lostOpen} onOpenChange={setLostOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Mark key {keyCode} lost</DialogTitle>
          </DialogHeader>
          <form action={lostAction} className="flex flex-col gap-3">
            <input type="hidden" name="key_id" value={keyId} />
            <p className="text-sm text-text-2">
              The key is flagged as lost and its last holder stays on record. Use Recover if it
              turns up.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lost-note">Note</Label>
              <Textarea id="lost-note" name="note" rows={2} placeholder="Where it was last seen…" />
            </div>
            <FormError error={lostState.error} />
            <Button type="submit" variant="destructive" disabled={lostPending}>
              <TriangleAlert className="size-4" /> {lostPending ? "Saving…" : "Mark lost"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit key {keyCode}</DialogTitle>
          </DialogHeader>
          <form action={editAction} className="flex flex-col gap-3">
            <input type="hidden" name="key_id" value={keyId} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-code">Key code</Label>
              <Input id="edit-code" name="key_code" defaultValue={keyCode} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-desc">Description</Label>
              <Input id="edit-desc" name="description" defaultValue={description ?? ""} />
            </div>
            <FormError error={editState.error} />
            <Button type="submit" disabled={editPending}>
              {editPending ? "Saving…" : "Save"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Key {keyCode} — movements</DialogTitle>
          </DialogHeader>
          {historyLoading || movements === null ? (
            <p className="text-sm text-text-3">Loading…</p>
          ) : movements.length === 0 ? (
            <p className="text-sm text-text-3">No movements yet.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto">
              {movements.map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                  <span className="min-w-0 text-text-1">
                    {MOVEMENT_LABELS[m.action] ?? m.action.replace(/_/g, " ")}
                    {m.holderName ? ` — ${m.holderName}` : ""}
                    <span className="ml-1.5 text-xs text-text-3">by {m.actorName ?? "—"}</span>
                    {m.note ? <span className="block text-xs text-text-3">{m.note}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-text-3">
                    {formatDateTime(m.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
