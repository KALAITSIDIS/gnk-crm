"use client";

import { MapLocationFields } from "@/components/features/properties/map-location-fields";
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
  AREA_NONE,
  ENERGY_CLASSES,
  PERMIT_STATUSES,
  PROPERTY_STATUSES,
  TITLE_DEED_STATUSES,
  TRANSACTION_TYPES,
  VAT_STATUSES,
  VISIBILITY_LEVELS,
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

export function DetailsForm({
  property,
  areas,
  isAdmin = false,
  readOnly = false,
}: {
  property: PropertyDetailData;
  areas: AreaOption[];
  isAdmin?: boolean;
  readOnly?: boolean;
}) {
  const districtAreas = areas.filter((a) => a.districtId === property.district_id);
  const isLand = property.property_type === "land";

  return (
    <SectionForm propertyId={property.id} section="details" readOnly={readOnly}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          name="status"
          label="Status"
          options={PROPERTY_STATUSES}
          defaultValue={property.status}
        />
        <SelectField
          name="visibility"
          label="Visibility"
          options={VISIBILITY_LEVELS}
          defaultValue={property.visibility}
        />
        <SelectField
          name="transaction_type"
          label="Transaction"
          options={TRANSACTION_TYPES}
          defaultValue={property.transaction_type}
        />
        {isAdmin ? (
          <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
            <Checkbox id="publish_override" name="publish_override" />
            <Label htmlFor="publish_override" className="text-text-2">
              Override publish gate (admin) — allows visibility “Public” below score{" "}
              70; the override is written to the event log
            </Label>
          </div>
        ) : null}
      </div>

      <SectionTitle>Location</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          name="area_id"
          label="Area"
          options={[
            { value: AREA_NONE, label: "— (no area)" },
            ...districtAreas.map((a) => ({ value: a.id, label: a.name })),
          ]}
          defaultValue={property.area_id ?? AREA_NONE}
          placeholder={districtAreas.length ? "Select area…" : "No areas for district"}
        />
        <TextField name="address" label="Address" defaultValue={property.address} />
        <TextField name="postal_code" label="Postal code" defaultValue={property.postal_code} />
        <NumberField
          name="sea_distance_m"
          label="Sea distance (m)"
          defaultValue={property.sea_distance_m}
        />
        <MapLocationFields location={property.location} />
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="amenities_notes">Amenities notes</Label>
          <Input
            id="amenities_notes"
            name="amenities_notes"
            defaultValue={property.amenities_notes ?? ""}
          />
        </div>
      </div>

      <SectionTitle>Pricing</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <NumberField name="asking_price" label="Asking price (€)" defaultValue={property.asking_price} step="0.01" />
        <NumberField
          name="min_acceptable_price"
          label="Min acceptable (€)"
          defaultValue={property.min_acceptable_price}
          step="0.01"
        />
        <NumberField
          name="owner_net_price"
          label="Owner net (€)"
          defaultValue={property.owner_net_price}
          step="0.01"
        />
        <NumberField
          name="rent_price_month"
          label="Rent (€/month)"
          defaultValue={property.rent_price_month}
          step="0.01"
        />
        <SelectField
          name="vat_status"
          label="VAT status"
          options={VAT_STATUSES}
          defaultValue={property.vat_status}
        />
      </div>

      <SectionTitle>Areas & rooms</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <NumberField name="covered_area_sqm" label="Covered (m²)" defaultValue={property.covered_area_sqm} step="0.01" />
        <NumberField name="plot_area_sqm" label="Plot (m²)" defaultValue={property.plot_area_sqm} step="0.01" />
        <NumberField name="veranda_sqm" label="Veranda (m²)" defaultValue={property.veranda_sqm} step="0.01" />
        <NumberField name="roof_garden_sqm" label="Roof garden (m²)" defaultValue={property.roof_garden_sqm} step="0.01" />
        <NumberField name="basement_sqm" label="Basement (m²)" defaultValue={property.basement_sqm} step="0.01" />
        <NumberField name="bedrooms" label="Bedrooms" defaultValue={property.bedrooms} />
        <NumberField name="bathrooms" label="Bathrooms" defaultValue={property.bathrooms} />
        <NumberField name="wc" label="WC" defaultValue={property.wc} />
        <NumberField name="parking_spaces" label="Parking spaces" defaultValue={property.parking_spaces} />
        <NumberField name="floor_number" label="Floor" defaultValue={property.floor_number} />
        <NumberField name="total_floors" label="Total floors" defaultValue={property.total_floors} />
        <NumberField name="year_built" label="Year built" defaultValue={property.year_built} />
        <SelectField
          name="energy_class"
          label="Energy class"
          options={ENERGY_CLASSES.map((e) => ({ value: e, label: e === "none" ? "—" : e }))}
          defaultValue={property.energy_class ?? "none"}
        />
        <div className="flex items-end gap-2 pb-2">
          <Checkbox
            id="has_storage"
            name="has_storage"
            defaultChecked={property.has_storage === true}
          />
          <Label htmlFor="has_storage">Storage room</Label>
        </div>
      </div>

      <SectionTitle>Features</SectionTitle>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {PROPERTY_FEATURES.map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm text-text-1">
            <Checkbox
              name="features"
              value={key}
              defaultChecked={(property.features ?? []).includes(key)}
            />
            {label}
          </label>
        ))}
      </div>

      {isLand ? (
        <>
          <SectionTitle>Land / planning</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <TextField
              name="planning_zone_code"
              label="Planning zone (e.g. Κα6)"
              defaultValue={property.planning_zone_code}
            />
            <NumberField
              name="building_density_pct"
              label="Building density (%)"
              defaultValue={property.building_density_pct}
              step="0.01"
            />
            <NumberField
              name="coverage_ratio_pct"
              label="Coverage ratio (%)"
              defaultValue={property.coverage_ratio_pct}
              step="0.01"
            />
            <NumberField name="max_floors" label="Max floors" defaultValue={property.max_floors} />
            <NumberField
              name="max_height_m"
              label="Max height (m)"
              defaultValue={property.max_height_m}
              step="0.01"
            />
            <NumberField
              name="road_frontage_m"
              label="Road frontage (m)"
              defaultValue={property.road_frontage_m}
              step="0.01"
            />
            <div className="flex items-end gap-2 pb-2">
              <Checkbox
                id="water_available"
                name="water_available"
                defaultChecked={property.water_available === true}
              />
              <Label htmlFor="water_available">Water available</Label>
            </div>
            <div className="flex items-end gap-2 pb-2">
              <Checkbox
                id="electricity_available"
                name="electricity_available"
                defaultChecked={property.electricity_available === true}
              />
              <Label htmlFor="electricity_available">Electricity available</Label>
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-4">
              <Label htmlFor="constraints_notes">Constraints (archaeology, forestry…)</Label>
              <Textarea
                id="constraints_notes"
                name="constraints_notes"
                rows={3}
                defaultValue={property.constraints_notes ?? ""}
              />
            </div>
          </div>
        </>
      ) : null}

      <SectionTitle>Internal notes</SectionTitle>
      <Textarea
        name="internal_notes"
        rows={4}
        defaultValue={property.internal_notes ?? ""}
        placeholder="Never shown outside the team"
      />
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
    <SectionForm propertyId={property.id} section="legal" readOnly={readOnly}>
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
    <SectionForm propertyId={property.id} section="marketing" readOnly={readOnly}>
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
