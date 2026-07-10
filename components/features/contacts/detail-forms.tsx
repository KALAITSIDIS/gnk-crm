"use client";

import { useState } from "react";
import { ActionSectionForm } from "@/components/features/shared/action-section-form";
import { PhoneInput } from "@/components/features/shared/phone-input";
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
import { updateContactSection } from "@/lib/actions/contacts";
import {
  ACCOUNT_FEASIBILITY,
  KYC_ITEMS,
  bankingCompletion,
  kycCompletion,
  type BankingReadinessState,
  type KycState,
} from "@/lib/constants/checklists";
import { PROPERTY_TYPES } from "@/lib/validators/properties";
import {
  CONTACT_LANGUAGES,
  CONTACT_TYPES,
  LEAD_SOURCES,
  PSYCHOLOGY_PROFILES,
  TEMPERATURES,
} from "@/lib/validators/contacts";
import { cn } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ContactData {
  [key: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function ProfileForm({ contact }: { contact: ContactData }) {
  const [kind, setKind] = useState<string>(contact.contact_kind ?? "person");

  return (
    <ActionSectionForm
      action={updateContactSection}
      hidden={{ contact_id: contact.id, section: "profile" }}
    >
      <input type="hidden" name="contact_kind" value={kind} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>Kind</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="person">Person</SelectItem>
              <SelectItem value="company">Company</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div />
        {kind === "person" ? (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor="first_name">First name</Label>
              <Input id="first_name" name="first_name" defaultValue={contact.first_name ?? ""} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="last_name">Last name</Label>
              <Input id="last_name" name="last_name" defaultValue={contact.last_name ?? ""} />
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="company_name">Company name</Label>
            <Input id="company_name" name="company_name" defaultValue={contact.company_name ?? ""} />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <Label>Phone</Label>
          <PhoneInput name="phone" defaultValue={contact.phone_raw ?? contact.phone_e164 ?? ""} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" defaultValue={contact.email ?? ""} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="telegram_username">Telegram</Label>
          <Input
            id="telegram_username"
            name="telegram_username"
            defaultValue={contact.telegram_username ?? ""}
          />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Checkbox id="has_whatsapp" name="has_whatsapp" defaultChecked={contact.has_whatsapp} />
          <Label htmlFor="has_whatsapp">Uses WhatsApp</Label>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="nationality">Nationality</Label>
          <Input id="nationality" name="nationality" defaultValue={contact.nationality ?? ""} />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Languages</Label>
          <div className="flex gap-4 pt-2">
            {CONTACT_LANGUAGES.map((lang) => (
              <label key={lang} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  name="languages"
                  value={lang}
                  defaultChecked={(contact.languages ?? []).includes(lang)}
                />
                {lang.toUpperCase()}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label>Contact types</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CONTACT_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  name="contact_types"
                  value={t}
                  defaultChecked={(contact.contact_types ?? []).includes(t)}
                />
                {labelize(t)}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Temperature</Label>
          <Select name="temperature" defaultValue={contact.temperature ?? "warm"}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPERATURES.map((t) => (
                <SelectItem key={t} value={t}>
                  {labelize(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Source</Label>
          <Select name="source" defaultValue={contact.source ?? ""}>
            <SelectTrigger>
              <SelectValue placeholder="Select source…" />
            </SelectTrigger>
            <SelectContent>
              {LEAD_SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {labelize(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Psychology profile</Label>
          <Select name="psychology" defaultValue={contact.psychology ?? ""}>
            <SelectTrigger>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {PSYCHOLOGY_PROFILES.map((p) => (
                <SelectItem key={p} value={p}>
                  {labelize(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Checkbox
            id="consent_marketing"
            name="consent_marketing"
            defaultChecked={contact.consent_marketing}
          />
          <Label htmlFor="consent_marketing">Marketing consent</Label>
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" name="notes" rows={3} defaultValue={contact.notes ?? ""} />
        </div>
      </div>
    </ActionSectionForm>
  );
}

export function PreferencesForm({
  contact,
  areaOptions,
}: {
  contact: ContactData;
  areaOptions: { id: string; name: string }[];
}) {
  const prefs = (contact.preferences ?? {}) as {
    areas?: string[];
    budget_min?: number;
    budget_max?: number;
    bedrooms_min?: number;
    property_types?: string[];
    purpose?: string;
  };

  return (
    <ActionSectionForm
      action={updateContactSection}
      hidden={{ contact_id: contact.id, section: "preferences" }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="budget_min">Budget min (€)</Label>
          <Input
            id="budget_min"
            name="budget_min"
            type="number"
            min="0"
            defaultValue={prefs.budget_min ?? ""}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="budget_max">Budget max (€)</Label>
          <Input
            id="budget_max"
            name="budget_max"
            type="number"
            min="0"
            defaultValue={prefs.budget_max ?? ""}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="bedrooms_min">Bedrooms min</Label>
          <Input
            id="bedrooms_min"
            name="bedrooms_min"
            type="number"
            min="0"
            defaultValue={prefs.bedrooms_min ?? ""}
          />
        </div>
        <div className="flex flex-col gap-2 sm:col-span-3">
          <Label>Areas of interest</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {areaOptions.map((a) => (
              <label key={a.id} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  name="pref_areas"
                  value={a.name}
                  defaultChecked={(prefs.areas ?? []).includes(a.name)}
                />
                {a.name}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:col-span-3">
          <Label>Property types</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PROPERTY_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  name="pref_property_types"
                  value={t}
                  defaultChecked={(prefs.property_types ?? []).includes(t)}
                />
                {labelize(t)}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Purpose</Label>
          <Select name="purpose" defaultValue={prefs.purpose ?? ""}>
            <SelectTrigger>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {["own_use", "investment", "relocation", "holiday_home", "rental_income"].map((p) => (
                <SelectItem key={p} value={p}>
                  {labelize(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </ActionSectionForm>
  );
}

function CompletionBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-40 text-sm font-medium text-text-1">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct >= 100 ? "bg-success" : pct >= 50 ? "bg-warning" : "bg-danger",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 text-right text-sm tabular-nums text-text-2">{pct}%</span>
    </div>
  );
}

export function ChecklistsForm({ contact }: { contact: ContactData }) {
  const kyc = (contact.kyc ?? {}) as KycState;
  const banking = (contact.banking_readiness ?? {}) as BankingReadinessState;
  const [kycState, setKycState] = useState<KycState>(kyc);

  return (
    <ActionSectionForm
      action={updateContactSection}
      hidden={{ contact_id: contact.id, section: "kyc_banking" }}
    >
      <div className="flex flex-col gap-2">
        <CompletionBar pct={kycCompletion(kycState)} label="KYC checklist" />
        <CompletionBar pct={bankingCompletion(banking)} label="Banking readiness" />
      </div>

      <h3 className="mt-2 text-base font-semibold text-text-1">KYC / AML (manual — doc 01 §10)</h3>
      <div className="flex flex-col gap-3">
        {KYC_ITEMS.map(([key, label]) => (
          <div key={key} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[220px_1fr_1fr]">
            <label className="flex items-center gap-2 text-sm font-medium text-text-1">
              <Checkbox
                name={`kyc_${key}_done`}
                defaultChecked={kyc[key]?.done === true}
                onCheckedChange={(checked) =>
                  setKycState((s) => ({ ...s, [key]: { ...s[key], done: checked === true } }))
                }
              />
              {label}
            </label>
            <Input
              name={`kyc_${key}_note`}
              placeholder="Note"
              defaultValue={kyc[key]?.note ?? ""}
              className="h-8 text-[13px]"
            />
            <Input
              name={`kyc_${key}_doc`}
              placeholder="Document link"
              defaultValue={kyc[key]?.doc_link ?? ""}
              className="h-8 text-[13px]"
            />
          </div>
        ))}
      </div>

      <h3 className="mt-2 text-base font-semibold text-text-1">Banking readiness (non-EU buyers)</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="nationality_risk_note">Nationality risk note</Label>
          <Input
            id="nationality_risk_note"
            name="nationality_risk_note"
            defaultValue={banking.nationality_risk_note ?? ""}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="funds_origin_country">Funds origin country</Label>
          <Input
            id="funds_origin_country"
            name="funds_origin_country"
            defaultValue={banking.funds_origin_country ?? ""}
          />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Checkbox
            id="bank_pre_check_done"
            name="bank_pre_check_done"
            defaultChecked={banking.bank_pre_check_done === true}
          />
          <Label htmlFor="bank_pre_check_done">Bank pre-check done</Label>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Account feasibility</Label>
          <Select name="account_feasibility" defaultValue={banking.account_feasibility ?? ""}>
            <SelectTrigger>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {ACCOUNT_FEASIBILITY.map((f) => (
                <SelectItem key={f} value={f}>
                  {labelize(f)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </ActionSectionForm>
  );
}
