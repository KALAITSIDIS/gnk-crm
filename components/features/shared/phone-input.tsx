"use client";

import { useState } from "react";
import { AsYouType, getCountryCallingCode, type CountryCode } from "libphonenumber-js";
import { Input } from "@/components/ui/input";
import { normalizePhone } from "@/lib/services/phone";
import { cn } from "@/lib/utils";

/**
 * PhoneInput (doc 06): libphonenumber live formatting, country flag, E.164
 * shown underneath. Submits the RAW text under `name`; the server action
 * normalizes to E.164 (doc 02 §A12).
 */

function flagEmoji(country: CountryCode | undefined): string {
  if (!country) return "🌐";
  return String.fromCodePoint(...[...country].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export function PhoneInput({
  name,
  defaultValue = "",
  onValidChange,
}: {
  name: string;
  defaultValue?: string;
  onValidChange?: (e164: string | null) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const normalized = value ? normalizePhone(value) : null;

  const handleChange = (raw: string) => {
    // live pretty-printing while typing (doc 06)
    const formatted = new AsYouType("CY").input(raw);
    setValue(raw.endsWith(" ") || raw.length < value.length ? raw : formatted);
    const result = raw ? (normalizePhone(raw)?.e164 ?? null) : null;
    onValidChange?.(result);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base">
          {flagEmoji(normalized?.country)}
        </span>
        <Input
          name={name}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="99 123456"
          className="pl-9"
          type="tel"
          autoComplete="tel"
        />
      </div>
      {value ? (
        <p className={cn("text-xs", normalized ? "text-text-3" : "text-danger")}>
          {normalized
            ? `Stored as ${normalized.e164}`
            : `Not a valid number (default region CY, +${getCountryCallingCode("CY")})`}
        </p>
      ) : null}
    </div>
  );
}
