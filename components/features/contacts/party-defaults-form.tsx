"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { savePartyDefaults, type PartyDefaultsState } from "@/lib/actions/party-defaults";
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
import { MANDATE_TYPES } from "@/lib/validators/mandates";
import {
  PERMIT_STATUSES,
  TITLE_DEED_STATUSES,
  VAT_STATUSES,
} from "@/lib/validators/properties";
import { TERM_NONE, type PartyDefaults } from "@/lib/validators/party-defaults";

const initialState: PartyDefaultsState = { error: null, savedAt: null };


function labelize(v: string) {
  return v.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** A select whose "no opinion" option is a sentinel, since Radix forbids "". */
function TermSelect({
  name,
  label,
  options,
  value,
  fallback,
  readOnly,
}: {
  name: string;
  label: string;
  options: readonly string[];
  value: string | undefined;
  fallback: string | undefined;
  readOnly: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`pd-${name}`}>{label}</Label>
      <Select name={name} defaultValue={value ?? TERM_NONE} disabled={readOnly}>
        <SelectTrigger id={`pd-${name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={TERM_NONE}>
            {fallback ? `— office: ${labelize(fallback)}` : "— no standard"}
          </SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {labelize(o)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * A party's standard terms (migration 0038).
 *
 * The operator's opening request, at its source: what this developer or owner
 * always works on, entered once instead of retyped per property and per
 * mandate. The create wizard and the mandate dialog read it.
 *
 * EVERY FIELD CAN BE LEFT BLANK, and blank means "no opinion" rather than zero —
 * which is what lets the office standard show through underneath. Each control
 * says what the office would give it, so leaving one alone is a visible choice
 * rather than an omission.
 */
export function PartyDefaultsForm({
  contactId,
  contactName,
  stored,
  office,
  readOnly,
}: {
  contactId: string;
  contactName: string;
  stored: PartyDefaults;
  office: PartyDefaults;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState(savePartyDefaults, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Standard terms saved");
    }
  }, [state.savedAt]);

  const num = (v: number | undefined) => (v === undefined ? "" : String(v));
  const officeHint = (v: number | undefined) =>
    v === undefined ? "no office standard" : `office: ${v}`;

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="contact_id" value={contactId} />

      <p className="text-sm text-text-2">
        What {contactName} normally works on. These prefill a new property and a new mandate —
        every value stays editable there, and a blank here falls back to the office standard.
      </p>

      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-5">
        <div>
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-3">
            Mandate terms
          </h4>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pd-commission">Commission %</Label>
              <Input
                id="pd-commission"
                name="commission_pct"
                type="number"
                step="0.1"
                min="0"
                max="100"
                defaultValue={num(stored.commission_pct)}
                placeholder={officeHint(office.commission_pct)}
              />
            </div>
            <TermSelect
              name="mandate_type"
              label="Mandate type"
              options={MANDATE_TYPES}
              value={stored.mandate_type}
              fallback={office.mandate_type}
              readOnly={readOnly}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pd-months">Length (months)</Label>
              <Input
                id="pd-months"
                name="mandate_months"
                type="number"
                min="1"
                max="120"
                defaultValue={num(stored.mandate_months)}
                placeholder={officeHint(office.mandate_months)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pd-reminder">Reminder (days before)</Label>
              <Input
                id="pd-reminder"
                name="renewal_reminder_days"
                type="number"
                min="1"
                max="365"
                defaultValue={num(stored.renewal_reminder_days)}
                placeholder={officeHint(office.renewal_reminder_days)}
              />
            </div>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-3">
            Property terms
          </h4>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <TermSelect
              name="vat_status"
              label="VAT status"
              options={VAT_STATUSES}
              value={stored.vat_status}
              fallback={office.vat_status}
              readOnly={readOnly}
            />
            <TermSelect
              name="title_deed_status"
              label="Title deed status"
              options={TITLE_DEED_STATUSES}
              value={stored.title_deed_status}
              fallback={office.title_deed_status}
              readOnly={readOnly}
            />
            <TermSelect
              name="permit_status"
              label="Permit status"
              options={PERMIT_STATUSES}
              value={stored.permit_status}
              fallback={office.permit_status}
              readOnly={readOnly}
            />
          </div>
        </div>
      </fieldset>

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      {readOnly ? (
        <p className="text-xs text-text-3">
          Read-only — standard terms set a commission rate for the office, so admins own them.
        </p>
      ) : (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save standard terms"}
          </Button>
        </div>
      )}
    </form>
  );
}
