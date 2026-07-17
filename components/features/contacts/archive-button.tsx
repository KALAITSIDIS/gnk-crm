"use client";

import { useTransition } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { archiveContact, unarchiveContact } from "@/lib/actions/contacts";
import { Button } from "@/components/ui/button";

/**
 * Archive = the contacts "delete" (doc 04: DELETE ❌, archive flag instead).
 * RLS enforces who may; the actions surface a denial instead of no-opping.
 */
export function ArchiveContactButton({
  contactId,
  contactName,
  isArchived,
}: {
  contactId: string;
  contactName: string;
  isArchived: boolean;
}) {
  const [pending, startTransition] = useTransition();

  const run = () => {
    if (
      !isArchived &&
      !confirm(
        `Archive “${contactName}”? It disappears from the active list and dedup checks; history is kept and it can be unarchived.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const { error } = isArchived
        ? await unarchiveContact(contactId)
        : await archiveContact(contactId);
      if (error) toast.error(error);
      else toast.success(isArchived ? "Contact unarchived" : "Contact archived");
    });
  };

  return (
    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={run}>
      {isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
      {pending ? "Working…" : isArchived ? "Unarchive" : "Archive"}
    </Button>
  );
}
