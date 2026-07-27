"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { purgeExpiredRetention } from "@/lib/actions/contact-erasure";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RetentionRowStatus } from "@/lib/services/retention";
import { formatDate } from "@/lib/utils/format";

const STATUS_LABEL: Record<RetentionRowStatus["status"], string> = {
  expired: "Retention expired",
  due_soon: "Expiring soon",
  retained: "Retained",
};

const STATUS_TONE: Record<RetentionRowStatus["status"], string> = {
  expired: "text-danger",
  due_soon: "text-warning",
  retained: "text-text-2",
};

export function RetentionPanel({ rows }: { rows: RetentionRowStatus[] }) {
  const [target, setTarget] = useState<RetentionRowStatus | null>(null);
  const [pending, startTransition] = useTransition();

  const onConfirm = () => {
    if (!target) return;
    startTransition(async () => {
      const result = await purgeExpiredRetention(target.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Retained records destroyed for ${target.displayName ?? "contact"}`);
      setTarget(null);
    });
  };

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16">
        <ShieldCheck className="size-8 text-success" />
        <p className="text-sm font-medium text-text-1">Nothing is being retained</p>
        <p className="max-w-md text-center text-sm text-text-2">
          When a contact&apos;s personal data is erased but an AML due-diligence relationship
          existed, their KYC records are kept for five years and listed here until that duty runs
          out.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-2">
        KYC records kept under the Cyprus AML five-year duty after a GDPR erasure. Once the duty
        has run, holding them is no longer lawful — destroy them here.
      </p>

      <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contact</TableHead>
              <TableHead>Retained until</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} className="h-11">
                <TableCell className="font-medium">
                  <Link href={`/contacts/${r.id}`} className="text-brand-700 hover:underline">
                    {r.displayName ?? "Unnamed"}
                  </Link>
                </TableCell>
                <TableCell className="tabular-nums text-[13px]">
                  {formatDate(r.retentionUntil)}
                </TableCell>
                <TableCell className={`text-[13px] font-medium ${STATUS_TONE[r.status]}`}>
                  {STATUS_LABEL[r.status]}
                  {r.status === "due_soon" ? (
                    <span className="ml-1 font-normal text-text-3">
                      ({r.daysRemaining} day{r.daysRemaining === 1 ? "" : "s"})
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  {r.status === "expired" ? (
                    <Button size="sm" variant="outline" onClick={() => setTarget(r)}>
                      <Trash2 className="size-4" /> Destroy records
                    </Button>
                  ) : (
                    <span className="text-[13px] text-text-3">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Destroy retained records?</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-text-1">
              This permanently destroys the KYC documents kept for{" "}
              <span className="font-semibold">{target?.displayName ?? "this contact"}</span> and
              their stored files. It cannot be undone.
            </p>
            <p className="text-text-2">
              The erasure record, the event log and any signed viewing slips are not affected —
              they are the audit trail and immutable commission evidence.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setTarget(null)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={onConfirm} disabled={pending}>
                {pending ? "Destroying…" : "Destroy records"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
