"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import {
  checkPropertyDuplicate,
  createProperty,
  type PropertyActionState,
} from "@/lib/actions/properties";
import type { PropertyDuplicateMatch } from "@/lib/services/property-duplicate";
import {
  CREATABLE_KINDS,
  LISTING_SOURCES,
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
  type ListingSource,
} from "@/lib/validators/properties";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { getPartyDefaults } from "@/lib/actions/party-defaults";
import type { EntityOption } from "@/lib/actions/entity-search";
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
import type { AreaOption, DistrictOption } from "@/components/features/properties/filters";

const initialState: PropertyActionState = { error: null };

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function CreatePropertyWizard({
  districts,
  areas,
}: {
  districts: (DistrictOption & { code: string })[];
  areas: AreaOption[];
}) {
  const [state, formAction, pending] = useActionState(createProperty, initialState);
  const [step, setStep] = useState<1 | 2>(1);

  // step 1 values (kept in state so both steps submit in one form)
  const [source, setSource] = useState<ListingSource>("owner");
  const [party, setParty] = useState<EntityOption | null>(null);
  const [partyTerms, setPartyTerms] = useState<{
    labels: string[];
    from: string;
  } | null>(null);
  const [kind, setKind] = useState<string>("standalone");
  const [propertyType, setPropertyType] = useState<string>("");
  const [transaction, setTransaction] = useState<string>("sale");
  const [districtId, setDistrictId] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  // The result is stored WITH the address it was for, so a slow answer for an
  // old address cannot be shown against a new one — and so the effect never
  // has to clear state synchronously, which cascades renders.
  const [found, setFound] = useState<{
    forAddress: string;
    match: PropertyDuplicateMatch | null;
  } | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live duplicate check (audit finding 13). It WARNS — the submit button stays
  // enabled, because two genuinely different units share a building and a guard
  // that refuses them is a guard people learn to work around.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!districtId || address.trim().length < 3) return;
    const forAddress = address;
    debounce.current = setTimeout(async () => {
      setFound({ forAddress, match: await checkPropertyDuplicate(districtId, forAddress) });
    }, 400);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [districtId, address]);

  const duplicate = found && found.forAddress === address ? found.match : null;

/**
   * Choosing the party fills what it implies (migration 0038).
   *
   * The terms shown here are for the HUMAN — the action re-resolves them
   * server-side before writing, because a form can post anything and these set
   * a VAT treatment and a legal status on a record the desk will quote from.
   *
   * The district is only taken when the user has not already chosen one: their
   * explicit answer outranks the party's usual.
   */
  const onPartyChange = async (option: EntityOption | null) => {
    setParty(option);
    if (!option) {
      setPartyTerms(null);
      return;
    }
    const { defaults, source: origin, partyName } = await getPartyDefaults(option.id);
    if (defaults.district_id && !districtId) setDistrictId(defaults.district_id);

    const labels: string[] = [];
    if (defaults.vat_status) labels.push(`VAT ${labelize(defaults.vat_status)}`);
    if (defaults.title_deed_status) labels.push(`deed ${defaults.title_deed_status}`);
    if (defaults.permit_status) labels.push(`permit ${defaults.permit_status}`);
    setPartyTerms(
      labels.length > 0
        ? {
            labels,
            from: Object.values(origin).includes("party")
              ? (partyName ?? "this contact")
              : "the office standard",
          }
        : null,
    );
  };

  const changeSource = (next: ListingSource) => {
    setSource(next);
    // the party belongs to the source that chose it — keeping it would attach a
    // developer to a private owner's villa
    setParty(null);
    setPartyTerms(null);
    setKind(next === "developer" ? "project" : "standalone");
  };

  const district = districts.find((d) => d.id === districtId);
  const districtAreas = areas.filter((a) => a.districtId === districtId);
  const isLand = propertyType === "land";
  // sale_or_rent listings carry both prices
  const showRent = transaction === "rent" || transaction === "sale_or_rent";
  const showAsking = transaction !== "rent";
  const step1Valid = kind && propertyType && districtId;

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-6">
      {/* step-1 values always travel with the form */}
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="source" value={source} />
      <input
        type="hidden"
        name={source === "developer" ? "developer_contact_id" : "owner_contact_id"}
        value={party?.id ?? ""}
      />
      <input type="hidden" name="property_type" value={propertyType} />
      <input type="hidden" name="transaction_type" value={transaction} />
      <input type="hidden" name="district_id" value={districtId} />

      <div className="flex items-center gap-2 text-sm text-text-2">
        <span className={step === 1 ? "font-semibold text-text-1" : ""}>1. Kind & location</span>
        <ArrowRight className="size-3.5" />
        <span className={step === 2 ? "font-semibold text-text-1" : ""}>2. Core details</span>
      </div>

      {step === 1 ? (
        <div className="flex flex-col gap-4 rounded-[10px] border border-border bg-surface p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="source">Where is it from?</Label>
              <Select value={source} onValueChange={(v) => changeSource(v as ListingSource)}>
                <SelectTrigger id="source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LISTING_SOURCES.map((sc) => (
                    <SelectItem key={sc} value={sc}>
                      {sc === "owner" ? "A private owner" : "A developer"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2 sm:col-span-2">
              <EntityPicker
                key={source}
                name={`party-${source}`}
                kind="contact"
                label={source === "developer" ? "Developer" : "Owner"}
                placeholder={source === "developer" ? "Search developers…" : "Search owners…"}
                contactTypes={
                  source === "developer" ? ["developer"] : ["owner", "seller", "landlord"]
                }
                hint="Their standard terms fill the rest — every value stays editable."
                onChange={onPartyChange}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="kind">Kind</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger id="kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREATABLE_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k === "standalone" ? "Standalone listing" : "Developer project"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-text-3">Units are added from the project page later.</p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="property_type">Property type</Label>
              <Select value={propertyType} onValueChange={setPropertyType}>
                <SelectTrigger id="property_type">
                  <SelectValue placeholder="Select type…" />
                </SelectTrigger>
                <SelectContent>
                  {PROPERTY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {labelize(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="transaction_type">Transaction</Label>
              <Select value={transaction} onValueChange={setTransaction}>
                <SelectTrigger id="transaction_type">
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
              <Label htmlFor="district_id">District</Label>
              <Select value={districtId} onValueChange={setDistrictId}>
                <SelectTrigger id="district_id">
                  <SelectValue placeholder="Select district…" />
                </SelectTrigger>
                <SelectContent>
                  {districts.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {partyTerms ? (
            <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-text-2">
              From {partyTerms.from}: {partyTerms.labels.join(" · ")}. Applied on create and
              editable afterwards.
            </p>
          ) : null}

          {district ? (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text-2">
              Reference will be assigned on creation:{" "}
              <span className="font-mono font-medium text-text-1">
                {district.code}####
              </span>{" "}
              (immutable)
            </p>
          ) : null}

          <div>
            <Button type="button" disabled={!step1Valid} onClick={() => setStep(2)}>
              Continue <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 rounded-[10px] border border-border bg-surface p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="title_en">Title (EN)</Label>
              <Input id="title_en" name="title_en" placeholder="Seafront villa with pool" />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="area_id">Area</Label>
              <Select name="area_id" defaultValue="">
                <SelectTrigger id="area_id">
                  <SelectValue placeholder={districtAreas.length ? "Select area…" : "No areas yet"} />
                </SelectTrigger>
                <SelectContent>
                  {districtAreas.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                name="address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street, number, locality"
              />
            </div>

            {showAsking ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="asking_price">Asking price (€)</Label>
                <Input id="asking_price" name="asking_price" type="number" min="0" />
              </div>
            ) : null}
            {showRent ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="rent_price_month">Rent (€ / month)</Label>
                <Input id="rent_price_month" name="rent_price_month" type="number" min="0" />
              </div>
            ) : null}

            {isLand ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="plot_area_sqm">Plot area (m²)</Label>
                <Input id="plot_area_sqm" name="plot_area_sqm" type="number" min="0" step="0.01" />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="covered_area_sqm">Covered area (m²)</Label>
                  <Input
                    id="covered_area_sqm"
                    name="covered_area_sqm"
                    type="number"
                    min="0"
                    step="0.01"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="bedrooms">Bedrooms</Label>
                  <Input id="bedrooms" name="bedrooms" type="number" min="0" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="bathrooms">Bathrooms</Label>
                  <Input id="bathrooms" name="bathrooms" type="number" min="0" />
                </div>
              </>
            )}

            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="internal_notes">Internal notes</Label>
              <Input id="internal_notes" name="internal_notes" placeholder="Not shown anywhere public" />
            </div>
          </div>

          {duplicate ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-text-2">
                <Link
                  href={`/properties/${duplicate.id}`}
                  className="font-mono font-medium text-brand-700 hover:underline"
                >
                  {duplicate.reference}
                </Link>{" "}
                is already at this address — {duplicate.label}
                {duplicate.status === "withdrawn" ? " (withdrawn)" : ""}. Open it instead of
                creating a second record, unless this really is a different property.
              </p>
            </div>
          ) : null}

          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => setStep(1)}>
              <ArrowLeft className="size-4" /> Back
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create property"}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
