"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Trophy, XCircle } from "lucide-react";
import { toast } from "sonner";
import { markDealLost, markDealWon, type DealSectionState } from "@/lib/actions/deals";
import { unconfirmedCloseText } from "@/lib/validators/deals";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const initialState: DealSectionState = { error: null, savedAt: null };

/** A toast the user must read even though the dialog that said it is gone. */
const UNTIL_DISMISSED = { duration: Infinity, closeButton: true } as const;

/**
 * Submits a Won/Lost form and reports the answer. NOT useActionState plus an
 * effect: a close revalidates the deal page, and the page renders these
 * dialogs only while the deal is OPEN — so the refreshed page unmounts them,
 * and an effect keyed on the new state never runs. The success toast never
 * showed, and a refusal that arrives with a refresh (the other outcome
 * committed first) would vanish with its dialog. Everything the user must see
 * is therefore said from the transition itself, through the layout's toaster,
 * which survives the unmount (the review-and-link-dialog pattern); a refusal
 * is ALSO kept inline for as long as the dialog is still there.
 *
 * WHAT STAYS UNTIL DISMISSED: everything that arrives with a refresh of the
 * page (`pageRefreshed`: a conflict, a repeat, an unknown result) or with no
 * answer at all — if the deal is now closed the dialog is gone, and some of
 * these carry an instruction ("check the listing status and any live hold
 * yourself") that is the only notice of a missing reminder. A plain refusal
 * (a form rule) keeps the default toast: the dialog is still open and holds it.
 *
 * onSubmit, not a form `action`: React 19 resets an uncontrolled form after an
 * action settles, which would wipe a typed reason on a refusal.
 */
function useCloseSubmit(
  action: (prev: DealSectionState, formData: FormData) => Promise<DealSectionState>,
  outcome: "won" | "lost",
  successText: string,
  onClosed: () => void,
) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      let state: DealSectionState;
      try {
        state = await action(initialState, formData);
      } catch {
        // the request never came back: it may not have reached the database —
        // or the server died AFTER the close committed, before a Won's reminders
        // ran. Never guess, and say what to check (the server's own words for an
        // unknown answer — one shared text).
        const text = unconfirmedCloseText(outcome);
        setError(text);
        toast.error(text, UNTIL_DISMISSED);
        router.refresh();
        return;
      }
      if (state.error) {
        setError(state.error);
        if (state.pageRefreshed) toast.error(state.error, UNTIL_DISMISSED);
        else toast.error(state.error);
        return;
      }
      if (state.savedAt) {
        if (state.alreadyClosed) {
          // a repeat that found the deal already closed: not a fresh success
          toast.info(state.notice ?? "Nothing was changed.", UNTIL_DISMISSED);
        } else if (state.notice) {
          // closed, with something the user must still do — it stays until
          // dismissed, because the dialog that could have held it is gone
          toast.warning(state.notice, UNTIL_DISMISSED);
        } else {
          toast.success(successText);
        }
        onClosed();
      }
    });
  };

  return { onSubmit, pending, error, clearError: () => setError(null) };
}

function WonDialog({
  dealId,
  wonEligible,
  isAdmin,
  acceptedAmount,
  open,
  onOpenChange,
}: {
  dealId: string;
  wonEligible: boolean;
  isAdmin: boolean;
  acceptedAmount: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { onSubmit, pending, error, clearError } = useCloseSubmit(
    markDealWon,
    "won",
    "Deal marked won",
    () => onOpenChange(false),
  );
  const changeOpen = (next: boolean) => {
    if (pending) return;
    // cleared on CLOSE: the dialog is opened by a plain button, so Radix never
    // calls this with true — and a refusal must not greet the next attempt
    if (!next) clearError();
    onOpenChange(next);
  };

  const blocked = !wonEligible && !isAdmin;

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark deal won</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
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
          {/* WF-2: the CONFIRMED price — defaulted from the accepted offer,
              editable when the closing figure differs; reports read it for
              won deals instead of the pipeline estimate */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="won-final-value">Final value (€)</Label>
            <Input
              id="won-final-value"
              name="final_value"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              defaultValue={acceptedAmount ?? undefined}
              placeholder={acceptedAmount ? undefined : "Confirmed sale / rental value"}
            />
            <p className="text-xs text-text-3">
              {acceptedAmount
                ? "Prefilled from the accepted offer — adjust if the closing figure differed."
                : "Optional — reports fall back to the expected value when left blank."}
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => changeOpen(false)}>
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
  const { onSubmit, pending, error, clearError } = useCloseSubmit(
    markDealLost,
    "lost",
    "Deal marked lost",
    () => onOpenChange(false),
  );
  const changeOpen = (next: boolean) => {
    if (pending) return;
    // cleared on CLOSE: the dialog is opened by a plain button, so Radix never
    // calls this with true — and a refusal must not greet the next attempt
    if (!next) clearError();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark deal lost</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
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
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => changeOpen(false)}>
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
  acceptedAmount = null,
}: {
  dealId: string;
  wonEligible: boolean;
  isAdmin: boolean;
  acceptedAmount?: number | null;
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
        acceptedAmount={acceptedAmount}
        open={wonOpen}
        onOpenChange={setWonOpen}
      />
      <LostDialog dealId={dealId} open={lostOpen} onOpenChange={setLostOpen} />
    </div>
  );
}
