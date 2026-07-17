"use client";

import { useState } from "react";
import { ActionSectionForm } from "@/components/features/shared/action-section-form";
import { PhoneInput } from "@/components/features/shared/phone-input";
import { formatPhone } from "@/lib/services/phone";
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
  COMM_CHANNELS,
  CONTACT_LANGUAGES,
  CONTACT_PURPOSES,
  CONTACT_TYPES,
  LEAD_SOURCES,
  PSYCHOLOGY_PROFILES,
  SELECT_NONE,
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

export function ProfileForm({
  contact,
  readOnly = false,
  readOnlyHint,
  agents,
}: {
  contact: ContactData;
  readOnly?: boolean;
  readOnlyHint?: string;
  /** Active agents for the reassignment select — only passed for admins. */
  agents?: { id: string; full_name: string }[];
}) {
  const [kind, setKind] = useState<string>(contact.contact_kind ?? "person");
  const additionalPhones: string[] = contact.additional_phones ?? [];

  return (
    <ActionSectionForm
      action={updateContactSection}
      hidden={{ contact_id: contact.id, section: "profile" }}
      readOnly={readOnly}
      readOnlyHint={readOnlyHint}
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
          {additionalPhones.length > 0 ? (
            <p className="text-xs text-text-3">
              Also reachable at:{" "}
              {additionalPhones.map((p) => formatPhone(p)).join(", ")} (kept from merges — counted
              in duplicate checks)
            </p>
          ) : null}
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
          <Label>Preferred channel</Label>
          <Select name="preferred_channel" defaultValue={contact.preferred_channel ?? SELECT_NONE}>
            <SelectTrigger>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_NONE}>—</SelectItem>
              {COMM_CHANNELS.map((c) => (
                <SelectItem key={c} value={c}>
                  {labelize(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Source</Label>
          <Select name="source" defaultValue={contact.source ?? SELECT_NONE}>
            <SelectTrigger>
              <SelectValue placeholder="Select source…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_NONE}>—</SelectItem>
              {LEAD_SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {labelize(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="source_detail">Source detail</Label>
          <Input
            id="source_detail"
            name="source_detail"
            placeholder="e.g. referred by Maria K."
            defaultValue={contact.source_detail ?? ""}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Psychology profile</Label>
          <Select name="psychology" defaultValue={contact.psychology ?? SELECT_NONE}>
            <SelectTrigger>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_NONE}>—</SelectItem>
              {PSYCHOLOGY_PROFILES.map((p) => (
                <SelectItem key={p} value={p}>
                  {labelize(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {agents ? (
          <div className="flex flex-col gap-2">
            <Label>Assigned agent</Label>
            <Select name="assigned_agent_id" defaultValue={contact.assigned_agent_id ?? SELECT_NONE}>
              <SelectTrigger>
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_NONE}>Unassigned</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="flex items-end gap-2 pb-2">
          <Checkbox
            id="consent_marketing"
            name="consent_marketing"
            defaultChecked={contact.consent_marketing}
          />
          <Label htmlFor="consent_marketing">Marketing consent</Label>
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="gdpr_notes">GDPR notes</Label>
          <Textarea
            id="gdpr_notes"
            name="gdpr_notes"
            rows={2}
            placeholder="Data requests, erasure notes, consent context…"
            defaultValue={contact.gdpr_notes ?? ""}
          />
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
  readOnly = false,
  readOnlyHint,
}: {
  contact: ContactData;
  areaOptions: { id: string; name: string }[];
  readOnly?: boolean;
  readOnlyHint?: string;
}) {
  const prefs = (contact.preferences ?? {}) as {
    areas?: string[];
    budget_min?: number;
    budget_max?: number;
    bedrooms_min?: number;
    property_types?: string[];
    purpose?: string;
  };
  // areas store IDs (DECISIONS T-audit-contacts); legacy rows hold EN names —
  // match either so old data still lights up, and the next save writes IDs
  const areaChecked = (a: { id: string; name: string }) =>
    (prefs.areas ?? []).some((v) => v === a.id || v === a.name);

  return (
    <ActionSectionForm
      action={updateContactSection}
      hidden={{ contact_id: contact.id, section: "preferences" }}
      readOnly={readOnly}
      readOnlyHint={readOnlyHint}
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
                <Checkbox name="pref_areas" value={a.id} defaultChecked={areaChecked(a)} />
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
          <Select name="purpose" defaultValue={prefs.purpose ?? SELECT_NONE}>
            <SelectTrigger>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_NONE}>—</SelectItem>
              {CONTACT_PURPOSES.map((p) => (
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

export function ChecklistsForm({
  contact,
  readOnly = false,
  readOnlyHint,
}: {
  contact: ContactData;
  readOnly?: boolean;
  readOnlyHint?: string;
}) {
  const kyc = (contact.kyc ?? {}) as KycState;
  const banking = (contact.banking_readiness ?? {}) as BankingReadinessState;
  const [kycState, setKycState] = useState<KycState>(kyc);
  const [bankingState, setBankingState] = useState<BankingReadinessState>(banking);

  return (
    <ActionSectionForm
      action={updateContactSection}
      hidden={{ contact_id: contact.id, section: "kyc_banking" }}
      readOnly={readOnly}
      readOnlyHint={readOnlyHint}
    >
      <div className="flex flex-col gap-2">
        <CompletionBar pct={kycCompletion(kycState)} label="KYC checklist" />
        <CompletionBar pct={bankingCompletion(bankingState)} label="Banking readiness" />
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
            onChange={(e) =>
              setBankingState((s) => ({ ...s, nationality_risk_note: e.target.value }))
            }
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="funds_origin_country">Funds origin country</Label>
          <Input
            id="funds_origin_country"
            name="funds_origin_country"
            defaultValue={banking.funds_origin_country ?? ""}
            onChange={(e) =>
              setBankingState((s) => ({ ...s, funds_origin_country: e.target.value }))
            }
          />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Checkbox
            id="bank_pre_check_done"
            name="bank_pre_check_done"
            defaultChecked={banking.bank_pre_check_done === true}
            onCheckedChange={(checked) =>
              setBankingState((s) => ({ ...s, bank_pre_check_done: checked === true }))
            }
          />
          <Label htmlFor="bank_pre_check_done">Bank pre-check done</Label>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Account feasibility</Label>
          <Select
            name="account_feasibility"
            defaultValue={banking.account_feasibility ?? SELECT_NONE}
            onValueChange={(v) =>
              setBankingState((s) => ({
                ...s,
                account_feasibility: (["yes", "maybe", "no"] as const).find((f) => f === v),
              }))
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_NONE}>—</SelectItem>
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
