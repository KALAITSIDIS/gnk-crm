/**
 * A phone number as Kyero's contact nodes want it: digits only, the country
 * code written with a leading 00 — `0035726000000` for `+357 26 000000`
 * (kyero_v3_import_spec.txt, contact_number / whatsapp_number: "numeric, must
 * include a country code … in the format of 00##").
 *
 * It REWRITES what the desk typed, never guesses at it: separators go, a
 * leading `+` becomes `00`, and anything that does not then read as 00 plus
 * 7–15 digits answers null — a number with no country code is not given one.
 */
export function internationalPhoneDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = raw.trim().replace(/[\s().\-/]/g, "");
  const digits = compact.startsWith("+") ? `00${compact.slice(1)}` : compact;
  return /^00[1-9]\d{6,14}$/.test(digits) ? digits : null;
}
