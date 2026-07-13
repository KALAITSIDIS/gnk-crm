"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { KeyMovementActions } from "@/components/features/keys/key-dialogs";
import { Input } from "@/components/ui/input";
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
import { KEY_STATUSES, type KeyStatus } from "@/lib/validators/keys";
import { cn } from "@/lib/utils";

export interface KeyRegisterRow {
  id: string;
  keyCode: string;
  description: string | null;
  status: KeyStatus;
  holderName: string | null;
  propertyId: string;
  propertyRef: string;
}

const STATUS_TONES: Record<KeyStatus, string> = {
  in_office: "bg-success/10 text-success",
  checked_out: "bg-warning/10 text-warning",
  with_owner: "bg-brand-100 text-brand-700",
  lost: "bg-danger/10 text-danger",
};

function labelize(v: string) {
  return v.replace(/_/g, " ");
}

/** Org-wide key register with status/holder filters (doc 05 /keys). */
export function KeysRegister({ keys }: { keys: KeyRegisterRow[] }) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [holderFilter, setHolderFilter] = useState("");

  const rows = useMemo(() => {
    const holder = holderFilter.trim().toLowerCase();
    return keys.filter((k) => {
      if (statusFilter !== "all" && k.status !== statusFilter) return false;
      if (holder && !(k.holderName ?? "").toLowerCase().includes(holder)) return false;
      return true;
    });
  }, [keys, statusFilter, holderFilter]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {KEY_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {labelize(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={holderFilter}
          onChange={(e) => setHolderFilter(e.target.value)}
          placeholder="Filter by holder…"
          className="w-48"
        />
        <span className="ml-auto text-sm text-text-3">
          {rows.length} of {keys.length} keys
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border bg-surface py-12">
          <KeyRound className="size-7 text-text-3" />
          <p className="text-sm text-text-2">No keys match.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Property</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Holder</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-mono text-xs font-semibold">{k.keyCode}</TableCell>
                  <TableCell>
                    <Link
                      href={`/properties/${k.propertyId}`}
                      className="font-mono text-xs text-brand-700 hover:underline"
                    >
                      {k.propertyRef}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-56 truncate text-text-2">
                    {k.description ?? "—"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                        STATUS_TONES[k.status],
                      )}
                    >
                      {labelize(k.status)}
                    </span>
                  </TableCell>
                  <TableCell className="text-text-2">{k.holderName ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end">
                      <KeyMovementActions keyId={k.id} status={k.status} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
