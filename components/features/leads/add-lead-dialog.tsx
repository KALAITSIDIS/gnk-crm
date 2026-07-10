"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { createLead, type LeadActionState } from "@/lib/actions/leads";
import { searchContactsForMerge, type MergeCandidate } from "@/lib/actions/merge-contacts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { COMM_CHANNELS, LEAD_SOURCES } from "@/lib/validators/contacts";
import { formatPhone } from "@/lib/services/phone";
import { cn } from "@/lib/utils";

const initialState: LeadActionState = { error: null, savedAt: null };

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function AddLeadDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createLead, initialState);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
  const [contact, setContact] = useState<MergeCandidate | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Lead added");
      setOpen(false);
      setContact(null);
      setQuery("");
      setCandidates([]);
    }
  }, [state.savedAt]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setContact(null);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setCandidates(await searchContactsForMerge(value, "00000000-0000-0000-0000-000000000000"));
    }, 300);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> Add lead
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New lead</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="contact_id" value={contact?.id ?? ""} />
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Source</Label>
              <Select name="source" defaultValue="phone">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEAD_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {labelize(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Channel</Label>
              <Select name="channel" defaultValue="">
                <SelectTrigger>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  {COMM_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {labelize(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Link contact (optional)</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
              <Input
                value={contact ? contact.display_name : query}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder="Search name, phone…"
                className="pl-8"
              />
            </div>
            {!contact && candidates.length > 0 ? (
              <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {candidates.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setContact(c)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2",
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
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lead-message">Message / request</Label>
            <Textarea id="lead-message" name="message" rows={3} />
          </div>

          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add lead"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
