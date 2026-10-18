/**
 * Plain names for the `cyprus_config` rows on Settings → Cyprus config (A08,
 * review 2026-10-18). The page is the admin's escape hatch — every row's raw
 * JSON, editable — and it used to head each card with the row's key in
 * monospace ("transfer_fees", "nudge_thresholds") over the stored
 * description, which for the newer rows documents the JSON's field names and
 * the machinery ("…the nightly sweeps…", "…see 0052").
 *
 * Each known key gets a heading and one sentence of what it is for, and —
 * where a typed form exists — where to change it instead. The key and the
 * stored description stay on the card, under "Technical details": they are
 * what the JSON editor needs. A key this map does not know (a row added by a
 * later migration) is shown by its key and stored description, as before —
 * nothing is hidden for want of a label.
 *
 * Pure data, no directive: the card (a client component) reads it, and so
 * can a test.
 */
export interface ConfigLabel {
  title: string;
  summary: string;
  /** a settings page with a typed form for the same row */
  editOn?: { href: string; label: string };
}

export const CONFIG_LABELS: Readonly<Record<string, ConfigLabel>> = {
  transfer_fees: {
    title: "Land Registry transfer fees",
    summary: "The Department of Lands and Surveys fee bands, the relief and the VAT exemption the calculators apply.",
  },
  stamp_duty: {
    title: "Stamp duty",
    // true whether or not the repeal is recorded: since 0070 the stored value
    // carries an `abolished` block (from 2026-01-01, Law 239(I)/2025), and the
    // calculators render its notice instead of a figure — never "current"
    summary:
      "The stamp duty bands and cap for contracts signed before the duty's repeal, and the date from which it no longer applies — once that date is stored, the calculators show the repeal notice instead of a figure.",
  },
  vat_property: {
    title: "VAT on property",
    summary: "The standard and reduced VAT rates, and the limits of the reduced rate for a first home.",
  },
  capital_gains_tax: {
    title: "Capital gains tax",
    summary: "The rate and lifetime exemptions used for a seller's estimate.",
  },
  other_property_taxes: {
    title: "Other property taxes",
    summary: "Background notes on other taxes and charges, for the calculators and proposals.",
  },
  company_details: {
    title: "Company details",
    summary: "The company name, brand and website printed on PDFs, viewing slips and evidence reports.",
  },
  default_mandate_terms: {
    title: "Default mandate terms",
    summary:
      "The office's standard commission, mandate type and length, offered when an owner or developer has no terms of their own. Every value stays editable on the form.",
  },
  nudge_thresholds: {
    title: "Chase-up task timing",
    summary: "When the nightly checks raise chase-up tasks for deals, viewings, reservations and instalments.",
    editOn: { href: "/settings/nudges", label: "Nudges" },
  },
  lead_routing: {
    title: "Lead routing",
    summary: "How a new website enquiry is assigned when it arrives.",
    editOn: { href: "/settings/lead-routing", label: "Lead routing" },
  },
  lead_escalation: {
    title: "Lead escalation",
    summary: "Who is e-mailed when a website enquiry waits too long for a first response.",
    editOn: { href: "/settings/lead-escalation", label: "Lead escalation" },
  },
};

/** The row's label, or null for a key this map does not know (own entries only). */
export function configLabel(key: string): ConfigLabel | null {
  return Object.hasOwn(CONFIG_LABELS, key) ? CONFIG_LABELS[key]! : null;
}
