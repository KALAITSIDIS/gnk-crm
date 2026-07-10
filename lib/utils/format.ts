/**
 * Display formatting (doc 02 §A11): currency EUR as €1.234.567 (dot grouping,
 * no decimals for whole amounts), areas m², timezone Asia/Nicosia.
 */

export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  const hasCents = Math.abs(n % 1) > 0;
  const formatted = new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(n);
  return `€${formatted}`;
}

export function formatArea(sqm: number | string | null | undefined): string {
  if (sqm === null || sqm === undefined || sqm === "") return "—";
  const n = typeof sqm === "string" ? Number(sqm) : sqm;
  if (!Number.isFinite(n)) return "—";
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(n)} m²`;
}

const NICOSIA_TZ = "Asia/Nicosia";

export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: NICOSIA_TZ,
  }).format(d);
}

export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeZone: NICOSIA_TZ,
  }).format(d);
}
