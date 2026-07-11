"use client";

import { ActionSectionForm } from "@/components/features/shared/action-section-form";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { HealthDot } from "@/components/features/shared/health-dot";
import { updateDealSection } from "@/lib/actions/deals";
import type { EntityOption } from "@/lib/actions/entity-search";
import type { HealthFactor } from "@/lib/services/health-score";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

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

/**
 * Health panel (doc 02 §C5): score, factor checklist from the stored
 * snapshot, and the manual "budget confirmed" flag (evented via section save;
 * the score recomputes in-action right after).
 */
export function HealthPanel({
  dealId,
  score,
  budgetConfirmed,
  factors,
}: {
  dealId: string;
  score: number;
  budgetConfirmed: boolean;
  factors: HealthFactor[] | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <HealthDot score={score} factors={factors} className="size-3" />
        <span className="text-2xl font-semibold tabular-nums text-text-1">{score}</span>
        <span className="text-sm text-text-3">/ 100</span>
      </div>

      {factors && factors.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {factors.map((f) => (
            <li key={f.key} className="flex items-baseline justify-between gap-3 text-sm">
              <span className={cn(f.points > 0 ? "text-text-1" : "text-text-3")}>
                {f.points > 0 ? "✓" : "○"} {f.label}
                <span className="ml-1.5 text-xs text-text-3">{f.detail}</span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-text-3">
                {f.points}/{f.max}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-3">
          Factor breakdown appears after the next update to this deal.
        </p>
      )}

      <ActionSectionForm
        action={updateDealSection}
        hidden={{ deal_id: dealId, section: "health" }}
      >
        <label className="flex items-center gap-2 text-sm text-text-1">
          <Checkbox name="budget_confirmed" defaultChecked={budgetConfirmed} />
          Budget confirmed
        </label>
      </ActionSectionForm>
    </div>
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
