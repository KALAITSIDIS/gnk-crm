"use client";

import { useTransition } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { archiveProperty, restoreProperty } from "@/lib/actions/properties";
import { Button } from "@/components/ui/button";

/**
 * Archive = the properties "delete" (doc 04: DELETE ❌). Mirrors the contacts
 * archive button so the retire gesture is the same across modules.
 */
export function ArchivePropertyButton({
  propertyId,
  reference,
  isRetired,
  isWithdrawn,
}: {
  propertyId: string;
  reference: string;
  /** archived visibility OR withdrawn status — either marker retires the row */
  isRetired: boolean;
  isWithdrawn: boolean;
}) {
  const [pending, startTransition] = useTransition();

  const run = () => {
    if (
      !isRetired &&
      !confirm(
        `Archive ${reference}? It leaves the properties list (find it again with the Archived filter). Its status, history, mandates and documents are kept, and it can be restored.`,
      )
    ) {
      return;
    }
    if (
      isRetired &&
      isWithdrawn &&
      !confirm(
        `Restore ${reference}? Its status goes from Withdrawn back to Available and visibility becomes Private — publish it again from the Details tab.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const { error } = isRetired
        ? await restoreProperty(propertyId)
        : await archiveProperty(propertyId);
      if (error) toast.error(error);
      else toast.success(isRetired ? "Property restored" : "Property archived");
    });
  };

  return (
    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={run}>
      {isRetired ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
      {pending ? "Working…" : isRetired ? "Restore" : "Archive"}
    </Button>
  );
}
