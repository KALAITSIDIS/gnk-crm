/**
 * What a website enquiry may carry BESIDE its message (0096, audit LR-01/02).
 *
 * The site asks a buyer seven structured questions and a seller ten, and
 * until 0096 the answers reached the CRM only as sentences appended to
 * `leads.message`. They now also travel as `meta`, and land in
 * `leads.criteria` under exactly these keys — the site's own field names,
 * so the two repositories cannot drift on spelling, and the site's FIELD_CAPS
 * (gnk-web lib/enquiry-fields.ts), to the character.
 *
 * SHAPE ONLY. `criteria` is NOT rewritten by erasure or by the retention
 * sweep (0084's design), so nothing that could identify a person may enter
 * it: no name, e-mail, phone, message or free prose. Every key here is a
 * select value, a short number-as-text, a path or a campaign name. The SQL
 * function holds the same table and is the boundary; this module gives the
 * route a useful 400 and the inbox its labels. `cleanEnquiryMeta` mirrors
 * the function's rule exactly — allowlisted key, string value, trimmed,
 * non-empty, at most the cap. Change both or neither; the RLS test
 * `supabase/tests/enquiry-meta.test.ts` proves the SQL side and
 * `enquiry-meta.test.ts` this one.
 */

import { PROPERTY_TYPES } from "@/lib/validators/properties";

/** key → maximum length. */
export const ENQUIRY_META_KEYS = {
  // buyer brief (the site's BUYER_KEYS)
  looking_to: 40,
  budget: 40,
  buy_area: 80,
  buy_property_type: 40,
  bedrooms_min: 20,
  deed_required: 40,
  buy_timing: 40,
  // seller brief (the site's SELLER_KEYS)
  district: 60,
  area: 80,
  property_type: 40,
  bedrooms: 20,
  covered_area_sqm: 20,
  plot_area_sqm: 20,
  year_built: 20,
  title_deed_status: 40,
  listed_elsewhere: 40,
  timing: 40,
  // provenance
  source_page: 200,
  utm_source: 80,
  utm_medium: 80,
  utm_campaign: 120,
  referrer_host: 120,
  consent_version: 40,
} as const;

export type EnquiryMetaKey = keyof typeof ENQUIRY_META_KEYS;
export type EnquiryMeta = Partial<Record<EnquiryMetaKey, string>>;

/** Which keys describe a BUYER's brief — the ones a saved search is built from. */
export const BUYER_META_KEYS: readonly EnquiryMetaKey[] = [
  "looking_to",
  "budget",
  "buy_area",
  "buy_property_type",
  "bedrooms_min",
  "deed_required",
  "buy_timing",
];

/** Which keys describe a SELLER's property. */
export const SELLER_META_KEYS: readonly EnquiryMetaKey[] = [
  "district",
  "area",
  "property_type",
  "bedrooms",
  "covered_area_sqm",
  "plot_area_sqm",
  "year_built",
  "title_deed_status",
  "listed_elsewhere",
  "timing",
];

export function cleanEnquiryMeta(raw: unknown): EnquiryMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: EnquiryMeta = {};
  for (const [key, cap] of Object.entries(ENQUIRY_META_KEYS) as [EnquiryMetaKey, number][]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t.length === 0 || t.length > cap) continue;
    out[key] = t;
  }
  return out;
}

/**
 * The site's budget bands (gnk-web BUDGETS), pinned here because the CRM
 * cannot import the site. A band becomes a saved-search range; "unsure"
 * becomes no range at all rather than a €0 ceiling.
 */
export const BUDGET_BANDS: Record<string, { label: string; min: number | null; max: number | null }> = {
  under_300k: { label: "Under €300,000", min: null, max: 300000 },
  "300_500k": { label: "€300,000 – €500,000", min: 300000, max: 500000 },
  "500_750k": { label: "€500,000 – €750,000", min: 500000, max: 750000 },
  "750k_1m": { label: "€750,000 – €1m", min: 750000, max: 1000000 },
  over_1m: { label: "Over €1m", min: 1000000, max: null },
  unsure: { label: "Depends on the property", min: null, max: null },
};

export function budgetBandRange(
  band: string | undefined | null,
): { min: number | null; max: number | null } | null {
  if (!band) return null;
  const b = BUDGET_BANDS[band];
  if (!b || (b.min === null && b.max === null)) return null;
  return { min: b.min, max: b.max };
}

const LOOKING_TO: Record<string, string> = { buy: "Buy", rent: "Rent", either: "Buy or rent" };
const TIMINGS: Record<string, string> = {
  now: "Ready now",
  "3_months": "Within about three months",
  this_year: "Sometime this year",
  watching: "Watching the market",
  exploring: "Just want to know what it is worth",
};
/** A seller's "now" reads differently from a buyer's. */
const SELLER_TIMINGS: Record<string, string> = { ...TIMINGS, now: "Ready to sell now" };

const DEED_REQUIRED_LABELS: Record<string, string> = {
  yes: "Yes — separate deed only",
  flexible: "Flexible if the position is clear",
  unsure: "I am not sure what this means",
};

/** An area as the lookup needs it: the CRM's own row, by its English name. */
export interface AreaLookup {
  id: string;
  district_id: string;
  name_en: string;
}

/** The fields a website brief can fill on a `buyer_requirements` row. */
export interface RequirementSeed {
  label: string;
  transaction_type: "sale" | "rent";
  property_types: string[];
  area_ids: string[];
  district_ids: string[];
  budget_min: number | null;
  budget_max: number | null;
  bedrooms_min: number | null;
  title_deed_required: boolean;
  notes: string | null;
}

/**
 * The saved search a buyer's brief becomes (audit LR-01), PURE so the mapping
 * is testable without a database. The seven answers the site asks map onto
 * the CRM's own requirement fields; what has no field (timing, the deed
 * preference as words, an area the CRM does not know by that name) goes into
 * `notes` so nothing the buyer said is lost. "unsure" and a non-numeric
 * bedroom count become no opinion, never a €0 ceiling or 0 bedrooms.
 *
 * An area is matched by ANY slash-separated part of the site's label
 * ("Peyia / Coral Bay" → the CRM's "Peyia"), case-insensitively, against the
 * English name; an unmatched area leaves the search open and is named in the
 * notes. Null when the brief carries no buyer answer at all — a seller's
 * property description is not a search.
 */
export function requirementFromMeta(meta: EnquiryMeta, areas: readonly AreaLookup[]): RequirementSeed | null {
  if (!BUYER_META_KEYS.some((k) => meta[k])) return null;

  const range = budgetBandRange(meta.budget);
  const propertyTypes =
    meta.buy_property_type && (PROPERTY_TYPES as readonly string[]).includes(meta.buy_property_type)
      ? [meta.buy_property_type]
      : [];
  const bedrooms = meta.bedrooms_min ? parseInt(meta.bedrooms_min, 10) : NaN;

  let areaIds: string[] = [];
  let districtIds: string[] = [];
  if (meta.buy_area) {
    const parts = meta.buy_area
      .split("/")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const hit = areas.find((a) => parts.includes(a.name_en.trim().toLowerCase()));
    if (hit) {
      areaIds = [hit.id];
      districtIds = [hit.district_id];
    }
  }

  const notes: string[] = [];
  if (meta.buy_area && areaIds.length === 0) notes.push(`Area: ${meta.buy_area}`);
  if (meta.buy_timing && TIMINGS[meta.buy_timing]) notes.push(`Timing: ${TIMINGS[meta.buy_timing]}`);
  if (meta.deed_required && DEED_REQUIRED_LABELS[meta.deed_required]) {
    notes.push(`Separate title deed: ${DEED_REQUIRED_LABELS[meta.deed_required]}`);
  }

  return {
    label: "From website enquiry",
    transaction_type: meta.looking_to === "rent" ? "rent" : "sale",
    property_types: propertyTypes,
    area_ids: areaIds,
    district_ids: districtIds,
    budget_min: range?.min ?? null,
    budget_max: range?.max ?? null,
    bedrooms_min: Number.isInteger(bedrooms) && bedrooms >= 0 ? bedrooms : null,
    title_deed_required: meta.deed_required === "yes",
    notes: notes.length ? notes.join("\n") : null,
  };
}

/** Short labelled chips for the inbox row. Order: intent, budget, area, type, timing, source. */
export function briefChips(criteria: unknown): string[] {
  const m = cleanEnquiryMeta(criteria);
  const chips: string[] = [];
  if (m.looking_to && LOOKING_TO[m.looking_to]) chips.push(LOOKING_TO[m.looking_to]!);
  if (m.budget && BUDGET_BANDS[m.budget]) chips.push(BUDGET_BANDS[m.budget]!.label);
  if (m.buy_area) chips.push(m.buy_area);
  else if (m.area) chips.push(m.district ? `${m.area}, ${m.district}` : m.area);
  if (m.buy_property_type) chips.push(m.buy_property_type.replace(/_/g, " "));
  else if (m.property_type) chips.push(m.property_type.replace(/_/g, " "));
  if (m.buy_timing && TIMINGS[m.buy_timing]) chips.push(TIMINGS[m.buy_timing]!);
  else if (m.timing && SELLER_TIMINGS[m.timing]) chips.push(SELLER_TIMINGS[m.timing]!);
  if (m.utm_source) chips.push(`via ${m.utm_source}`);
  return chips;
}
