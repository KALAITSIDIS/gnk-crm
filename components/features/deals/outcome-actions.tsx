"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Trophy, XCircle } from "lucide-react";
import { toast } from "sonner";
import { markDealLost, markDealWon, type DealSectionState } from "@/lib/actions/deals";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const initialState: DealSectionState = { error: null, savedAt: null };

function WonDialog({
  dealId,
  wonEligible,
  isAdmin,
  open,
  onOpenChange,
}: {
  dealId: string;
  wonEligible: boolean;
  isAdmin: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, formAction, pending] = useActionState(markDealWon, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Deal marked won");
      onOpenChange(false);
    }
  }, [state.savedAt, onOpenChange]);

  const blocked = !wonEligible && !isAdmin;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark deal won</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="deal_id" value={dealId} />
          {wonEligible ? (
            <p className="text-sm text-text-2">
              This deal has an accepted offer. Marking it won stamps the date and moves it to
              the Won stage.
            </p>
          ) : (
            <p className="text-sm text-text-2">
              This deal has <span className="font-medium text-text-1">no accepted offer</span>.
              {blocked
                ? " Record and accept an offer first, or ask an admin to override."
                : " Won normally requires one — as admin you can override; the override is logged."}
            </p>
          )}
          {!wonEligible && isAdmin ? (
            <label className="flex items-center gap-2 text-sm text-text-1">
              <Checkbox name="override" />
              Admin override — mark won without an accepted offer
            </label>
          ) : null}
          {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || blocked}>
              {pending ? "Saving…" : "Mark won"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LostDialog({
  dealId,
  open,
  onOpenChange,
}: {
  dealId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, formAction, pending] = useActionState(markDealLost, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Deal marked lost");
      onOpenChange(false);
    }
  }, [state.savedAt, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark deal lost</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="deal_id" value={dealId} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lost_reason">Reason (required)</Label>
            <Textarea
              id="lost_reason"
              name="lost_reason"
              rows={3}
              required
              placeholder="Why was this deal lost?"
            />
          </div>
          {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Saving…" : "Mark lost"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Won/lost entry points for an open deal — the only path to a closed status. */
export function DealOutcomeActions({
  dealId,
  wonEligible,
  isAdmin,
}: {
  dealId: string;
  wonEligible: boolean;
  isAdmin: boolean;
}) {
  const [wonOpen, setWonOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={() => setWonOpen(true)}>
        <Trophy className="size-4" /> Mark won
      </Button>
      <Button size="sm" variant="outline" onClick={() => setLostOpen(true)}>
        <XCircle className="size-4" /> Mark lost
      </Button>
      <WonDialog
        dealId={dealId}
        wonEligible={wonEligible}
        isAdmin={isAdmin}
        open={wonOpen}
        onOpenChange={setWonOpen}
      />
      <LostDialog dealId={dealId} open={lostOpen} onOpenChange={setLostOpen} />
    </div>
  );
}
