"use client";

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { KeyMovementActions } from "@/components/features/keys/key-dialogs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type KeyStatus } from "@/lib/validators/keys";
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

/**
 * Org-wide key register table (doc 05 /keys).
 *
 * Presentational since the PERF-2 pagination pass: filtering moved into the
 * URL and the server query (components/features/keys/filters.tsx), because a
 * client-side filter over a paged array only ever searches the current page.
 */
export function KeysRegister({
  keys: rows,
  canEdit,
  emptyText = "No keys match.",
}: {
  keys: KeyRegisterRow[];
  canEdit: boolean;
  emptyText?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border bg-surface py-12">
          <KeyRound className="size-7 text-text-3" />
          <p className="text-sm text-text-2">{emptyText}</p>
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
                      <KeyMovementActions
                        keyId={k.id}
                        keyCode={k.keyCode}
                        description={k.description}
                        status={k.status}
                        canEdit={canEdit}
                      />
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
