"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { PhoneCall } from "lucide-react";
import { toast } from "sonner";
import { logDealContact, type DealSectionState } from "@/lib/actions/deals";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { COMM_CHANNELS } from "@/lib/validators/contacts";

const initialState: DealSectionState = { error: null, savedAt: null };

const CHANNEL_LABELS: Record<(typeof COMM_CHANNELS)[number], string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  phone: "Phone",
  email: "Email",
  sms: "SMS",
  in_person: "In person",
  other: "Other",
};

/**
 * "I spoke to the buyer" — the only thing that silences the 14-day no-contact
 * nudge (migration 0025).
 *
 * It is a dialog rather than a one-tap button on purpose: the channel is what
 * makes the record worth anything later, and a single click would recreate the
 * problem this fixes, where contact is asserted without anyone saying so.
 */
export function LogDealContact({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(logDealContact, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Contact logged");
      setOpen(false);
    }
  }, [state.savedAt]);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <PhoneCall className="size-4" /> Log contact
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log contact</DialogTitle>
          </DialogHeader>
          <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="deal_id" value={dealId} />

            <div className="flex flex-col gap-2">
              <Label htmlFor="log-contact-channel">How did you make contact?</Label>
              <select
                id="log-contact-channel"
                name="channel"
                defaultValue="phone"
                required
                className="h-9 rounded-[8px] border border-border bg-surface px-3 text-sm text-text-1"
              >
                {COMM_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="log-contact-note">Note (optional)</Label>
              <Textarea
                id="log-contact-note"
                name="note"
                rows={3}
                maxLength={2000}
                placeholder="What was discussed?"
              />
            </div>

            <p className="text-sm text-text-2">
              This resets the 14-day follow-up clock and closes any open chase-up for
              this deal. Editing the deal does not.
            </p>

            {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Log contact"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
