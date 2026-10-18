"use client";

import Link from "next/link";
import { MapLocationFields } from "@/components/features/properties/map-location-fields";
import { PricingBreakdown } from "@/components/features/properties/pricing-breakdown";
import { VatLiveScope, VatTreatmentPanel } from "@/components/features/properties/vat-treatment";
import type { VatConfigRow } from "@/lib/services/vat";
import { PUBLISH_THRESHOLD } from "@/lib/services/quality-score";
import { SectionForm } from "@/components/features/properties/section-form";
import { MultilangTabs, type MultilangValue } from "@/components/features/shared/multilang-tabs";
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
  detailsFieldLabel,
  detailsLayout,
  recordedValues,
  type DetailsField,
  type DetailsGroup,
  type PropertyProfile,
} from "@/lib/services/property-layout";
import {
  AREA_NONE,
  CONSTRUCTION_STATUSES,
  ENERGY_CLASSES,
  PERMIT_STATUSES,
  PROPERTY_STATUSES,
  TITLE_DEED_STATUSES,
  TRANSACTION_TYPES,
  VAT_STATUS_LABELS,
  VAT_STATUSES,
  VISIBILITY_LEVELS,
  utilityFormValue,
} from "@/lib/validators/properties";
import type { AreaOption } from "@/components/features/properties/filters";

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function SelectField({
  name,
  label,
  options,
  defaultValue,
  placeholder,
}: {
  name: string;
  label: string;
  options: readonly string[] | { value: string; label: string }[];
  defaultValue?: string;
  placeholder?: string;
}) {
  const items =
    typeof options[0] === "string"
      ? (options as readonly string[]).map((o) => ({ value: o, label: labelize(o) }))
      : (options as { value: string; label: string }[]);
  return (
    <div className="flex flex-col gap-2">
      {/* id derived from `name` — unique within a form, so every SelectField
          in the property detail tabs gets an accessible name (A11Y-1) */}
      <Label htmlFor={`field-${name}`}>{label}</Label>
      <Select name={name} defaultValue={defaultValue ?? ""}>
        <SelectTrigger id={`field-${name}`}>
          <SelectValue placeholder={placeholder ?? "Select…"} />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function NumberField({
  name,
  label,
  defaultValue,
  step = "1",
}: {
  name: string;
  label: string;
  defaultValue: number | string | null;
  step?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type="number"
        step={step}
        defaultValue={defaultValue ?? ""}
      />
    </div>
  );
}

function TextField({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} defaultValue={defaultValue ?? ""} />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-2 text-base font-semibold text-text-1">{children}</h3>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PropertyDetailData {
  [key: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Construction-status options, plus whatever is already stored.
 *
 * The column is free `text` — the CSV importer and older rows may hold anything
 * — so a value outside the list is kept as its own option. Dropping it would
 * make the select show a different status than the record holds, and the next
 * save would silently write that different status.
 */
function constructionOptions(current: string | null) {
  const options = [
    { value: "", label: "—" },
    ...CONSTRUCTION_STATUSES.map((c) => ({
      value: c,
      label: c.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase()),
    })),
  ];
  if (current && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: `${current} (as recorded)` });
  }
  return options;
}

/** Water / electricity on a plot: three answers, because "not known" is one (F07). */
const UTILITY_OPTIONS = [
  { value: "unknown", label: "Not known" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

type FieldContext = {
  property: PropertyDetailData;
  profile: PropertyProfile;
  districtAreas: AreaOption[];
};

/**
 * One field of the Details tab, by name. Every field the layout can name has
 * a case here, and the switch is exhaustive — a field added to
 * DETAILS_FIELDS without a control fails the typecheck rather than rendering
 * nothing (and a field that renders nothing is a field the save nulls).
 */
function DetailsFieldControl({ field, ctx }: { field: DetailsField; ctx: FieldContext }) {
  const p = ctx.property;
  const label = detailsFieldLabel(field, ctx.profile);
  switch (field) {
    case "status":
      return <SelectField name={field} label={label} options={PROPERTY_STATUSES} defaultValue={p.status} />;
    case "visibility":
      return <SelectField name={field} label={label} options={VISIBILITY_LEVELS} defaultValue={p.visibility} />;
    case "transaction_type":
      return (
        <SelectField
          name={field}
          label={label}
          options={TRANSACTION_TYPES}
          defaultValue={p.transaction_type}
        />
      );
    case "area_id":
      return (
        <SelectField
          name={field}
          label={label}
          options={[
            { value: AREA_NONE, label: "— (no area)" },
            ...ctx.districtAreas.map((a) => ({ value: a.id, label: a.name })),
          ]}
          defaultValue={p.area_id ?? AREA_NONE}
          placeholder={ctx.districtAreas.length ? "Select area…" : "No areas for district"}
        />
      );
    case "address":
    case "postal_code":
    case "planning_zone_code":
      return <TextField name={field} label={label} defaultValue={p[field]} />;
    case "location":
      return (
        <MapLocationFields
          location={p.location}
          propertyId={p.id}
          isApproximate={Boolean((p as { location_approx?: boolean }).location_approx)}
        />
      );
    case "amenities_notes":
      return (
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor={field}>{label}</Label>
          <Input id={field} name={field} defaultValue={p.amenities_notes ?? ""} />
        </div>
      );
    case "asking_price":
    case "min_acceptable_price":
    case "owner_net_price":
    case "rent_price_month":
    case "covered_area_sqm":
    case "plot_area_sqm":
    case "veranda_sqm":
    case "roof_garden_sqm":
    case "basement_sqm":
    case "building_density_pct":
    case "coverage_ratio_pct":
    case "max_height_m":
    case "road_frontage_m":
      return <NumberField name={field} label={label} defaultValue={p[field]} step="0.01" />;
    case "sea_distance_m":
    case "bedrooms":
    case "bathrooms":
    case "wc":
    case "parking_spaces":
    case "floor_number":
    case "total_floors":
    case "year_built":
    case "max_floors":
      return <NumberField name={field} label={label} defaultValue={p[field]} />;
    case "vat_status":
      // F01: labels that say whether VAT applies — "New vat" / "Unknown" read
      // as kinds of sale; "Unknown (not confirmed)" reads as what it is
      return (
        <SelectField
          name={field}
          label={label}
          options={VAT_STATUSES.map((v) => ({ value: v, label: VAT_STATUS_LABELS[v] }))}
          defaultValue={p.vat_status}
        />
      );
    case "energy_class":
      return (
        <SelectField
          name={field}
          label={label}
          options={ENERGY_CLASSES.map((e) => ({ value: e, label: e === "none" ? "—" : e }))}
          defaultValue={p.energy_class ?? "none"}
        />
      );
    case "construction_status":
      return (
        <SelectField
          name={field}
          label={label}
          options={constructionOptions(p.construction_status)}
          defaultValue={p.construction_status ?? ""}
        />
      );
    case "delivery_date":
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field}>{label}</Label>
          <Input id={field} name={field} type="date" defaultValue={p.delivery_date ?? ""} />
        </div>
      );
    case "water_available":
    case "electricity_available":
      return (
        <SelectField
          name={field}
          label={label}
          options={UTILITY_OPTIONS}
          defaultValue={utilityFormValue(p[field])}
        />
      );
    case "constraints_notes":
      return (
        <div className="flex flex-col gap-2">
          <Label htmlFor={field}>{label}</Label>
          <Textarea id={field} name={field} rows={3} defaultValue={p.constraints_notes ?? ""} />
        </div>
      );
    case "features":
      // ONE array, posted whole: every box is always rendered, in one place,
      // whatever the layout — leaving some out would drop their keys on save.
      // Storage room is one of these boxes and nowhere else (F02, 0152).
      return (
        <>
          {PROPERTY_FEATURES.map(([key, featureLabel]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-text-1">
              <Checkbox
                name="features"
                value={key}
                defaultChecked={(p.features ?? []).includes(key)}
              />
              {featureLabel}
            </label>
          ))}
        </>
      );
    case "internal_notes":
      return (
        <Textarea
          name={field}
          rows={4}
          defaultValue={p.internal_notes ?? ""}
          placeholder="Never shown outside the team"
        />
      );
    default: {
      const unhandled: never = field;
      throw new Error(`Details field without a control: ${String(unhandled)}`);
    }
  }
}

/** The grid each group's fields sit in. */
function groupGrid(g: DetailsGroup): string {
  switch (g.id) {
    case "features":
      return "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4";
    case "internal_notes":
    case "constraints":
      return "flex flex-col gap-4";
    case "listing":
    case "location":
      return "grid gap-4 sm:grid-cols-2 lg:grid-cols-3";
    case "build_handover":
      return g.fields.length > 3
        ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3";
    default:
      return "grid gap-4 sm:grid-cols-2 lg:grid-cols-4";
  }
}

export function DetailsForm({
  property,
  areas,
  isAdmin = false,
  readOnly = false,
  commissionPct = null,
  vatConfig = null,
  vatConfigVerifiedAt = null,
}: {
  property: PropertyDetailData;
  areas: AreaOption[];
  isAdmin?: boolean;
  readOnly?: boolean;
  /** from the ACTIVE mandate via `mandates_safe`, which returns null unless the
   *  reader is an admin or this property's assigned agent — that masking is the
   *  permission check, so this is passed straight through */
  commissionPct?: number | string | null;
  /** `cyprus_config.vat_property`. NOTHING is derived without it — the
   *  panel refuses rather than falling back to a hardcoded rate. */
  vatConfig?: VatConfigRow | null;
  vatConfigVerifiedAt?: string | null;
}) {
  // F07: laid out for the kind of property — land opens on its planning, a
  // development on its build and handover — and nothing is ever left out: a
  // group that does not suit the property is collapsed into a native
  // <details>, whose inputs still post (lib/services/property-layout.ts says
  // why, and its test pins every field to the column the save writes).
  const layout = detailsLayout({
    property_type: property.property_type,
    kind: property.kind,
    transaction_type: property.transaction_type,
  });
  const ctx: FieldContext = {
    property,
    profile: layout.profile,
    districtAreas: areas.filter((a) => a.districtId === property.district_id),
  };
  const isContainer = layout.profile === "container";

  const fieldsOf = (g: DetailsGroup) =>
    g.fields.map((f) => <DetailsFieldControl key={f} field={f} ctx={ctx} />);

  const renderGroup = (g: DetailsGroup) => {
    // NATIVE <details>, never Radix Collapsible/Accordion: those unmount their
    // content while closed, so its inputs would not post and the save would
    // null every value inside. Open when it holds anything, and the summary
    // says what, so a stray value (a bedroom count on a plot, which the feed
    // publishes) is never out of sight.
    if (g.collapsed) {
      const recorded = recordedValues(g, property, layout.profile);
      return (
        <details
          key={g.id}
          data-details-group={g.id}
          open={recorded.length > 0}
          className="rounded-[10px] border border-border px-4 py-3"
        >
          <summary className="cursor-pointer text-sm text-text-2">
            <span className="text-base font-semibold text-text-1">{g.heading}</span>
            {` — ${g.collapsed} · `}
            {recorded.length === 0
              ? "nothing recorded"
              : `${recorded.length} recorded: ${recorded.join(", ")}`}
          </summary>
          <div className={`mt-4 ${groupGrid(g)}`}>{fieldsOf(g)}</div>
        </details>
      );
    }

    if (g.id === "pricing") {
      return (
        <div key={g.id} data-details-group={g.id} className="flex flex-col gap-4">
          <SectionTitle>{g.heading}</SectionTitle>
          {isContainer ? (
            // "From price", exactly as the create wizard and the overview call
            // it: on 2026-09-05 PAF0002 held 4,850,000 here — a whole
            // development's total typed into a field labelled "Asking price".
            // The units carry the prices; this says where they are.
            <p className="text-sm text-text-2">
              Each unit carries its own price and availability —{" "}
              <Link
                href={`/properties/${property.id}/units`}
                className="font-medium text-brand-700 hover:underline"
              >
                Units matrix
              </Link>
              . This is the figure the listing leads with.
            </p>
          ) : null}
          <PricingBreakdown
            commissionPct={commissionPct}
            askingPrice={property.asking_price}
            minAcceptablePrice={property.min_acceptable_price}
            ownerNetPrice={property.owner_net_price}
          >
            <div className={groupGrid(g)}>{fieldsOf(g)}</div>
          </PricingBreakdown>
          {/* VAT is DERIVED, not read from `vat_status`: right after the price,
              live from the whole form (the covered area may sit in another
              group, collapsed or not) — see vat-treatment.tsx */}
          <VatTreatmentPanel
            config={vatConfig}
            configVerifiedAt={vatConfigVerifiedAt}
            // F01: the reduced rate is for a dwelling. A development is judged
            // by its units (a "building" project's flats are apartments), so
            // its own type does not gate it — the same rule createProperty
            // applies when it decides what the generated units are
            propertyType={isContainer ? null : property.property_type}
            propertyId={property.id}
          />
        </div>
      );
    }

    return (
      <div key={g.id} data-details-group={g.id} className="flex flex-col gap-4">
        {g.heading ? <SectionTitle>{g.heading}</SectionTitle> : null}
        {g.note ? <p className="-mt-2 text-sm text-text-2">{g.note}</p> : null}
        <div className={groupGrid(g)}>
          {fieldsOf(g)}
          {g.id === "listing" && isAdmin ? (
            <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
              <Checkbox id="publish_override" name="publish_override" />
              <Label htmlFor="publish_override" className="text-text-2">
                Override publish gate (admin) — allows visibility “Public” below score{" "}
                {PUBLISH_THRESHOLD}; the override is written to the event log
              </Label>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <SectionForm
      propertyId={property.id}
      section="details"
      readOnly={readOnly}
      updatedAt={property.updated_at}
    >
      {/* the VAT panel's listener wraps EVERY group, so the price and the
          covered area refresh it wherever the layout puts them */}
      <VatLiveScope
        askingPrice={property.asking_price}
        coveredAreaSqm={property.covered_area_sqm}
        vatStatus={property.vat_status}
      >
        {layout.groups.map(renderGroup)}
      </VatLiveScope>
    </SectionForm>
  );
}

export function LegalForm({
  property,
  readOnly = false,
}: {
  property: PropertyDetailData;
  readOnly?: boolean;
}) {
  return (
    <SectionForm
      propertyId={property.id}
      section="legal"
      readOnly={readOnly}
      updatedAt={property.updated_at}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="title_deed_status"
          label="Title deed status"
          options={TITLE_DEED_STATUSES}
          defaultValue={property.title_deed_status}
        />
        <SelectField
          name="permit_status"
          label="Permit status"
          options={PERMIT_STATUSES}
          defaultValue={property.permit_status}
        />
        <TextField
          name="share_of_land"
          label="Share of land"
          defaultValue={property.share_of_land}
        />
        {/* DLS identity (0077, DB-05) — as the title deed prints them. The
            registration number doubles as the duplicate-detection signal. */}
        <TextField
          name="registration_no"
          label="Registration no. (DLS)"
          defaultValue={property.registration_no}
        />
        <TextField name="plot_no" label="Plot no." defaultValue={property.plot_no} />
        <TextField name="sheet_plan" label="Sheet / plan" defaultValue={property.sheet_plan} />
        <TextField
          name="registry_municipality"
          label="Registry municipality"
          defaultValue={property.registry_municipality}
        />
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="encumbrances_notes">Encumbrances</Label>
          <Textarea
            id="encumbrances_notes"
            name="encumbrances_notes"
            rows={4}
            defaultValue={property.encumbrances_notes ?? ""}
          />
        </div>
      </div>
    </SectionForm>
  );
}

export function MarketingForm({
  property,
  readOnly = false,
}: {
  property: PropertyDetailData;
  readOnly?: boolean;
}) {
  return (
    <SectionForm
      propertyId={property.id}
      section="marketing"
      readOnly={readOnly}
      updatedAt={property.updated_at}
    >
      <MultilangTabs
        name="title"
        label="Title"
        defaultValue={(property.title ?? {}) as MultilangValue}
      />
      <MultilangTabs
        name="short_description"
        label="Short description"
        defaultValue={(property.short_description ?? {}) as MultilangValue}
        multiline
        rows={3}
      />
      {/* Between the summary and the long description on purpose: it is the
          block the listing page leads with, and the order here mirrors the page.
          Left empty, the site never claims a view that was not written: it
          shows the summary under an honest "Summary" heading instead — unless
          the summary merely repeats the opening of the long description, in
          which case it shows nothing there (PAF0003 is that case; the guard
          lives in gnk-web's listing page). */}
      <MultilangTabs
        name="adviser_view"
        label="Our view — your judgement on this property, 80–120 words"
        defaultValue={(property.adviser_view ?? {}) as MultilangValue}
        multiline
        rows={5}
      />
      <MultilangTabs
        name="public_description"
        label="Public description"
        defaultValue={(property.public_description ?? {}) as MultilangValue}
        multiline
        rows={8}
      />
    </SectionForm>
  );
}
