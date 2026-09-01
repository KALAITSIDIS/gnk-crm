"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Copy, RotateCcw } from "lucide-react";
import Link from "next/link";
import {
  checkPropertyDuplicate,
  checkPropertyRegistrationDuplicate,
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
import { CreatePartyContact } from "@/components/features/properties/create-party-contact";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { getPartyDefaults } from "@/lib/actions/party-defaults";
import type { EntityOption } from "@/lib/actions/entity-search";
import type { PropertySeed } from "@/lib/services/property-seed";
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

/* ------------------------------------------------------------------ *
 * AUTOSAVED DRAFT — so a half-finished entry survives.
 *
 * The wizard writes NOTHING until "Create property". Filling step 1, pressing
 * "Continue" and then leaving used to lose everything silently: no row, no
 * event, no warning. That happened on 2026-08-28 — the server logs showed two
 * GETs of /properties/new and no POST at all, and the operator reasonably
 * believed a listing had been entered.
 *
 * IT IS DELIBERATELY LOCAL, NOT A DRAFT ROW. Creating the property up front
 * would be the obvious fix and the wrong one: it burns a reference the moment
 * someone opens the form (references never change, and PAF0004 is already a
 * hole from exactly this), and it litters the database with abandoned records
 * — the CRM already carries "TERTEWTRT" and a smoke test from earlier passes.
 * A browser-local draft costs nothing and leaves no trace when abandoned.
 *
 * It expires, because a listing half-typed a fortnight ago reappearing under a
 * different property is worse than losing it. And it never overrides "Create
 * similar", which is an explicit request for different prefill.
 * ------------------------------------------------------------------ */

const DRAFT_KEY = "gnk:new-property-draft";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The uncontrolled step-2 inputs. The controlled ones travel as state. */
const DRAFT_FIELDS = [
  "title_en",
  "asking_price",
  "rent_price_month",
  "plot_area_sqm",
  "covered_area_sqm",
  "bedrooms",
  "bathrooms",
  "internal_notes",
] as const;

interface Draft {
  v: 1;
  savedAt: number;
  step: 1 | 2;
  source: ListingSource;
  party: EntityOption | null;
  kind: string;
  propertyType: string;
  transaction: string;
  districtId: string;
  areaId: string;
  address: string;
  /** optional for drafts saved before 0077 — absent reads as "" */
  registrationNo?: string;
  fields: Record<string, string>;
}

/** Every access is wrapped: localStorage throws outright in some privacy modes,
 *  and a crashing form is far worse than a lost draft. */
function readDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (d?.v !== 1 || typeof d.savedAt !== "number") return null;
    if (Date.now() - d.savedAt > DRAFT_TTL_MS) {
      window.localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

function writeDraft(d: Draft): void {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* quota or disabled storage — the form must keep working regardless */
  }
}

function dropDraft(): void {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

function savedAgo(ms: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function CreatePropertyWizard({
  districts,
  areas,
  seed = null,
  seedParty = null,
}: {
  districts: (DistrictOption & { code: string })[];
  areas: AreaOption[];
  /** "Create similar": prefill from an existing property (see property-seed.ts) */
  seed?: PropertySeed | null;
  /** the source's owner/developer, resolved server-side so the picker shows a name */
  seedParty?: EntityOption | null;
}) {
  const [state, formAction, pending] = useActionState(createProperty, initialState);
  const [step, setStep] = useState<1 | 2>(1);

  // step 1 values (kept in state so both steps submit in one form)
  const [source, setSource] = useState<ListingSource>(seed?.source ?? "owner");
  const [party, setParty] = useState<EntityOption | null>(seedParty);
  const [partyTerms, setPartyTerms] = useState<{
    labels: string[];
    from: string;
  } | null>(null);
  const [kind, setKind] = useState<string>(seed?.kind ?? "standalone");
  const [propertyType, setPropertyType] = useState<string>(seed?.propertyType ?? "");
  const [transaction, setTransaction] = useState<string>(seed?.transactionType ?? "sale");
  const [districtId, setDistrictId] = useState<string>(seed?.districtId ?? "");
  const [address, setAddress] = useState<string>(seed?.address ?? "");
  // controlled like address: the registration duplicate check needs the live
  // value (0077, DB-05)
  const [registrationNo, setRegistrationNo] = useState<string>("");
  // controlled so a restored draft can put the area back; Radix Select
  // cannot be repopulated by writing to a DOM node the way the plain
  // inputs below can.
  const [areaId, setAreaId] = useState<string>(seed?.areaId ?? "");
  const formRef = useRef<HTMLFormElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  /** Restored step-2 values, fed in as `defaultValue`. They CANNOT be written
   *  into the DOM on mount: the wizard restores while still on step 1, so those
   *  inputs do not exist yet. The first version did exactly that and silently
   *  restored only the controlled half — caught in a browser, not by types. */
  const [draftFields, setDraftFields] = useState<Record<string, string> | null>(null);
  // The result is stored WITH the address it was for, so a slow answer for an
  // old address cannot be shown against a new one — and so the effect never
  // has to clear state synchronously, which cascades renders.
  const [found, setFound] = useState<{
    forAddress: string;
    match: PropertyDuplicateMatch | null;
  } | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // same stored-with-its-input discipline for the DLS check (0077, DB-05)
  const [regFound, setRegFound] = useState<{
    forReg: string;
    match: PropertyDuplicateMatch | null;
  } | null>(null);
  const regDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Read the uncontrolled step-2 inputs off the form.
   *
   * FALLS BACK TO THE LAST KNOWN VALUE when an input is not in the DOM, and
   * that is not defensive padding — it is the fix for a bug this had:
   *
   * step 2's inputs only exist while step 2 is rendered. Saving while on step 1
   * therefore read every one of them as "" and wrote that over a draft that
   * had a title and a price in it. Restoring made it worse: restore lands on
   * step 1, the state change scheduled a save, and the save wiped the very
   * draft it had just read. The draft survived exactly one round trip and came
   * back empty.
   */
  const readFields = (): Record<string, string> => {
    const form = formRef.current;
    const out: Record<string, string> = {};
    for (const n of DRAFT_FIELDS) {
      const el = form?.elements.namedItem(n);
      out[n] =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.value
          : (draftFields?.[n] ?? "");
    }
    return out;
  };

  /** The draft as it stands right now. */
  const buildDraft = (): Draft => ({
    v: 1,
    savedAt: Date.now(),
    step,
    source,
    party,
    kind,
    propertyType,
    transaction,
    districtId,
    areaId,
    address,
    registrationNo,
    fields: readFields(),
  });

  const scheduleSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const d = buildDraft();
      const meaningful =
        Boolean(d.propertyType) ||
        Boolean(d.districtId) ||
        Boolean(d.party) ||
        d.address.trim().length > 0 ||
        Object.values(d.fields).some((v) => v.trim().length > 0);
      if (!meaningful) {
        dropDraft();
        return;
      }
      writeDraft(d);
    }, 400);
  };

  /**
   * Snapshot taken at submit, because REACT RESETS AN UNCONTROLLED FORM once a
   * server action settles. On a FAILED create the inputs come back empty, and
   * re-reading them would persist that emptiness over the draft — losing the
   * entry at the one moment the user most needs it kept. Measured on
   * 2026-08-28: a create refused by a duplicate reference left the title and
   * price boxes blank.
   */
  const submitted = useRef<Draft | null>(null);

  const handleSubmit = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    submitted.current = buildDraft();
    // Cleared for the success path, which redirects away and must not leave a
    // draft behind to greet the NEXT listing. The error path below puts it back.
    dropDraft();
  };

  // Restore once, on mount. `seed` wins: "Create similar" is an explicit
  // request for different prefill, and silently overriding it with an older
  // draft would be the same class of surprise this feature exists to remove.
  /* eslint-disable react-hooks/set-state-in-effect --
     Restoring HAS to happen in an effect. Reading localStorage during render
     (a lazy useState initialiser) would make the server and the client produce
     different HTML for the same component — a hydration mismatch, and this
     component is server-rendered. The rule is right in general and wrong for
     rehydrating browser-only state, which is exactly what this is. */
  useEffect(() => {
    if (seed) return;
    const d = readDraft();
    if (!d) return;
    setSource(d.source);
    setParty(d.party);
    setKind(d.kind);
    setPropertyType(d.propertyType);
    setTransaction(d.transaction);
    setDistrictId(d.districtId);
    setAreaId(d.areaId);
    setAddress(d.address);
    setRegistrationNo(d.registrationNo ?? "");
    setStep(d.step);
    setDraftFields(d.fields);
    setRestoredAt(d.savedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Any change to the controlled half schedules a save; the uncontrolled half
  // is covered by onInput on the form itself.
  useEffect(() => {
    scheduleSave();
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, party, kind, propertyType, transaction, districtId, areaId, address, registrationNo, step]);

  /**
   * A FAILED submit must not lose the draft. The draft is dropped when the form
   * is submitted, because the usual outcome is a redirect to the new property;
   * if the action comes back with an error instead, the entry is still on
   * screen and worth keeping, so it is written again.
   */
  useEffect(() => {
    if (!state.error) return;
    const snap = submitted.current;
    if (!snap) return;
    // Put the values back in the boxes the reset emptied, then persist them.
    const form = formRef.current;
    for (const n of DRAFT_FIELDS) {
      const el = form?.elements.namedItem(n);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.value = snap.fields[n] ?? "";
      }
    }
    setDraftFields(snap.fields);
    writeDraft({ ...snap, savedAt: Date.now() });
    submitted.current = null;
  }, [state.error]);

  const discardDraft = () => {
    dropDraft();
    setRestoredAt(null);
    setDraftFields(null);
    setSource("owner");
    setParty(null);
    setPartyTerms(null);
    setKind("standalone");
    setPropertyType("");
    setTransaction("sale");
    setDistrictId("");
    setAreaId("");
    setAddress("");
    const form = formRef.current;
    for (const n of DRAFT_FIELDS) {
      const el = form?.elements.namedItem(n);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = "";
    }
    setStep(1);
  };

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

  // DLS registration duplicate check (0077) — the stronger signal, and the
  // only one that works for unaddressed land. Same warn-never-block doctrine.
  useEffect(() => {
    if (regDebounce.current) clearTimeout(regDebounce.current);
    if (registrationNo.trim().length < 3) return;
    const forReg = registrationNo;
    regDebounce.current = setTimeout(async () => {
      setRegFound({ forReg, match: await checkPropertyRegistrationDuplicate(forReg) });
    }, 400);
    return () => {
      if (regDebounce.current) clearTimeout(regDebounce.current);
    };
  }, [registrationNo]);

  const regDuplicate =
    regFound && regFound.forReg === registrationNo ? regFound.match : null;

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
    <form
      ref={formRef}
      action={formAction}
      onInput={scheduleSave}
      onSubmit={handleSubmit}
      className="flex max-w-2xl flex-col gap-6"
    >
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

      {/* A prefilled form that does not say it is prefilled is the dangerous
          version of this feature: the risk is a copied price accepted without
          being read. Name the source, and name what did NOT come across. */}
      {seed ? (
        <div className="flex items-start gap-2 rounded-lg border border-brand-500/40 bg-brand-100/40 px-3 py-2 text-sm">
          <Copy className="mt-0.5 size-4 shrink-0 text-brand-700" />
          <p className="text-text-2">
            Prefilled from <span className="font-medium text-text-1">{seed.fromReference}</span> —
            check every field before saving. Not copied: {seed.dropped.join(", ")}.
          </p>
        </div>
      ) : null}

      {restoredAt !== null ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
          <RotateCcw className="mt-0.5 size-4 shrink-0 text-text-3" />
          <p className="text-text-2">
            Restored what you had typed {savedAgo(restoredAt)} — nothing was saved to the CRM,
            this was kept in this browser.{" "}
            <button
              type="button"
              onClick={discardDraft}
              className="font-medium text-brand-700 underline hover:no-underline"
            >
              Start blank instead
            </button>
          </p>
        </div>
      ) : null}

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
                // party in the key so an inline-created contact (WF-10) shows
                // as the selection — the picker seeds itself from `initial`
                key={`${source}:${party?.id ?? ""}`}
                name={`party-${source}`}
                kind="contact"
                label={source === "developer" ? "Developer" : "Owner"}
                placeholder={source === "developer" ? "Search developers…" : "Search owners…"}
                contactTypes={
                  source === "developer" ? ["developer"] : ["owner", "seller", "landlord"]
                }
                hint="Their standard terms fill the rest — every value stays editable."
                emptyHint={
                  source === "developer"
                    ? "Use “New developer” below to create one."
                    : "Use “New owner” below to create one."
                }
                initial={party ?? (source === seed?.source ? seedParty : null)}
                onChange={onPartyChange}
              />
              {!party ? (
                <CreatePartyContact source={source} onSelect={(o) => void onPartyChange(o)} />
              ) : null}
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
              <Input
                id="title_en"
                name="title_en"
                defaultValue={draftFields?.title_en ?? seed?.titleEn ?? ""}
                placeholder="Seafront villa with pool"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="area_id">Area</Label>
              <Select name="area_id" value={areaId} onValueChange={setAreaId}>
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

            <div className="flex flex-col gap-2">
              <Label htmlFor="registration_no">Registration no. (DLS, optional)</Label>
              <Input
                id="registration_no"
                name="registration_no"
                value={registrationNo}
                onChange={(e) => setRegistrationNo(e.target.value)}
                placeholder="As on the title deed"
              />
            </div>

            {showAsking ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="asking_price">Asking price (€)</Label>
                <Input
                  id="asking_price"
                  name="asking_price"
                  type="number"
                  min="0"
                  defaultValue={draftFields?.asking_price ?? seed?.askingPrice ?? ""}
                />
              </div>
            ) : null}
            {showRent ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="rent_price_month">Rent (€ / month)</Label>
                <Input
                  id="rent_price_month"
                  name="rent_price_month"
                  type="number"
                  min="0"
                  defaultValue={draftFields?.rent_price_month ?? seed?.rentPriceMonth ?? ""}
                />
              </div>
            ) : null}

            {isLand ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="plot_area_sqm">Plot area (m²)</Label>
                <Input
                  id="plot_area_sqm"
                  name="plot_area_sqm"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={draftFields?.plot_area_sqm ?? seed?.plotAreaSqm ?? ""}
                />
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
                    defaultValue={draftFields?.covered_area_sqm ?? seed?.coveredAreaSqm ?? ""}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="bedrooms">Bedrooms</Label>
                  <Input
                    id="bedrooms"
                    name="bedrooms"
                    type="number"
                    min="0"
                    defaultValue={draftFields?.bedrooms ?? seed?.bedrooms ?? ""}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="bathrooms">Bathrooms</Label>
                  <Input
                    id="bathrooms"
                    name="bathrooms"
                    type="number"
                    min="0"
                    defaultValue={draftFields?.bathrooms ?? seed?.bathrooms ?? ""}
                  />
                </div>
              </>
            )}

            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="internal_notes">Internal notes</Label>
              <Input
                id="internal_notes"
                name="internal_notes"
                defaultValue={draftFields?.internal_notes ?? seed?.internalNotes ?? ""}
                placeholder="Not shown anywhere public"
              />
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

          {regDuplicate ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="text-text-2">
                <Link
                  href={`/properties/${regDuplicate.id}`}
                  className="font-mono font-medium text-brand-700 hover:underline"
                >
                  {regDuplicate.reference}
                </Link>{" "}
                already carries this DLS registration number — {regDuplicate.label}
                {regDuplicate.status === "withdrawn" ? " (withdrawn)" : ""}. A plot has exactly
                one; this is almost certainly the same property under a second mandate.
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
