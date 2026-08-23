"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, X } from "lucide-react";
import { ActionSectionForm } from "@/components/features/shared/action-section-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { PROPERTY_FEATURES } from "@/lib/constants/features";
import {
  saveBuyerRequirement,
  setBuyerRequirementActive,
} from "@/lib/actions/buyer-requirements";
import { SELECT_NONE } from "@/lib/validators/contacts";
import { PROPERTY_TYPES, TRANSACTION_TYPES, VAT_STATUSES } from "@/lib/validators/properties";
import { formatMoney } from "@/lib/utils/format";

/**
 * Saved buyer searches on the contact page (0043, T-B4).
 *
 * Several per buyer, because a real one has several: "2-bed under €300k in Kato
 * Paphos" AND "any plot over 500 m² in Tala". `contacts.preferences` could hold
 * one, unstructured and unindexed, which is why 0043 exists.
 */

export interface RequirementRow {
  id: string;
  label: string | null;
  is_active: boolean;
  transaction_type: string;
  property_types: string[];
  district_ids: string[];
  area_ids: string[];
  budget_min: number | null;
  budget_max: number | null;
  bedrooms_min: number | null;
  bedrooms_max: number | null;
  bathrooms_min: number | null;
  covered_area_min_sqm: number | null;
  plot_area_min_sqm: number | null;
  title_deed_required: boolean;
  vat_preference: string | null;
  max_sea_distance_m: number | null;
  delivery_by: string | null;
  features_required: string[];
  notes: string | null;
}

export interface NamedOption {
  id: string;
  name: string;
}

const labelize = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** One line a person can read at a glance, built only from what was actually set. */
function summarise(r: RequirementRow, districts: NamedOption[], areas: NamedOption[]): string {
  const parts: string[] = [];

  if (r.property_types.length) parts.push(r.property_types.map(labelize).join(" / "));
  else parts.push("Any type");

  if (r.bedrooms_min !== null && r.bedrooms_max !== null) {
    parts.push(`${r.bedrooms_min}–${r.bedrooms_max} bed`);
  } else if (r.bedrooms_min !== null) parts.push(`${r.bedrooms_min}+ bed`);
  else if (r.bedrooms_max !== null) parts.push(`up to ${r.bedrooms_max} bed`);

  if (r.budget_min !== null && r.budget_max !== null) {
    parts.push(`${formatMoney(r.budget_min)}–${formatMoney(r.budget_max)}`);
  } else if (r.budget_max !== null) parts.push(`up to ${formatMoney(r.budget_max)}`);
  else if (r.budget_min !== null) parts.push(`from ${formatMoney(r.budget_min)}`);

  const named = (ids: string[], from: NamedOption[]) =>
    ids.map((id) => from.find((o) => o.id === id)?.name).filter(Boolean) as string[];
  const where = [...named(r.area_ids, areas), ...named(r.district_ids, districts)];
  if (where.length) parts.push(where.join(", "));

  if (r.title_deed_required) parts.push("separate deed");

  return parts.join(" · ");
}

function RequirementFields({
  r,
  districts,
  areas,
}: {
  r?: RequirementRow;
  districts: NamedOption[];
  areas: NamedOption[];
}) {
  // Suffix every id so two open forms on one page cannot collide — a duplicate
  // id makes a <label htmlFor> point at the wrong control, which A11Y-1's E2E
  // guard would catch but a reader would not.
  const uid = r?.id ?? "new";
  const id = (n: string) => `${n}-${uid}`;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Label htmlFor={id("label")}>Name this search</Label>
        <Input
          id={id("label")}
          name="label"
          maxLength={120}
          placeholder="Sea view 2-bed, Kato Paphos"
          defaultValue={r?.label ?? ""}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={id("transaction_type")}>Buying or renting</Label>
        <Select name="transaction_type" defaultValue={r?.transaction_type ?? "sale"}>
          <SelectTrigger id={id("transaction_type")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSACTION_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {labelize(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={id("budget_min")}>Budget min (€)</Label>
        <Input
          id={id("budget_min")}
          name="budget_min"
          type="number"
          min="0"
          defaultValue={r?.budget_min ?? ""}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id("budget_max")}>Budget max (€)</Label>
        <Input
          id={id("budget_max")}
          name="budget_max"
          type="number"
          min="0"
          defaultValue={r?.budget_max ?? ""}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id("delivery_by")}>Delivery by</Label>
        <Input
          id={id("delivery_by")}
          name="delivery_by"
          type="date"
          defaultValue={r?.delivery_by ?? ""}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={id("bedrooms_min")}>Bedrooms min</Label>
        <Input
          id={id("bedrooms_min")}
          name="bedrooms_min"
          type="number"
          min="0"
          defaultValue={r?.bedrooms_min ?? ""}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id("bedrooms_max")}>Bedrooms max</Label>
        <Input
          id={id("bedrooms_max")}
          name="bedrooms_max"
          type="number"
          min="0"
          defaultValue={r?.bedrooms_max ?? ""}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id("bathrooms_min")}>Bathrooms min</Label>
        <Input
          id={id("bathrooms_min")}
          name="bathrooms_min"
          type="number"
          min="0"
          defaultValue={r?.bathrooms_min ?? ""}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={id("covered_area_min_sqm")}>Covered area min (m²)</Label>
        <Input
          id={id("covered_area_min_sqm")}
          name="covered_area_min_sqm"
          type="number"
          min="0"
          defaultValue={r?.covered_area_min_sqm ?? ""}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id("plot_area_min_sqm")}>Plot area min (m²)</Label>
        <Input
          id={id("plot_area_min_sqm")}
          name="plot_area_min_sqm"
          type="number"
          min="0"
          defaultValue={r?.plot_area_min_sqm ?? ""}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={id("max_sea_distance_m")}>Max distance to sea (m)</Label>
        <Input
          id={id("max_sea_distance_m")}
          name="max_sea_distance_m"
          type="number"
          min="0"
          defaultValue={r?.max_sea_distance_m ?? ""}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={id("vat_preference")}>VAT treatment</Label>
        <Select name="vat_preference" defaultValue={r?.vat_preference ?? SELECT_NONE}>
          <SelectTrigger id={id("vat_preference")}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECT_NONE}>—</SelectItem>
            {VAT_STATUSES.map((v) => (
              <SelectItem key={v} value={v}>
                {labelize(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-end gap-2 pb-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            name="title_deed_required"
            value="on"
            defaultChecked={r?.title_deed_required ?? false}
          />
          Separate title deed required
        </label>
      </div>

      <div className="flex flex-col gap-2 sm:col-span-3">
        <Label id={id("types-label")}>Property types</Label>
        <div
          role="group"
          aria-labelledby={id("types-label")}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {PROPERTY_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                name="property_types"
                value={t}
                defaultChecked={(r?.property_types ?? []).includes(t)}
              />
              {labelize(t)}
            </label>
          ))}
        </div>
        <p className="text-xs text-text-3">Leave all unticked to mean “any type”.</p>
      </div>

      <div className="flex flex-col gap-2 sm:col-span-3">
        <Label id={id("districts-label")}>Districts</Label>
        <div
          role="group"
          aria-labelledby={id("districts-label")}
          className="grid grid-cols-2 gap-2 sm:grid-cols-5"
        >
          {districts.map((d) => (
            <label key={d.id} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                name="district_ids"
                value={d.id}
                defaultChecked={(r?.district_ids ?? []).includes(d.id)}
              />
              {d.name}
            </label>
          ))}
        </div>
      </div>

      {areas.length > 0 ? (
        <div className="flex flex-col gap-2 sm:col-span-3">
          <Label id={id("areas-label")}>Areas</Label>
          <div
            role="group"
            aria-labelledby={id("areas-label")}
            className="grid max-h-44 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4"
          >
            {areas.map((a) => (
              <label key={a.id} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  name="area_ids"
                  value={a.id}
                  defaultChecked={(r?.area_ids ?? []).includes(a.id)}
                />
                {a.name}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:col-span-3">
        <Label id={id("features-label")}>Must have</Label>
        <div
          role="group"
          aria-labelledby={id("features-label")}
          className="grid max-h-44 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4"
        >
          {PROPERTY_FEATURES.map(([key, featureName]) => (
            <label key={key} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                name="features_required"
                value={key}
                defaultChecked={(r?.features_required ?? []).includes(key)}
              />
              {featureName}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:col-span-3">
        <Label htmlFor={id("notes")}>Notes</Label>
        <Textarea id={id("notes")} name="notes" rows={2} defaultValue={r?.notes ?? ""} />
      </div>
    </div>
  );
}

export function RequirementsCard({
  contactId,
  requirements,
  districts,
  areas,
  readOnly = false,
  readOnlyHint,
  legacyPreferences,
}: {
  contactId: string;
  requirements: RequirementRow[];
  districts: NamedOption[];
  areas: NamedOption[];
  readOnly?: boolean;
  readOnlyHint?: string;
  /** the pre-0043 blob, shown only while it still holds something no row does */
  legacyPreferences?: Record<string, unknown> | null;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const active = requirements.filter((r) => r.is_active);
  const archived = requirements.filter((r) => !r.is_active);

  const hasLegacy =
    legacyPreferences !== null &&
    legacyPreferences !== undefined &&
    Object.keys(legacyPreferences).length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* The pre-0043 blob is NOT dropped by the migration, and a silently
          ignored blob is data loss nobody notices. Shown until a row exists. */}
      {hasLegacy && requirements.length === 0 ? (
        <div className="rounded-[10px] border border-warning/40 bg-warning/5 p-4 text-sm">
          <p className="font-medium text-text-1">Older preferences are still on file</p>
          <p className="mt-1 text-text-2">
            This contact has preferences saved before saved searches existed. They are not used for
            matching. Add them as a search below and they can be matched against listings.
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-surface-2 p-2 text-xs text-text-2">
            {JSON.stringify(legacyPreferences, null, 2)}
          </pre>
        </div>
      ) : null}

      {active.length === 0 && !adding ? (
        <p className="text-sm text-text-2">
          No saved searches yet. Add one and this buyer starts appearing on matching listings.
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {active.map((r) => (
          <li key={r.id} className="rounded-[10px] border border-border bg-surface p-4">
            {editing === r.id ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-text-1">Edit search</p>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                    <X className="size-4" /> Cancel
                  </Button>
                </div>
                <ActionSectionForm
                  action={saveBuyerRequirement}
                  hidden={{ contact_id: contactId, requirement_id: r.id }}
                  readOnly={readOnly}
                  readOnlyHint={readOnlyHint}
                >
                  <RequirementFields r={r} districts={districts} areas={areas} />
                </ActionSectionForm>
              </div>
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-1">
                    {r.label || "Untitled search"}
                    <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-normal text-text-2">
                      {labelize(r.transaction_type)}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-text-2">{summarise(r, districts, areas)}</p>
                  {r.notes ? <p className="mt-1 text-xs text-text-3">{r.notes}</p> : null}
                </div>
                {!readOnly ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(r.id)}>
                      <Pencil className="size-4" /> Edit
                    </Button>
                    <ArchiveToggle id={r.id} nextActive={false} label="Archive" />
                  </div>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>

      {!readOnly ? (
        adding ? (
          <div className="rounded-[10px] border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-text-1">New search</p>
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                <X className="size-4" /> Cancel
              </Button>
            </div>
            <ActionSectionForm
              action={saveBuyerRequirement}
              hidden={{ contact_id: contactId }}
              submitLabel="Add search"
            >
              <RequirementFields districts={districts} areas={areas} />
            </ActionSectionForm>
          </div>
        ) : (
          <div>
            <Button variant="outline" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add search
            </Button>
          </div>
        )
      ) : null}

      {archived.length > 0 ? (
        <details className="rounded-[10px] border border-border bg-surface-2/40 p-4">
          <summary className="cursor-pointer text-sm text-text-2">
            Archived searches ({archived.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {archived.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-text-2">
                  {r.label || "Untitled search"} · {summarise(r, districts, areas)}
                </span>
                {!readOnly ? <ArchiveToggle id={r.id} nextActive label="Restore" /> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Archive/restore is one action in both directions; the flag says which.
 *
 * `useActionState` rather than a bare `action={fn.bind(...)}`: the action
 * returns a state object, which a plain form action cannot accept, and more to
 * the point a failure has to be visible. RLS or a concurrent edit can make this
 * a no-op, and a control that silently does nothing is the shape of audit
 * finding 1.
 */
function ArchiveToggle({
  id,
  nextActive,
  label,
}: {
  id: string;
  nextActive: boolean;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(setBuyerRequirementActive, {
    error: null,
    savedAt: null,
  });

  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  return (
    <form action={formAction}>
      <input type="hidden" name="requirement_id" value={id} />
      <input type="hidden" name="is_active" value={nextActive ? "on" : "off"} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "…" : label}
      </Button>
    </form>
  );
}
