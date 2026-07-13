"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { KeyRound, LogIn, LogOut, Plus } from "lucide-react";
import { toast } from "sonner";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { checkoutKey, registerKey, returnKey, type KeyActionState } from "@/lib/actions/keys";
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

const initialState: KeyActionState = { error: null, savedAt: null };

export function RegisterKeyDialog({
  defaultProperty = null,
}: {
  defaultProperty?: EntityOption | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(registerKey, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Key registered");
      setOpen(false);
    }
  }, [state.savedAt]);

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
            {state.error ? (
              <p role="alert" className="text-sm text-danger">
                {state.error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Register"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function KeyMovementActions({
  keyId,
  status,
}: {
  keyId: string;
  status: string;
}) {
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [outState, outAction, outPending] = useActionState(checkoutKey, initialState);
  const [inState, inAction, inPending] = useActionState(returnKey, initialState);
  const lastOut = useRef<number | null>(null);
  const lastIn = useRef<number | null>(null);

  useEffect(() => {
    if (outState.savedAt && outState.savedAt !== lastOut.current) {
      lastOut.current = outState.savedAt;
      toast.success("Key checked out");
      setCheckoutOpen(false);
    }
  }, [outState.savedAt]);

  useEffect(() => {
    if (inState.savedAt && inState.savedAt !== lastIn.current) {
      lastIn.current = inState.savedAt;
      toast.success("Key returned");
      setReturnOpen(false);
    }
  }, [inState.savedAt]);

  return (
    <div className="flex items-center gap-1.5">
      {status === "in_office" ? (
        <Button size="sm" variant="outline" onClick={() => setCheckoutOpen(true)}>
          <LogOut className="size-4" /> Check out
        </Button>
      ) : null}
      {status === "checked_out" ? (
        <Button size="sm" variant="outline" onClick={() => setReturnOpen(true)}>
          <LogIn className="size-4" /> Return
        </Button>
      ) : null}

      <Dialog open={checkoutOpen} onOpenChange={setCheckoutOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Check out key</DialogTitle>
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
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="out-note">Note</Label>
              <Textarea id="out-note" name="note" rows={2} />
            </div>
            {outState.error ? (
              <p role="alert" className="text-sm text-danger">
                {outState.error}
              </p>
            ) : null}
            <Button type="submit" disabled={outPending}>
              <KeyRound className="size-4" /> {outPending ? "Saving…" : "Check out"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Return key</DialogTitle>
          </DialogHeader>
          <form action={inAction} className="flex flex-col gap-3">
            <input type="hidden" name="key_id" value={keyId} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="in-note">Note</Label>
              <Textarea id="in-note" name="note" rows={2} />
            </div>
            {inState.error ? (
              <p role="alert" className="text-sm text-danger">
                {inState.error}
              </p>
            ) : null}
            <Button type="submit" disabled={inPending}>
              {inPending ? "Saving…" : "Return to office"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
