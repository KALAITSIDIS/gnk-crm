"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { applyPriceUplift, type UnitActionState } from "@/lib/actions/units";
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
  blocksOf,
  inScope,
  previewUplift,
  reviewedScope,
  type UpliftMode,
  type UpliftTarget,
} from "@/lib/services/price-uplift";
import { formatMoney } from "@/lib/utils/format";
import { settleOperation, stampOperationId, type OperationRef } from "@/lib/utils/operation-id";
import { PRICES_UNCONFIRMED, replayedText } from "@/lib/validators/price-lists";

const initialState: UnitActionState = { error: null, savedAt: null };
const ALL_BLOCKS = "__all__";

/**
 * "Raise the C block by 3%" (BACKLOG audit finding 4, the other half).
 *
 * The preview is computed with the same rule, in the same exact decimals, as
 * the database write (`record_price_list_version`, 0141) — the same reason the
 * bulk unit generator shares `generateUnits`: a price change nobody could check
 * before committing is worse than editing sixty rows by hand.
 *
 * WHAT YOU SAW IS WHAT IS WRITTEN. The form sends the scope it previewed — every
 * unit, with the price it showed — and the database applies the change only if
 * the units still hold exactly those prices; otherwise it changes nothing and
 * the page redraws with the current ones. Each submission carries one
 * operation id, so a retry (after an error, or an answer that never came back)
 * is answered with what was already committed instead of being applied twice.
 *
 * It says plainly that it does TWO things — change the units and record a
 * version — because "apply" that quietly also snapshots would be a surprise the
 * first time somebody looked for the version they did not know they made.
 */
export function PriceUpliftForm({
  projectId,
  units,
  nextVersion,
}: {
  projectId: string;
  units: UpliftTarget[];
  nextVersion: number;
}) {
  const operation: OperationRef = useRef<{ key: string; id: string; unresolved?: boolean } | null>(null);
  const [notes, setNotes] = useState("");
  const [state, dispatch, pending] = useActionState(
    async (prev: UnitActionState, fd: FormData): Promise<UnitActionState> => {
      stampOperationId(operation, fd);
      let result: UnitActionState;
      try {
        result = await applyPriceUplift(prev, fd);
      } catch {
        // the request never came back: it may have committed — the same
        // submission pressed again is answered, not applied twice
        result = { error: PRICES_UNCONFIRMED, savedAt: null, unconfirmed: true };
      }
      // an unknown outcome keeps this submission's id for the next press, even
      // if the page redraws in between (lib/utils/operation-id.ts)
      settleOperation(operation, result.unconfirmed === true);
      // the note belongs to the version just recorded; a failed attempt keeps it
      if (result.savedAt) setNotes("");
      return result;
    },
    initialState,
  );
  /**
   * Dispatched from onSubmit, NOT passed as `<form action>`: React resets a
   * form after every action it runs from `action` — refused ones included — and
   * the Radix Selects below answer a form reset by jumping back to their first
   * value. After an error the form then said "All units · Percentage" over the
   * amount still typed (5000 → +5000% on every unit), right where it told the
   * person to press again (review of T-price-uplift-atomic, 2026-10-05).
   */
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => dispatch(fd));
  };
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      if (state.replayed) toast.info(replayedText(state.version));
      else toast.success("Prices updated and a new version recorded");
    }
  }, [state]);

  const [block, setBlock] = useState<string>(ALL_BLOCKS);
  const [mode, setMode] = useState<UpliftMode>("percent");
  const [amount, setAmount] = useState<string>("");

  const blocks = blocksOf(units);
  const scoped = inScope(units, block === ALL_BLOCKS ? null : block);
  const parsedAmount = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount !== 0;
  const preview = valid ? previewUplift(scoped, { mode, amount: parsedAmount }) : null;

  if (units.length === 0) return null;

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4"
    >
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="block" value={block === ALL_BLOCKS ? "" : block} />
      <input type="hidden" name="mode" value={mode} />
      {/* the scope as previewed — the database refuses the write if it moved */}
      <input type="hidden" name="expected" value={JSON.stringify(reviewedScope(scoped))} />

      <div>
        <h3 className="text-base font-semibold text-text-1">Reprice a block</h3>
        <p className="mt-1 text-xs text-text-3">
          Changes the units&apos; asking prices <em>and</em> records the result as price list v
          {nextVersion}. Units with no price are left alone.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="uplift-scope">Apply to</Label>
          <Select value={block} onValueChange={setBlock}>
            <SelectTrigger id="uplift-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_BLOCKS}>All units ({units.length})</SelectItem>
              {blocks.map((b) => (
                <SelectItem key={b} value={b}>
                  Block {b} ({units.filter((u) => u.block === b).length})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="uplift-mode">Change by</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as UpliftMode)}>
            <SelectTrigger id="uplift-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="percent">Percentage</SelectItem>
              <SelectItem value="fixed">Fixed amount</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="uplift-amount">{mode === "percent" ? "Percent" : "Euros"}</Label>
          <Input
            id="uplift-amount"
            name="amount"
            type="number"
            step={mode === "percent" ? "0.1" : "100"}
            placeholder={mode === "percent" ? "3" : "5000"}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <p className="text-xs text-text-3">Negative to cut.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="uplift-notes">Version note</Label>
          <Input
            id="uplift-notes"
            name="notes"
            placeholder="e.g. from 1 September"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      <div
        data-testid="uplift-preview"
        className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text-2"
      >
        {preview === null ? (
          <span className="text-text-3">Enter a change to see what it would do.</span>
        ) : preview.rows.length === 0 ? (
          <span className="text-danger">
            {preview.skipped === scoped.length
              ? "None of those units has a price to change."
              : "That rounds to nothing — no price would move."}
          </span>
        ) : (
          <>
            Repricing <span className="font-semibold text-text-1">{preview.rows.length}</span>{" "}
            unit{preview.rows.length === 1 ? "" : "s"} ·{" "}
            <span className="tabular-nums">
              {formatMoney(preview.totalBefore)} → {formatMoney(preview.totalAfter)}
            </span>
            {preview.skipped > 0 ? (
              <span className="text-text-3"> · {preview.skipped} unpriced, left alone</span>
            ) : null}
            {preview.unchanged > 0 ? (
              <span className="text-text-3"> · {preview.unchanged} unmoved after rounding</span>
            ) : null}
            <span className="mt-1 block font-mono text-xs text-text-3">
              e.g. {preview.rows[0].reference} {formatMoney(preview.rows[0].from)} →{" "}
              {formatMoney(preview.rows[0].to)}
            </span>
          </>
        )}
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={pending || preview === null || preview.rows.length === 0}
        >
          <TrendingUp className="size-4" />
          {pending ? "Repricing…" : "Reprice and record version"}
        </Button>
      </div>
    </form>
  );
}
