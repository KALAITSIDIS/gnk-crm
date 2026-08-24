"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Plus, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  applyPaymentPlan,
  clearSchedule,
  markInstallment,
  setInstallmentDue,
} from "@/lib/actions/reservation-schedule";
import { outstanding } from "@/lib/services/payment-schedule";
import { cn } from "@/lib/utils";
import { formatDate, formatMoney } from "@/lib/utils/format";

/**
 * A reservation's payment schedule (0050).
 *
 * The amounts here are FROZEN — worked out from the price when the plan was
 * applied — so the card shows what the buyer was quoted, not what today's price
 * would produce. That is the whole reason they are stored.
 */

export interface InstallmentRow {
  id: string;
  sort_order: number;
  label: string;
  pct: number | null;
  amount: number;
  milestone: string | null;
  due_date: string | null;
  paid_at: string | null;
  paid_amount: number | null;
  note: string | null;
}

export interface PlanOption {
  id: string;
  name: string;
  installmentCount: number;
}

const initial = { error: null as string | null, savedAt: null as number | null };

function useToasted(state: { error: string | null; savedAt: number | null }, ok?: string) {
  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);
  useEffect(() => {
    if (state.savedAt && ok) toast.success(ok);
  }, [state.savedAt, ok]);
}

function MarkPaidForm({ line }: { line: InstallmentRow }) {
  const [state, formAction, pending] = useActionState(markInstallment, initial);
  useToasted(state);
  const isPaid = line.paid_at !== null;

  if (isPaid) {
    return (
      <form action={formAction} className="flex items-center gap-2">
        <input type="hidden" name="installment_id" value={line.id} />
        <input type="hidden" name="paid" value="off" />
        <Button type="submit" variant="ghost" size="sm" disabled={pending}>
          <Undo2 className="size-3.5" /> {pending ? "…" : "Un-mark"}
        </Button>
      </form>
    );
  }

  return (
    <form action={formAction} className="flex items-end gap-2">
      <input type="hidden" name="installment_id" value={line.id} />
      <input type="hidden" name="paid" value="on" />
      <div className="flex flex-col gap-1">
        <Label htmlFor={`paid-${line.id}`} className="text-xs">
          Amount received
        </Label>
        {/* pre-filled with what is due, because that is what usually arrives —
            but editable, because a part payment is a real thing */}
        <Input
          id={`paid-${line.id}`}
          name="paid_amount"
          type="number"
          min="0"
          step="0.01"
          defaultValue={line.amount}
          className="h-9 w-32"
        />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        <Check className="size-3.5" /> {pending ? "…" : "Mark paid"}
      </Button>
    </form>
  );
}

function DueDateForm({ line }: { line: InstallmentRow }) {
  const [state, formAction, pending] = useActionState(setInstallmentDue, initial);
  useToasted(state);
  return (
    <form action={formAction} className="flex items-center gap-1">
      <input type="hidden" name="installment_id" value={line.id} />
      <Input
        name="due_date"
        type="date"
        defaultValue={line.due_date ?? ""}
        className="h-8 w-36"
        aria-label={`Due date for ${line.label}`}
      />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "…" : "Set"}
      </Button>
    </form>
  );
}

export function PaymentScheduleCard({
  reservationId,
  lines,
  plans,
  canEdit,
  askingPrice,
}: {
  reservationId: string;
  lines: InstallmentRow[];
  plans: PlanOption[];
  canEdit: boolean;
  askingPrice: number | null;
}) {
  const [choosing, setChoosing] = useState(false);
  const [applyState, applyAction, applying] = useActionState(applyPaymentPlan, initial);
  const [clearState, clearAction, clearing] = useActionState(clearSchedule, initial);
  useToasted(applyState, "Schedule applied");
  useToasted(clearState, "Schedule removed");

  const sorted = [...lines].sort((a, b) => a.sort_order - b.sort_order);
  const totals = outstanding(sorted.map((l) => ({ amount: l.amount, paidAmount: l.paid_amount })));
  const scheduleTotal = sorted.reduce((s, l) => s + l.amount, 0);

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {plans.length === 0 ? (
          <p className="text-sm text-text-2">
            This project has no payment plans yet — add one on its units page, then it can be
            applied here.
          </p>
        ) : askingPrice === null ? (
          <p className="text-sm text-text-2">
            This property has no asking price, so a schedule cannot be worked out yet.
          </p>
        ) : (
          <p className="text-sm text-text-2">No payment schedule on this hold.</p>
        )}

        {canEdit && plans.length > 0 && askingPrice !== null ? (
          choosing ? (
            <form action={applyAction} className="flex items-end gap-2">
              <input type="hidden" name="reservation_id" value={reservationId} />
              <div className="flex flex-col gap-2">
                <Label htmlFor="plan-pick">Payment plan</Label>
                <Select name="payment_plan_id" defaultValue={plans[0]!.id}>
                  <SelectTrigger id="plan-pick" className="w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {plans.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.installmentCount})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={applying}>
                {applying ? "Applying…" : "Apply"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setChoosing(false)}>
                <X className="size-4" /> Cancel
              </Button>
            </form>
          ) : (
            <div>
              <Button variant="outline" onClick={() => setChoosing(true)}>
                <Plus className="size-4" /> Apply a payment plan
              </Button>
            </div>
          )
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
              <th className="pb-2 pr-3 font-medium">Instalment</th>
              <th className="pb-2 pr-3 font-medium">Amount</th>
              <th className="pb-2 pr-3 font-medium">Due</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l) => (
              <tr key={l.id} className="border-b border-border/60 align-top">
                <td className="py-2 pr-3">
                  <span className="font-medium text-text-1">{l.label}</span>
                  {l.pct !== null ? (
                    <span className="ml-1.5 text-xs text-text-3">{l.pct}%</span>
                  ) : null}
                  {l.milestone ? (
                    <div className="text-xs text-text-3">{l.milestone}</div>
                  ) : null}
                </td>
                <td className="py-2 pr-3 tabular-nums text-text-1">{formatMoney(l.amount)}</td>
                <td className="py-2 pr-3">
                  {canEdit ? (
                    <DueDateForm line={l} />
                  ) : (
                    <span className="text-text-2">
                      {l.due_date ? formatDate(l.due_date) : "—"}
                    </span>
                  )}
                </td>
                <td className="py-2">
                  {l.paid_at ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs text-success">
                        Paid {formatMoney(l.paid_amount ?? 0)}
                      </span>
                      {canEdit ? <MarkPaidForm line={l} /> : null}
                    </div>
                  ) : canEdit ? (
                    <MarkPaidForm line={l} />
                  ) : (
                    <span className="text-text-3">Unpaid</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex flex-wrap gap-4 tabular-nums">
          <span className="text-text-2">
            Scheduled <span className="text-text-1">{formatMoney(scheduleTotal)}</span>
          </span>
          <span className="text-text-2">
            Received <span className="text-success">{formatMoney(totals.paid)}</span>
          </span>
          <span className="text-text-2">
            Outstanding{" "}
            <span className={cn(totals.due > 0 ? "text-text-1" : "text-success")}>
              {formatMoney(totals.due)}
            </span>
          </span>
        </div>
        {canEdit ? (
          <form action={clearAction}>
            <input type="hidden" name="reservation_id" value={reservationId} />
            <Button type="submit" variant="ghost" size="sm" disabled={clearing}>
              {clearing ? "…" : "Remove schedule"}
            </Button>
          </form>
        ) : null}
      </div>

      {/* The amounts were worked out when the plan was applied. Say so, rather
          than letting a reader assume they track the current asking price. */}
      <p className="text-xs text-text-3">
        Amounts were fixed when the plan was applied, so they stay as quoted even if the price
        changes.
      </p>
    </div>
  );
}
