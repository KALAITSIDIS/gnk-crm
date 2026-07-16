"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { saveOffer, updateOfferStatus, type OfferActionState } from "@/lib/actions/deals";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { OFFER_TRANSITIONS, type OfferStatus } from "@/lib/validators/deals";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export interface OfferRow {
  id: string;
  amount: string | number;
  status: OfferStatus;
  terms: string | null;
  valid_until: string | null;
  decided_at: string | null;
  created_at: string;
  contact: EntityOption | null;
}

const STATUS_TONES: Record<OfferStatus, string> = {
  submitted: "bg-brand-100 text-brand-700",
  countered: "bg-warning/10 text-warning",
  accepted: "bg-success/10 text-success",
  rejected: "bg-danger/10 text-danger",
  withdrawn: "bg-surface-2 text-text-3",
  expired: "bg-surface-2 text-text-3",
};

const TRANSITION_LABELS: Record<OfferStatus, string> = {
  submitted: "Submitted",
  countered: "Counter",
  accepted: "Accept",
  rejected: "Reject",
  withdrawn: "Withdraw",
  expired: "Expire",
};

const initialState: OfferActionState = { error: null, savedAt: null };

function OfferDialog({
  dealId,
  offer,
  open,
  onOpenChange,
}: {
  dealId: string;
  offer: OfferRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, formAction, pending] = useActionState(saveOffer, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Saved");
      onOpenChange(false);
    }
  }, [state.savedAt, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{offer ? "Edit offer" : "Add offer"}</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="deal_id" value={dealId} />
          {offer ? <input type="hidden" name="offer_id" value={offer.id} /> : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="offer-amount">Amount (€)</Label>
            <Input
              id="offer-amount"
              name="amount"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              required
              defaultValue={offer?.amount ?? ""}
            />
          </div>

          <EntityPicker
            name="contact_id"
            kind="contact"
            label="Offering contact"
            initial={offer?.contact ?? null}
            placeholder="Defaults to the deal buyer"
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="offer-valid-until">Valid until</Label>
            <Input
              id="offer-valid-until"
              name="valid_until"
              type="date"
              defaultValue={offer?.valid_until ?? ""}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="offer-terms">Terms</Label>
            <Textarea
              id="offer-terms"
              name="terms"
              rows={3}
              defaultValue={offer?.terms ?? ""}
              placeholder="Conditions, deposit, timeline…"
            />
          </div>

          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : offer ? "Save offer" : "Add offer"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Offers table + CRUD (T3.2). No hard delete — withdraw (DECISIONS T3.2). */
export function OffersCard({ dealId, offers }: { dealId: string; offers: OfferRow[] }) {
  const [dialogOffer, setDialogOffer] = useState<OfferRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ offer: OfferRow; next: OfferStatus } | null>(null);
  const [isPending, startTransition] = useTransition();

  const runTransition = (offer: OfferRow, next: OfferStatus) => {
    setConfirm(null);
    startTransition(async () => {
      const { wonEligible, error } = await updateOfferStatus(offer.id, next);
      if (error) {
        toast.error(error);
      } else if (wonEligible) {
        toast.success("Offer accepted — deal is now won-eligible", {
          description: "Mark it Won from the guarded flow (arrives with T3.4).",
        });
      } else {
        toast.success(`Offer ${next}`);
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-1">Offers</h2>
        <Button
          size="sm"
          onClick={() => {
            setDialogOffer(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="size-4" /> Add offer
        </Button>
      </div>

      {offers.length === 0 ? (
        <p className="text-sm text-text-3">No offers yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Amount</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Valid until</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {offers.map((offer) => {
              const transitions = OFFER_TRANSITIONS[offer.status];
              return (
                <TableRow key={offer.id}>
                  <TableCell className="font-semibold tabular-nums text-text-1">
                    {formatMoney(offer.amount)}
                  </TableCell>
                  <TableCell className="text-text-2">{offer.contact?.label ?? "—"}</TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        STATUS_TONES[offer.status],
                      )}
                    >
                      {offer.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-text-2">{formatDate(offer.valid_until)}</TableCell>
                  <TableCell className="text-text-2">{formatDateTime(offer.created_at)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {transitions.length === 0 ? (
                        <span className="text-xs text-text-3">
                          decided {formatDate(offer.decided_at)}
                        </span>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-7 p-0"
                            disabled={isPending}
                            onClick={() => {
                              setDialogOffer(offer);
                              setDialogOpen(true);
                            }}
                            aria-label="Edit offer"
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          {transitions.map((next) => (
                            <Button
                              key={next}
                              variant={next === "accepted" ? "default" : "ghost"}
                              size="sm"
                              className="h-7 px-2 text-xs"
                              disabled={isPending}
                              onClick={() => setConfirm({ offer, next })}
                            >
                              {TRANSITION_LABELS[next]}
                            </Button>
                          ))}
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <OfferDialog
        dealId={dealId}
        offer={dialogOffer}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirm ? `${TRANSITION_LABELS[confirm.next]} offer of ${formatMoney(confirm.offer.amount)}?` : ""}
            </DialogTitle>
          </DialogHeader>
          {confirm?.next === "accepted" ? (
            <p className="text-sm text-text-2">
              Accepting makes this deal won-eligible and freezes the offer.
            </p>
          ) : (
            <p className="text-sm text-text-2">This decision is recorded in the event log.</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              disabled={isPending}
              onClick={() => confirm && runTransition(confirm.offer, confirm.next)}
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
