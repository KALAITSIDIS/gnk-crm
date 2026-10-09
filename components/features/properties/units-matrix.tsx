"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  createPaymentPlan,
  createPriceListVersion,
  createUnit,
  updateUnitStatus,
  type UnitActionState,
} from "@/lib/actions/units";
import { StatusBadge } from "@/components/features/shared/status-badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatArea, formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { PROPERTY_STATUSES, PROPERTY_TYPES } from "@/lib/validators/properties";
import type { PriceListComparison } from "@/lib/services/price-list";
import { newOperationId, settleOperation, stampOperationId, type OperationRef } from "@/lib/utils/operation-id";
import { PRICES_UNCONFIRMED, replayedText } from "@/lib/validators/price-lists";
import {
  describeUnitStatusOutcome,
  UNIT_STATUS_UNCONFIRMED,
  type UnitStatusResult,
} from "@/lib/validators/unit-status";

const initialState: UnitActionState = { error: null, savedAt: null };

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export interface UnitRow {
  id: string;
  reference: string;
  unit_number: string | null;
  block: string | null;
  property_type: string;
  bedrooms: number | null;
  covered_area_sqm: number | null;
  asking_price: number | null;
  status: string;
  floor_number: number | null;
}

function useSavedToast(state: UnitActionState) {
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.savedAt && state.savedAt !== last.current) {
      last.current = state.savedAt;
      toast.success("Saved");
    }
  }, [state]);
}

/** Send one change — the grid's only caller of updateUnitStatus; the fields are the ones `fd` was stamped with. */
function sendStatus(fd: FormData): Promise<UnitStatusResult> {
  return updateUnitStatus(
    String(fd.get("unit_id")),
    String(fd.get("status")),
    String(fd.get("expected")),
    String(fd.get("operation_id")),
  );
}

const STATUS_UNKNOWN: UnitStatusResult = { error: UNIT_STATUS_UNCONFIRMED, savedAt: null, unconfirmed: true };

/**
 * One unit's status (T-unit-status-atomic, 0143).
 *
 * CONTROLLED BY WHAT THE DATABASE SAID — the page's row — never by the pick:
 * a refused or unknown change leaves the trigger on the status the unit
 * actually has (an uncontrolled Select kept showing the refused pick, and then
 * ignored a second pick of the same status as "no change").
 *
 * Each pick is a NEW change: the status this row showed (`expected` — the
 * database refuses it if the unit moved meanwhile) and a fresh operation id.
 * No id is pinned across picks, unlike the 0141 / 0142 forms: the transition
 * is decided from the locked row, so a pick made after an unknown outcome can
 * never make that change twice — it is refused as stale, or answered
 * "unchanged". The toast's Check (an unknown outcome) and Retry (a follow-up
 * left open) re-send THAT change, its own id included: the database answers
 * what it committed, and the replay finishes the follow-up.
 */
function UnitStatusCell({ unit }: { unit: UnitRow }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const announce = (result: UnitStatusResult, fd: FormData) => {
    const outcome = describeUnitStatusOutcome(result, String(fd.get("status")));
    const action =
      outcome.offer === "check"
        ? { label: "Check", onClick: () => send(fd, true) }
        : outcome.offer === "retry"
          ? { label: "Retry", onClick: () => send(fd, true) }
          : undefined;
    // an offer stays until it is answered or dismissed (outcome-actions.tsx's UNTIL_DISMISSED)
    const opts = action ? { action, duration: Infinity, closeButton: true } : undefined;
    if (outcome.tone === "error") toast.error(outcome.text, opts);
    else if (outcome.tone === "warning") toast.warning(outcome.text, opts);
    else if (outcome.tone === "info") toast.info(outcome.text);
    else toast.success(outcome.text);
    // a refusal may mean the unit moved, an unknown outcome may have
    // committed: show what the database holds now (a commit refreshed already)
    if (result.error) router.refresh();
  };

  /** Send one change — `again` when it is the same change re-sent (Check, Retry). */
  const send = (fd: FormData, again: boolean) => {
    setPicked(String(fd.get("status")));
    startTransition(async () => {
      let result: UnitStatusResult;
      try {
        result = await sendStatus(fd);
      } catch {
        // the request never came back: it may have committed
        result = STATUS_UNKNOWN;
      }
      // a lock wait on a re-send: the original may still be running and commit
      if (again && result.busy) result = STATUS_UNKNOWN;
      // cleared in the transition, so it lands WITH the refreshed row — never
      // flashing the old status while another row's change is still in flight
      startTransition(() => setPicked(null));
      announce(result, fd);
    });
  };

  const change = (to: string) => {
    const fd = new FormData();
    fd.set("unit_id", unit.id);
    fd.set("status", to);
    fd.set("expected", unit.status);
    fd.set("operation_id", newOperationId());
    send(fd, false);
  };

  const shown = picked ?? unit.status;
  return (
    <Select value={shown} disabled={pending} onValueChange={change}>
      <SelectTrigger className="h-8 w-40 text-[13px]" aria-label={`Status of ${unit.reference}`}>
        <SelectValue>
          <StatusBadge status={shown} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {PROPERTY_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {labelize(s)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function UnitsMatrix({
  units,
  canManage = true,
}: {
  units: UnitRow[];
  /** unit status/insert rights: admin & listing manager (properties RLS) */
  canManage?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Unit</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Floor</TableHead>
            <TableHead className="text-right">Beds</TableHead>
            <TableHead className="text-right">Area</TableHead>
            <TableHead className="text-right">List price</TableHead>
            <TableHead className="w-44">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {units.map((u) => (
            <TableRow key={u.id} className="h-11 hover:bg-surface-2">
              <TableCell className="font-medium">
                {[u.block, u.unit_number].filter(Boolean).join("") || "—"}
              </TableCell>
              <TableCell>
                <Link href={`/properties/${u.id}`} className="text-brand-700 hover:underline">
                  {u.reference}
                </Link>
              </TableCell>
              <TableCell className="text-[13px]">{labelize(u.property_type)}</TableCell>
              <TableCell className="text-right tabular-nums">{u.floor_number ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{u.bedrooms ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums text-[13px]">
                {formatArea(u.covered_area_sqm)}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {formatMoney(u.asking_price)}
              </TableCell>
              <TableCell>
                {canManage ? (
                  <UnitStatusCell unit={u} />
                ) : (
                  <StatusBadge status={u.status} />
                )}
              </TableCell>
            </TableRow>
          ))}
          {units.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="py-10 text-center text-sm text-text-3">
                No units yet — add the first one below.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}

export function AddUnitForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState(createUnit, initialState);
  useSavedToast(state);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4"
    >
      <input type="hidden" name="project_id" value={projectId} />
      <h3 className="text-base font-semibold text-text-1">Add unit</h3>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="block">Block</Label>
          <Input id="block" name="block" placeholder="B" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="unit_number">Unit no. *</Label>
          <Input id="unit_number" name="unit_number" placeholder="203" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="unit-property-type">Type</Label>
          <Select name="property_type" defaultValue="apartment">
            <SelectTrigger id="unit-property-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROPERTY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {labelize(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="floor_number">Floor</Label>
          <Input id="floor_number" name="floor_number" type="number" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bedrooms">Beds</Label>
          <Input id="bedrooms" name="bedrooms" type="number" min="0" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="covered_area_sqm">m²</Label>
          <Input id="covered_area_sqm" name="covered_area_sqm" type="number" min="0" step="0.01" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="asking_price">Price €</Label>
          <Input id="asking_price" name="asking_price" type="number" min="0" step="0.01" />
        </div>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          <Plus className="size-4" /> {pending ? "Adding…" : "Add unit"}
        </Button>
      </div>
    </form>
  );
}

export interface PriceListRow {
  id: string;
  version: number;
  effective_date: string;
  notes: string | null;
  itemCount: number;
  /** audit finding 4: the prices, and how they moved since the version before */
  comparison: PriceListComparison;
  summary: string;
}

/** "+€313.000" / "−€200.000" — the sign outside the symbol, because
 *  formatMoney(-200000) renders "€-200.000", which reads like a typo. */
function signed(n: number): string {
  return `${n > 0 ? "+" : "−"}${formatMoney(Math.abs(n))}`;
}

/**
 * One version, expandable to the prices it actually holds (audit finding 4).
 *
 * The snapshot has always been written and never read back — the UI could say
 * "v3 covers 40 units" and could not show one price in it. A row here answers
 * "what did we quote in March" and, next to it, what moved since the version
 * before, which is the question that usually follows.
 *
 * Collapsed by default: a project with six versions of sixty units is 360 rows
 * nobody asked for on page load.
 */
function PriceListVersion({ priceList }: { priceList: PriceListRow }) {
  const [open, setOpen] = useState(false);
  const c = priceList.comparison;

  return (
    <li className="py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left hover:text-brand-700"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-text-3" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-text-3" />
        )}
        <span className="font-medium text-text-1">v{priceList.version}</span>
        <span className="text-text-2">{priceList.effective_date}</span>
        <span className="text-xs text-text-3">{priceList.summary}</span>
        <span className="ml-auto flex items-center gap-2 tabular-nums">
          <span className="font-medium text-text-1">{formatMoney(c.total)}</span>
          {c.totalDelta !== null && c.totalDelta !== 0 ? (
            <span className={c.totalDelta > 0 ? "text-success text-xs" : "text-danger text-xs"}>
              {signed(c.totalDelta)}
            </span>
          ) : null}
        </span>
      </button>

      {priceList.notes ? (
        <p className="ml-6 mt-1 text-xs text-text-3">{priceList.notes}</p>
      ) : null}

      {open ? (
        <div className="ml-6 mt-2 overflow-x-auto">
          {c.droppedCount > 0 ? (
            <p className="mb-2 text-xs text-warning">
              {c.droppedCount} unit{c.droppedCount === 1 ? " was" : "s were"} in the previous
              version and not this one — the totals cover different inventory.
            </p>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Was</TableHead>
                <TableHead className="text-right">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.rows.map((r) => (
                <TableRow key={r.unit_id} className="h-9">
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.price)}</TableCell>
                  <TableCell className="text-right tabular-nums text-text-3">
                    {r.previousPrice === null ? (r.isNew ? "new" : "—") : formatMoney(r.previousPrice)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      r.delta === null || r.delta === 0
                        ? "text-text-3"
                        : r.delta > 0
                          ? "text-success"
                          : "text-danger",
                    )}
                  >
                    {r.delta === null
                      ? "—"
                      : r.delta === 0
                        ? "0"
                        : `${signed(r.delta)}${r.deltaPct !== null ? ` (${(r.deltaPct * 100).toFixed(1)}%)` : ""}`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </li>
  );
}

export function PriceListsSection({
  projectId,
  priceLists,
  canManage = true,
}: {
  projectId: string;
  priceLists: PriceListRow[];
  canManage?: boolean;
}) {
  // One operation id per submission (0141): a retry after an error or a lost
  // answer is the same submission and is answered, not recorded twice. The
  // latest version is part of what is submitted, so once a version lands (and
  // the page redraws) the next press is a new submission.
  const operation: OperationRef = useRef<{ key: string; id: string; unresolved?: boolean } | null>(null);
  const [notes, setNotes] = useState("");
  const [state, formAction, pending] = useActionState(
    async (prev: UnitActionState, fd: FormData): Promise<UnitActionState> => {
      stampOperationId(operation, fd);
      let result: UnitActionState;
      try {
        result = await createPriceListVersion(prev, fd);
      } catch {
        result = { error: PRICES_UNCONFIRMED, savedAt: null, unconfirmed: true };
      }
      // an unknown outcome keeps this submission's id for the next press
      settleOperation(operation, result.unconfirmed === true);
      if (result.savedAt) setNotes("");
      return result;
    },
    initialState,
  );
  const lastToasted = useRef<number | null>(null);
  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      if (state.replayed) toast.info(replayedText(state.version));
      else toast.success("Saved");
    }
  }, [state]);

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4">
      <h3 className="text-base font-semibold text-text-1">Price list versions</h3>
      {priceLists.length === 0 ? (
        <p className="text-sm text-text-3">
          No versions yet. A version snapshots every unit&apos;s current price.
        </p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {priceLists.map((pl) => (
            <PriceListVersion key={pl.id} priceList={pl} />
          ))}
        </ul>
      )}
      {canManage ? (
        <>
          <form action={formAction} className="flex items-end gap-2">
            <input type="hidden" name="project_id" value={projectId} />
            <input type="hidden" name="latest_version" value={priceLists[0]?.version ?? 0} />
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="notes">Notes for new version</Label>
              <Input
                id="notes"
                name="notes"
                placeholder="e.g. +3% from 1 Aug"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Snapshotting…" : "New version"}
            </Button>
          </form>
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

interface InstallmentDraft {
  label: string;
  pct: string;
  due: string;
}

export interface PaymentPlanRow {
  id: string;
  name: string;
  installments: { label: string; pct: number; due: string }[];
}

export function PaymentPlansSection({
  projectId,
  plans,
  canManage = true,
}: {
  projectId: string;
  plans: PaymentPlanRow[];
  canManage?: boolean;
}) {
  const [state, formAction, pending] = useActionState(createPaymentPlan, initialState);
  useSavedToast(state);
  const [rows, setRows] = useState<InstallmentDraft[]>([
    { label: "Reservation", pct: "10", due: "On reservation" },
    { label: "Contract", pct: "30", due: "On contract signing" },
    { label: "Completion", pct: "60", due: "On delivery" },
  ]);

  const installmentsJson = JSON.stringify(
    rows
      .filter((r) => r.label && r.pct)
      .map((r) => ({ label: r.label, pct: Number(r.pct), due: r.due })),
  );

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4">
      <h3 className="text-base font-semibold text-text-1">Payment plan templates</h3>
      {plans.length === 0 ? (
        <p className="text-sm text-text-3">No plans yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {plans.map((plan) => (
            <li key={plan.id} className="py-2">
              <span className="font-medium text-text-1">{plan.name}</span>
              <span className="ml-2 text-text-2">
                {plan.installments.map((i) => `${i.label} ${i.pct}%`).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="project_id" value={projectId} />
        <input type="hidden" name="installments" value={installmentsJson} />
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan_name">Plan name</Label>
            <Input id="plan_name" name="name" placeholder="Standard 10/30/60" />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_90px_1fr_auto] items-center gap-2">
              <Input
                value={row.label}
                onChange={(e) =>
                  setRows((r) => r.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                }
                placeholder="Label"
              />
              <Input
                value={row.pct}
                onChange={(e) =>
                  setRows((r) => r.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))
                }
                placeholder="%"
                type="number"
                min="0"
                max="100"
              />
              <Input
                value={row.due}
                onChange={(e) =>
                  setRows((r) => r.map((x, j) => (j === i ? { ...x, due: e.target.value } : x)))
                }
                placeholder="Due"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRows((r) => [...r, { label: "", pct: "", due: "" }])}
            >
              <Plus className="size-4" /> Installment
            </Button>
          </div>
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        ) : null}
        <div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save plan"}
          </Button>
        </div>
      </form>
      ) : null}
    </div>
  );
}
