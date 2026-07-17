"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  checkContactDuplicate,
  createContact,
  type ContactActionState,
  type DuplicateMatch,
} from "@/lib/actions/contacts";
import { PhoneInput } from "@/components/features/shared/phone-input";
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
import {
  CONTACT_LANGUAGES,
  CONTACT_TYPES,
  LEAD_SOURCES,
  PSYCHOLOGY_PROFILES,
  SELECT_NONE,
  TEMPERATURES,
} from "@/lib/validators/contacts";

const initialState: ContactActionState = { error: null, duplicate: null };

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function DuplicateBanner({ match }: { match: DuplicateMatch }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span>
        A contact with this {match.matched_on} already exists:{" "}
        <Link href={`/contacts/${match.id}`} className="font-medium underline">
          {match.display_name}
        </Link>
        {" — "}open it instead of creating a duplicate (admins can merge from there).
      </span>
    </div>
  );
}

export function CreateContactForm() {
  const [state, formAction, pending] = useActionState(createContact, initialState);
  const [liveDuplicate, setLiveDuplicate] = useState<DuplicateMatch | null>(null);
  const [kind, setKind] = useState("person");
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<string | null>(null);

  const runLiveCheck = async () => {
    const match = await checkContactDuplicate(
      phoneRef.current,
      emailRef.current?.value || null,
    );
    setLiveDuplicate(match);
  };

  const duplicate = state.duplicate ?? liveDuplicate;

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-4">
      <input type="hidden" name="contact_kind" value={kind} />

      {duplicate ? <DuplicateBanner match={duplicate} /> : null}

      <div className="grid gap-4 rounded-[10px] border border-border bg-surface p-6 sm:grid-cols-2">
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
              <Input id="first_name" name="first_name" autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="last_name">Last name</Label>
              <Input id="last_name" name="last_name" />
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="company_name">Company name</Label>
            <Input id="company_name" name="company_name" autoFocus />
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label>Phone</Label>
          <PhoneInput
            name="phone"
            onValidChange={(e164) => {
              phoneRef.current = e164;
              // re-check on every change — an edited/cleared phone must also
              // clear a stale duplicate banner (it locks the submit button)
              void runLiveCheck();
            }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            ref={emailRef}
            onBlur={() => void runLiveCheck()}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="telegram_username">Telegram username</Label>
          <Input id="telegram_username" name="telegram_username" placeholder="without @" />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <Checkbox id="has_whatsapp" name="has_whatsapp" />
          <Label htmlFor="has_whatsapp">Uses WhatsApp</Label>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="nationality">Nationality</Label>
          <Input id="nationality" name="nationality" />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Languages</Label>
          <div className="flex gap-4 pt-2">
            {CONTACT_LANGUAGES.map((lang) => (
              <label key={lang} className="flex items-center gap-1.5 text-sm">
                <Checkbox name="languages" value={lang} defaultChecked={lang === "en"} />
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
                <Checkbox name="contact_types" value={t} />
                {labelize(t)}
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Temperature</Label>
          <Select name="temperature" defaultValue="warm">
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
          <Select name="source" defaultValue={SELECT_NONE}>
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
          <Input id="source_detail" name="source_detail" placeholder="e.g. referred by Maria K." />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Psychology profile</Label>
          <Select name="psychology" defaultValue={SELECT_NONE}>
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

        <div className="flex items-end gap-2 pb-2">
          <Checkbox id="consent_marketing" name="consent_marketing" />
          <Label htmlFor="consent_marketing">Marketing consent (GDPR — stamps timestamp)</Label>
        </div>
        <div />

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" name="notes" rows={3} />
        </div>
      </div>

      {state.error && !state.duplicate ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={pending || Boolean(duplicate)}>
          {pending ? "Creating…" : "Create contact"}
        </Button>
      </div>
    </form>
  );
}
