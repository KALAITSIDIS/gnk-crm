"use client";

import { useState, useTransition } from "react";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { createPartyContact } from "@/lib/actions/party-contacts";
import type { DuplicateMatch } from "@/lib/actions/contacts";
import type { EntityOption } from "@/lib/actions/entity-search";
import type { ListingSource } from "@/lib/validators/properties";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Inline owner/developer creation on the wizard's party step (audit WF-10).
 * Collapsed behind a link so the picker stays the primary path; the created
 * (or linked) contact is handed back through the same onSelect the picker
 * uses, so party terms resolve identically either way. Deliberately NOT a
 * form element — it lives inside the wizard's own <form>, and nesting forms
 * is invalid HTML that submits the parent.
 */
export function CreatePartyContact({
  source,
  onSelect,
}: {
  source: ListingSource;
  onSelect: (option: EntityOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null);
  const [pending, start] = useTransition();

  const noun = source === "developer" ? "developer" : "owner";

  const reset = () => {
    setName("");
    setPhone("");
    setEmail("");
    setError(null);
    setDuplicate(null);
  };

  const create = () =>
    start(async () => {
      setError(null);
      setDuplicate(null);
      const result = await createPartyContact({
        source,
        name,
        phone: phone || undefined,
        email: email || undefined,
      });
      if (result.option) {
        toast.success(`${result.option.label} created`);
        onSelect(result.option);
        setOpen(false);
        reset();
        return;
      }
      setError(result.error);
      setDuplicate(result.duplicate);
    });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-xs font-medium text-brand-700 hover:underline"
      >
        <UserPlus className="mr-1 inline size-3.5" />
        New {noun} — create without leaving the wizard
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <p className="text-xs font-medium text-text-2">New {noun}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="party-new-name">Name</Label>
        <Input
          id="party-new-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={source === "developer" ? "Company name" : "Full name"}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="party-new-phone">Phone</Label>
          <Input
            id="party-new-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="99 123456"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="party-new-email">Email</Label>
          <Input
            id="party-new-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>

      {duplicate ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-warning/50 bg-warning/5 p-3 text-sm"
        >
          <span className="text-text-1">
            Looks like <span className="font-semibold">{duplicate.display_name}</span> already
            exists (same {duplicate.matched_on}).
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => {
              onSelect({ id: duplicate.id, label: duplicate.display_name, sublabel: null });
              setOpen(false);
              reset();
            }}
          >
            Link {duplicate.display_name} instead
          </Button>
        </div>
      ) : error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={create} disabled={pending || name.trim().length < 2}>
          {pending ? "Creating…" : `Create ${noun}`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            reset();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
