"use client";

import { useActionState, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { createProperty, type PropertyActionState } from "@/lib/actions/properties";
import { CREATABLE_KINDS, PROPERTY_TYPES, TRANSACTION_TYPES } from "@/lib/validators/properties";
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
  const [kind, setKind] = useState<string>("standalone");
  const [propertyType, setPropertyType] = useState<string>("");
  const [transaction, setTransaction] = useState<string>("sale");
  const [districtId, setDistrictId] = useState<string>("");

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
              <Label>Kind</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
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
              <Label>Property type</Label>
              <Select value={propertyType} onValueChange={setPropertyType}>
                <SelectTrigger>
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
              <Label>Transaction</Label>
              <Select value={transaction} onValueChange={setTransaction}>
                <SelectTrigger>
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
              <Label>District</Label>
              <Select value={districtId} onValueChange={setDistrictId}>
                <SelectTrigger>
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

          {district ? (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text-2">
              Reference will be assigned on creation:{" "}
              <span className="font-mono font-medium text-text-1">
                GNK-{district.code}-####
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
              <Label>Area</Label>
              <Select name="area_id" defaultValue="">
                <SelectTrigger>
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
              <Input id="address" name="address" placeholder="Street, number, locality" />
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
