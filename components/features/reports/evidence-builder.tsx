"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { FileCheck2, Search } from "lucide-react";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { DocumentDownloadButton } from "@/components/features/shared/document-download-button";
import {
  generateEvidenceReport,
  type ReportActionState,
} from "@/lib/actions/reports";
import type { EntityOption } from "@/lib/actions/entity-search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: ReportActionState = {
  error: null,
  savedAt: null,
  documentId: null,
  chainOk: null,
  rowCount: null,
};

export function EvidenceBuilder({
  initialContact,
  initialProperty,
  initialDeal,
  from,
  to,
}: {
  initialContact: EntityOption | null;
  initialProperty: EntityOption | null;
  initialDeal: EntityOption | null;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const [contact, setContact] = useState<EntityOption | null>(initialContact);
  const [property, setProperty] = useState<EntityOption | null>(initialProperty);
  const [deal, setDeal] = useState<EntityOption | null>(initialDeal);
  const [fromDate, setFromDate] = useState(from);
  const [toDate, setToDate] = useState(to);
  const [state, formAction, pending] = useActionState(generateEvidenceReport, initialState);

  const preview = () => {
    if (!contact) return;
    const params = new URLSearchParams({ contact: contact.id });
    if (property) params.set("property", property.id);
    if (deal) params.set("deal", deal.id);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    router.push(`/reports/commission-evidence?${params.toString()}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-[10px] border border-border bg-surface p-5 sm:grid-cols-2">
        <EntityPicker
          name="contact_picker"
          kind="contact"
          label="Contact"
          initial={initialContact}
          placeholder="Search name, phone…"
          onChange={setContact}
        />
        <EntityPicker
          name="property_picker"
          kind="property"
          label="Property (optional)"
          initial={initialProperty}
          placeholder="Search reference…"
          onChange={setProperty}
        />
        <EntityPicker
          name="deal_picker"
          kind="deal"
          label="Deal (optional)"
          initial={initialDeal}
          placeholder="Search deal title…"
          onChange={setDeal}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ev-from">From (optional)</Label>
          <Input
            id="ev-from"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ev-to">To (optional)</Label>
          <Input id="ev-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <Button type="button" disabled={!contact} onClick={preview}>
            <Search className="size-4" /> Preview events
          </Button>
        </div>
      </div>

      {initialContact ? (
        <form action={formAction} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="contact_id" value={initialContact.id} />
          {initialProperty ? (
            <input type="hidden" name="property_id" value={initialProperty.id} />
          ) : null}
          {initialDeal ? <input type="hidden" name="deal_id" value={initialDeal.id} /> : null}
          {from ? <input type="hidden" name="from" value={from} /> : null}
          {to ? <input type="hidden" name="to" value={to} /> : null}
          <Button type="submit" disabled={pending}>
            <FileCheck2 className="size-4" />
            {pending ? "Generating…" : "Generate PDF"}
          </Button>
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          {state.documentId ? (
            <span className="flex items-center gap-3 text-sm text-text-2">
              Stored ({state.rowCount} events · chain{" "}
              {state.chainOk ? "verified" : "FAILED"}).
              <DocumentDownloadButton documentId={state.documentId} label="Download report" />
            </span>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
