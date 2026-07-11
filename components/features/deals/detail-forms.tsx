"use client";

import { ActionSectionForm } from "@/components/features/shared/action-section-form";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { updateDealSection } from "@/lib/actions/deals";
import type { EntityOption } from "@/lib/actions/entity-search";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface DealDetailsValues {
  id: string;
  title: string;
  expected_value: string | number | null;
  property: EntityOption | null;
  buyer: EntityOption | null;
  seller: EntityOption | null;
  agent: EntityOption | null;
}

/** Parties + expected value (doc 05 /deals/[id]). Evented via deal.updated. */
export function DealDetailsForm({ deal }: { deal: DealDetailsValues }) {
  return (
    <ActionSectionForm
      action={updateDealSection}
      hidden={{ deal_id: deal.id, section: "details" }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="deal-title">Title</Label>
        <Input id="deal-title" name="title" defaultValue={deal.title} required />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <EntityPicker
          name="property_id"
          kind="property"
          label="Property"
          initial={deal.property}
          placeholder="Search reference, title…"
        />
        <EntityPicker
          name="agent_id"
          kind="agent"
          label="Agent"
          initial={deal.agent}
          placeholder="Search agents…"
        />
        <EntityPicker
          name="buyer_contact_id"
          kind="contact"
          label="Buyer"
          initial={deal.buyer}
          placeholder="Search name, phone…"
        />
        <EntityPicker
          name="seller_contact_id"
          kind="contact"
          label="Seller"
          initial={deal.seller}
          placeholder="Search name, phone…"
        />
      </div>

      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="deal-expected-value">Expected value (€)</Label>
        <Input
          id="deal-expected-value"
          name="expected_value"
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          defaultValue={deal.expected_value ?? ""}
        />
      </div>
    </ActionSectionForm>
  );
}

/** Manual split notes — plain text by design (doc 01 guardrail 8). */
export function CommissionForm({
  dealId,
  notes,
}: {
  dealId: string;
  notes: string | null;
}) {
  return (
    <ActionSectionForm
      action={updateDealSection}
      hidden={{ deal_id: dealId, section: "commission" }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="deal-commission">Commission split notes</Label>
        <Textarea
          id="deal-commission"
          name="commission_split_notes"
          rows={5}
          defaultValue={notes ?? ""}
          placeholder="e.g. 60/40 with partner agency X, referral fee to Y…"
        />
        <p className="text-xs text-text-3">
          Manual by design — printed on the commission evidence report.
        </p>
      </div>
    </ActionSectionForm>
  );
}
