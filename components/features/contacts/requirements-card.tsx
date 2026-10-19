"use client";

import { Fragment, useActionState, useEffect, useState, type ReactNode } from "react";
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
import {
  BUDGET_TOLERANCE_PCT,
  HARD_REQUIREMENT_FIELDS,
  SOFT_REQUIREMENT_FIELDS,
  unstatedCriteria,
  type HardRequirementField,
  type SoftRequirementField,
} from "@/lib/services/matching";
import { SELECT_NONE } from "@/lib/validators/contacts";
import { PROPERTY_TYPES, TRANSACTION_TYPES, VAT_STATUSES } from "@/lib/validators/properties";
import { formatMoney } from "@/lib/utils/format";

/**
 * Saved buyer searches on the contact page (0043, T-B4).
 *
 * Several per buyer, because a real one has several: "2-bed under €300k in Kato
 * Paphos" AND "any plot over 500 m² in Tala". `contacts.preferences` could hold
 * one, unstructured and unindexed, which is why 0043 exists.
 *
 * MUST MATCH vs PREFERENCES (A04). The matcher treats some fields as HARD — a
 * listing that misses one is not shown — and the rest as SOFT — a miss lowers
 * the score and is named. The form used to lay them all out alike, so nothing
 * told the desk that ticking "Separate title deed required" hides every
 * listing with a pending deed while "Bathrooms min" only ranks. The two groups
 * below are rendered FROM the engine's own lists (HARD_REQUIREMENT_FIELDS /
 * SOFT_REQUIREMENT_FIELDS in lib/services/matching.ts, pinned field by field
 * in matching.test.ts), so they cannot say something the matcher does not do.
 * And each search says what it leaves open ("Not stated: location, bedrooms").
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

/** "Not stated: location, bedrooms" — what the desk still has to ask. Null when all four are stated. */
function notStated(r: RequirementRow): string | null {
  const open = unstatedCriteria(r);
  return open.length ? `Not stated: ${open.join(", ")}` : null;
}

type FieldContext = {
  r?: RequirementRow;
  districts: NamedOption[];
  areas: NamedOption[];
  /** a control id unique to this form */
  id: (name: string) => string;
};

function NumberField({ ctx, name, label }: { ctx: FieldContext; name: keyof RequirementRow; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={ctx.id(name)}>{label}</Label>
      <Input
        id={ctx.id(name)}
        name={name}
        type="number"
        min="0"
        defaultValue={(ctx.r?.[name] as number | null | undefined) ?? ""}
      />
    </div>
  );
}

function CheckboxGroup({
  ctx,
  name,
  label,
  options,
  scroll = false,
  hint,
}: {
  ctx: FieldContext;
  name: "property_types" | "district_ids" | "area_ids" | "features_required";
  label: string;
  options: { value: string; text: string }[];
  scroll?: boolean;
  hint?: string;
}) {
  const chosen = ctx.r?.[name] ?? [];
  return (
    <div className="flex flex-col gap-2 sm:col-span-3">
      <Label id={ctx.id(`${name}-label`)}>{label}</Label>
      <div
        role="group"
        aria-labelledby={ctx.id(`${name}-label`)}
        className={
          scroll
            ? "grid max-h-44 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4"
            : "grid grid-cols-2 gap-2 sm:grid-cols-4"
        }
      >
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1.5 text-sm">
            <Checkbox name={name} value={o.value} defaultChecked={chosen.includes(o.value)} />
            {o.text}
          </label>
        ))}
      </div>
      {hint ? <p className="text-xs text-text-3">{hint}</p> : null}
    </div>
  );
}

/**
 * One renderer per requirement field. A `Record` over BOTH engine lists, so a
 * field the engine gains and the form forgets is a type error, and the groups
 * below are drawn by mapping the engine's lists over this — never by hand.
 */
const FIELDS: Record<HardRequirementField | SoftRequirementField, (ctx: FieldContext) => ReactNode> = {
  transaction_type: (ctx) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={ctx.id("transaction_type")}>Buying or renting</Label>
      <Select name="transaction_type" defaultValue={ctx.r?.transaction_type ?? "sale"}>
        <SelectTrigger id={ctx.id("transaction_type")}>
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
  ),
  budget_max: (ctx) => <NumberField ctx={ctx} name="budget_max" label="Budget max (€)" />,
  bedrooms_min: (ctx) => <NumberField ctx={ctx} name="bedrooms_min" label="Bedrooms min" />,
  bedrooms_max: (ctx) => <NumberField ctx={ctx} name="bedrooms_max" label="Bedrooms max" />,
  title_deed_required: (ctx) => (
    <div className="flex items-end gap-2 pb-2">
      <label htmlFor={ctx.id("title_deed_required")} className="flex items-center gap-2 text-sm">
        <Checkbox
          id={ctx.id("title_deed_required")}
          name="title_deed_required"
          value="on"
          defaultChecked={ctx.r?.title_deed_required ?? false}
        />
        Separate title deed required
      </label>
    </div>
  ),
  property_types: (ctx) => (
    <CheckboxGroup
      ctx={ctx}
      name="property_types"
      label="Property types"
      options={PROPERTY_TYPES.map((t) => ({ value: t, text: labelize(t) }))}
      hint="Leave all unticked to mean “any type”."
    />
  ),
  district_ids: (ctx) => (
    <CheckboxGroup
      ctx={ctx}
      name="district_ids"
      label="Districts"
      options={ctx.districts.map((d) => ({ value: d.id, text: d.name }))}
      hint="Leave all unticked to mean “anywhere”."
    />
  ),
  budget_min: (ctx) => <NumberField ctx={ctx} name="budget_min" label="Budget min (€)" />,
  delivery_by: (ctx) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={ctx.id("delivery_by")}>Delivery by</Label>
      <Input
        id={ctx.id("delivery_by")}
        name="delivery_by"
        type="date"
        defaultValue={ctx.r?.delivery_by ?? ""}
      />
    </div>
  ),
  vat_preference: (ctx) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={ctx.id("vat_preference")}>VAT treatment</Label>
      <Select name="vat_preference" defaultValue={ctx.r?.vat_preference ?? SELECT_NONE}>
        <SelectTrigger id={ctx.id("vat_preference")}>
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
  ),
  bathrooms_min: (ctx) => <NumberField ctx={ctx} name="bathrooms_min" label="Bathrooms min" />,
  covered_area_min_sqm: (ctx) => (
    <NumberField ctx={ctx} name="covered_area_min_sqm" label="Covered area min (m²)" />
  ),
  plot_area_min_sqm: (ctx) => <NumberField ctx={ctx} name="plot_area_min_sqm" label="Plot area min (m²)" />,
  max_sea_distance_m: (ctx) => (
    <NumberField ctx={ctx} name="max_sea_distance_m" label="Max distance to sea (m)" />
  ),
  area_ids: (ctx) =>
    ctx.areas.length > 0 ? (
      <CheckboxGroup
        ctx={ctx}
        name="area_ids"
        label="Areas"
        options={ctx.areas.map((a) => ({ value: a.id, text: a.name }))}
        scroll
      />
    ) : null,
  features_required: (ctx) => (
    <CheckboxGroup
      ctx={ctx}
      name="features_required"
      label="Features wanted"
      options={PROPERTY_FEATURES.map(([key, featureName]) => ({ value: key, text: featureName }))}
      scroll
    />
  ),
};

/** Exported for tests/unit/requirements-form-groups.test.ts, which renders it. */
export function RequirementFields({
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
  const ctx: FieldContext = { r, districts, areas, id: (n) => `${n}-${uid}` };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor={ctx.id("label")}>Name this search</Label>
        <Input
          id={ctx.id("label")}
          name="label"
          maxLength={120}
          placeholder="Sea view 2-bed, Kato Paphos"
          defaultValue={r?.label ?? ""}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-[8px] border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold text-text-1">Must match</h3>
          <p className="text-xs text-text-2">
            A listing that misses any of these is not shown. The budget allows {BUDGET_TOLERANCE_PCT}% over —
            those still show, marked with how much.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {HARD_REQUIREMENT_FIELDS.map((f) => (
            <Fragment key={f}>{FIELDS[f](ctx)}</Fragment>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-[8px] border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold text-text-1">Preferences</h3>
          <p className="text-xs text-text-2">
            These rank listings and are named when missed — they never hide one.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {SOFT_REQUIREMENT_FIELDS.map((f) => (
            <Fragment key={f}>{FIELDS[f](ctx)}</Fragment>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={ctx.id("notes")}>Notes</Label>
        <Textarea id={ctx.id("notes")} name="notes" rows={2} defaultValue={r?.notes ?? ""} />
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
}: {
  contactId: string;
  requirements: RequirementRow[];
  districts: NamedOption[];
  areas: NamedOption[];
  readOnly?: boolean;
  readOnlyHint?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const active = requirements.filter((r) => r.is_active);
  const archived = requirements.filter((r) => !r.is_active);

  return (
    <div className="flex flex-col gap-4">
      {active.length === 0 && !adding ? (
        <p className="text-sm text-text-2">
          No saved searches yet. Add one and this buyer starts appearing on matching listings.
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {active.map((r) => {
          const open = notStated(r);
          return (
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
                    {open ? (
                      <p className="mt-1 text-xs text-warning">
                        {open} — matches ignore what was not said; ask the buyer.
                      </p>
                    ) : null}
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
          );
        })}
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
