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

/**
 * First-response duration for the admin dashboard KPIs (0042).
 *
 * DEFENSIVE ABOUT A MISSING KEY ON PURPOSE. Code and schema land out of order
 * in this project — Vercel deploys on push, migrations are applied by hand
 * (HANDOFF §7) — so a deploy can briefly run against an `admin_dashboard_stats`
 * that predates 0042 and returns no `p50_response_min`. `undefined` must render
 * as "—", exactly like null. The first version of this used `v === null`, which
 * let `undefined` through to `Number(undefined)` and painted **"NaNh NaNm"** on
 * the production dashboard; it was caught before the push, not after.
 *
 * Rounds to whole minutes BEFORE splitting into h/m. Doing it after gives
 * "1h 60m" for 119.7 — the arithmetic the split version of this had.
 */
export function formatResponseMinutes(min: number | string | null | undefined): string {
  if (min === null || min === undefined) return "—";
  const n = typeof min === "string" ? Number(min) : min;
  if (!Number.isFinite(n) || n < 0) return "—";
  const total = Math.round(n);
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}
