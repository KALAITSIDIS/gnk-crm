"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
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
import { PROPERTY_STATUSES, PROPERTY_TYPES } from "@/lib/validators/properties";

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

export function UnitsMatrix({ units }: { units: UnitRow[] }) {
  const [isPending, startTransition] = useTransition();

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
                <Select
                  defaultValue={u.status}
                  disabled={isPending}
                  onValueChange={(v) =>
                    startTransition(async () => {
                      await updateUnitStatus(u.id, v);
                      toast.success("Saved");
                    })
                  }
                >
                  <SelectTrigger className="h-8 w-40 text-[13px]">
                    <SelectValue>
                      <StatusBadge status={u.status} />
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
          <Label>Type</Label>
          <Select name="property_type" defaultValue="apartment">
            <SelectTrigger>
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
}

export function PriceListsSection({
  projectId,
  priceLists,
}: {
  projectId: string;
  priceLists: PriceListRow[];
}) {
  const [state, formAction, pending] = useActionState(createPriceListVersion, initialState);
  useSavedToast(state);

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
            <li key={pl.id} className="flex items-center justify-between py-2">
              <span className="font-medium text-text-1">v{pl.version}</span>
              <span className="text-text-2">{pl.effective_date}</span>
              <span className="text-text-2">{pl.itemCount} units</span>
              <span className="max-w-48 truncate text-text-3">{pl.notes ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
      <form action={formAction} className="flex items-end gap-2">
        <input type="hidden" name="project_id" value={projectId} />
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="notes">Notes for new version</Label>
          <Input id="notes" name="notes" placeholder="e.g. +3% from 1 Aug" />
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
}: {
  projectId: string;
  plans: PaymentPlanRow[];
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
    </div>
  );
}
