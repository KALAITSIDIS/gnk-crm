"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { GitMerge, Search } from "lucide-react";
import { toast } from "sonner";
import {
  mergeContacts,
  searchContactsForMerge,
  type MergeCandidate,
  type MergeState,
} from "@/lib/actions/merge-contacts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatPhone } from "@/lib/services/phone";
import { cn } from "@/lib/utils";

const initialState: MergeState = { error: null, mergedAt: null };

export function MergeDialog({
  primaryId,
  primaryName,
}: {
  primaryId: string;
  primaryName: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
  const [selected, setSelected] = useState<MergeCandidate | null>(null);
  const [state, formAction, pending] = useActionState(mergeContacts, initialState);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.mergedAt && state.mergedAt !== lastToasted.current) {
      lastToasted.current = state.mergedAt;
      toast.success("Contacts merged");
      setOpen(false);
      setSelected(null);
      setQuery("");
      setCandidates([]);
    }
  }, [state.mergedAt]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setSelected(null);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setCandidates(await searchContactsForMerge(value, primaryId));
    }, 300);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <GitMerge className="size-4" /> Merge
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Merge a duplicate into {primaryName}</DialogTitle>
          <DialogDescription>
            The selected contact is archived; its leads, deals, viewings, offers and documents move
            here. Event history is preserved on both sides.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search name, phone, email…"
            className="pl-8"
          />
        </div>

        {candidates.length > 0 ? (
          <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {candidates.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelected(c)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2",
                    selected?.id === c.id && "bg-brand-100/60",
                  )}
                >
                  <span className="font-medium text-text-1">{c.display_name}</span>
                  <span className="text-xs tabular-nums text-text-3">
                    {c.phone_e164 ? formatPhone(c.phone_e164) : (c.email ?? "")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : query.trim().length >= 2 ? (
          <p className="text-sm text-text-3">No matches.</p>
        ) : null}

        {state.error ? (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        ) : null}

        <form action={formAction}>
          <input type="hidden" name="primary_id" value={primaryId} />
          <input type="hidden" name="duplicate_id" value={selected?.id ?? ""} />
          <Button type="submit" disabled={!selected || pending} className="w-full">
            {pending
              ? "Merging…"
              : selected
                ? `Merge "${selected.display_name}" into ${primaryName}`
                : "Pick a contact to merge"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
