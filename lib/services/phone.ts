import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * Phone normalization (doc 02 §A12): store E.164 in phone_e164, keep the raw
 * input in phone_raw. Default region CY, so local input like "99 123456"
 * becomes +35799123456. Dedup is phone-first on the normalized value.
 */

export interface NormalizedPhone {
  e164: string;
  country: CountryCode | undefined;
}

/** Returns null when the input is not a valid phone number. */
export function normalizePhone(
  raw: string,
  defaultCountry: CountryCode = "CY",
): NormalizedPhone | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number, country: parsed.country };
}

/** Display format: international with spaces, e.g. "+357 99 123456". */
export function formatPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}
