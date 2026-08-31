"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { PhoneCall } from "lucide-react";
import { toast } from "sonner";
import { logContactConversation, type ContactSectionState } from "@/lib/actions/contacts";
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

const initialState: ContactSectionState = { error: null, savedAt: null };

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
 * DB-11a: the contact-level "I spoke to them" (cloned from the deal dialog —
 * same reasoning: the channel is what makes the record worth anything later,
 * so it is a dialog, never a one-tap assertion). Unlike the deal version it
 * moves NO clock and silences NO nudge — it is a dated record on the
 * contact's activity trail, which owners and past buyers never had.
 */
export function LogContactConversation({ contactId }: { contactId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(logContactConversation, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Conversation logged");
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
            <input type="hidden" name="contact_id" value={contactId} />

            <div className="flex flex-col gap-2">
              <Label htmlFor="log-contact-conv-channel">How did you make contact?</Label>
              <select
                id="log-contact-conv-channel"
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
              <Label htmlFor="log-contact-conv-note">Note (optional)</Label>
              <Textarea
                id="log-contact-conv-note"
                name="note"
                rows={3}
                maxLength={2000}
                placeholder="What was discussed?"
              />
            </div>

            <p className="text-sm text-text-2">
              This adds a dated record to the contact&apos;s activity trail. It does not touch
              any deal&apos;s follow-up clock.
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
