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
        {/* mounted only while open so a reopened dialog never shows the
            previous attempt's error or search results (audit fix) */}
        {open ? <AddLeadForm onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddLeadForm({ onDone }: { onDone: () => void }) {
  const [state, formAction, pending] = useActionState(createLead, initialState);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
  const [contact, setContact] = useState<MergeCandidate | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Lead added");
      onDone();
    }
  }, [state.savedAt, onDone]);

  // cancel any in-flight debounce when the dialog closes/unmounts
  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setContact(null);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      const seq = ++searchSeq.current;
      const results = await searchContactsForMerge(value);
      // a slower earlier search must not overwrite newer results
      if (seq === searchSeq.current) setCandidates(results);
    }, 300);
  };

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="contact_id" value={contact?.id ?? ""} />
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lead-source">Source</Label>
          <Select name="source" defaultValue="phone">
            <SelectTrigger id="lead-source">
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
          <Label htmlFor="lead-channel">Channel</Label>
          <Select name="channel" defaultValue="">
            <SelectTrigger id="lead-channel">
              <SelectValue placeholder="Optional" />
            </SelectTrigger>
            <SelectContent>
              {/* "none" clears a picked channel; the schema maps it to unset */}
              <SelectItem value="none">—</SelectItem>
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
        <Label htmlFor="lead-contact-search">Link contact (optional)</Label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input
            id="lead-contact-search"
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
  );
}
