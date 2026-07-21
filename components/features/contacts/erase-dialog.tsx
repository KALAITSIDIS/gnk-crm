"use client";

import { useState, useTransition } from "react";
import { ShieldX } from "lucide-react";
import { toast } from "sonner";
import { eraseContactPersonalData } from "@/lib/actions/contact-erasure";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * GDPR Art.17 erasure. Irreversible, so the confirmation is a typed name
 * rather than a single click, and the dialog states plainly what survives —
 * the operator needs that answer ready if the data subject asks.
 */
export function EraseContactDialog({
  contactId,
  contactName,
}: {
  contactId: string;
  contactName: string;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, startTransition] = useTransition();

  const matches = typed.trim() === contactName.trim();

  const run = () => {
    if (!matches) return;
    startTransition(async () => {
      const { error } = await eraseContactPersonalData(contactId, typed);
      if (error) {
        toast.error(error);
        return;
      }
      toast.success("Personal data erased");
      setOpen(false);
      setTyped("");
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped("");
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="text-danger">
          <ShieldX className="size-4" /> Erase personal data
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Erase personal data for {contactName}</DialogTitle>
          <DialogDescription>
            This cannot be undone. It fulfils a GDPR Article 17 erasure request.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <div>
            <p className="font-medium text-text-1">What is erased</p>
            <p className="text-text-2">
              Notes, psychology profile, preferences, source detail, Telegram handle, extra
              phone numbers, nationality, languages, banking readiness and marketing consent.
              The contact is archived and set to Inactive so it can never appear in a
              marketing or hot-buyer list again. Their own words in lead enquiries are
              replaced with a marker.
            </p>
          </div>
          <div>
            <p className="font-medium text-text-1">What is kept, and why</p>
            <p className="text-text-2">
              Name, phone and email stay, so past transactions remain readable. Signed
              viewing slips, the event log and generated evidence reports are never altered —
              they are the evidence behind your commission, and the log is tamper-evident by
              design. If this contact ever transacted, their KYC documents are kept for five
              years to satisfy the AML record-keeping duty; otherwise the documents and files
              are destroyed now.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="erase-confirm">
              Type <span className="font-semibold text-text-1">{contactName}</span> to confirm
            </Label>
            <Input
              id="erase-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches) run();
              }}
              placeholder={contactName}
              autoComplete="off"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-danger"
            disabled={!matches || pending}
            onClick={run}
          >
            {pending ? "Erasing…" : "Erase permanently"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
