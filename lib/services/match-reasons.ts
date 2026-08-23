import type { MatchReason } from "@/lib/services/matching";
import { featureLabel } from "@/lib/constants/features";
import { formatMoney } from "@/lib/utils/format";

/**
 * Plain-language rendering of a match reason (0043, T-B6).
 *
 * Separate from `matching.ts` on purpose: that module is pure decision logic
 * with no formatting, and keeping money/labels out of it is what lets the rules
 * be tested without Intl in the picture. This is the presentation half, and it
 * is still pure so it can be tested too.
 *
 * THE POINT OF THE WHOLE FEATURE IS THIS FUNCTION. A score with no reasons is a
 * number nobody acts on — the outside review said so and it was right. Every
 * chip beside a match says what was missed, in words an agent can repeat to a
 * buyer on the phone.
 */

const labelize = (s: string) => s.replace(/_/g, " ");

export function describeMatchReason(r: MatchReason): string {
  switch (r.code) {
    case "status":
      return `Not on the market (${labelize(r.got)})`;
    case "status_not_available":
      return r.got === "reserved" ? "Reserved" : "Under offer";
    case "transaction_type":
      return `Listed for ${labelize(r.got)}, not ${labelize(r.wanted)}`;
    case "property_type":
      return `${labelize(r.got)} — not a type they asked for`;
    case "district":
      return "Outside the districts they asked for";
    case "area":
      return "Not in one of their areas";
    case "budget":
      // The overage is the number an agent negotiates with, so say it.
      return r.overBy > 0
        ? `${formatMoney(r.overBy)} over budget`
        : `Within budget (${formatMoney(r.got)})`;
    case "budget_bracket":
      return `Below their ${formatMoney(r.min)} floor`;
    case "price_unknown":
      return "No price set";
    case "bedrooms": {
      const got = r.got === null ? "not stated" : `${r.got}`;
      if (r.min !== null && r.max !== null) return `Needs ${r.min}–${r.max} bed, has ${got}`;
      if (r.min !== null) return `Needs ${r.min}+ bed, has ${got}`;
      if (r.max !== null) return `Needs up to ${r.max} bed, has ${got}`;
      return `Bedrooms ${got}`;
    }
    case "bathrooms":
      return r.got === null
        ? `Bathrooms not stated (wants ${r.min}+)`
        : `${r.got} bath, wants ${r.min}+`;
    case "covered_area":
      return r.got === null
        ? `Covered area not stated (wants ${r.min} m²+)`
        : `${r.got} m² covered, wants ${r.min} m²+`;
    case "plot_area":
      return r.got === null
        ? `Plot not stated (wants ${r.min} m²+)`
        : `${r.got} m² plot, wants ${r.min} m²+`;
    case "title_deed":
      return `Title deed: ${labelize(r.got)} — they need a separate deed`;
    case "sea_distance":
      return r.got === null
        ? `Distance to sea not stated (wants under ${r.max} m)`
        : `${r.got} m from the sea, wants under ${r.max} m`;
    case "delivery":
      return r.got === null
        ? `No delivery date (wants by ${r.by})`
        : `Delivers ${r.got}, wants by ${r.by}`;
    case "vat":
      return `VAT ${labelize(r.got)}, they want ${labelize(r.wanted)}`;
    case "feature":
      return `No ${featureLabel(r.feature).toLowerCase()}`;
  }
}

/** Positive phrasing for the criteria a candidate DID satisfy. */
export function describeMatchHit(r: MatchReason): string {
  switch (r.code) {
    case "area":
      return "In their area";
    case "budget":
      return "Within budget";
    case "budget_bracket":
      return "In their price bracket";
    case "bathrooms":
      return `${r.got} bath`;
    case "covered_area":
      return `${r.got} m² covered`;
    case "plot_area":
      return `${r.got} m² plot`;
    case "sea_distance":
      return `${r.got} m from the sea`;
    case "delivery":
      return `Delivers ${r.got}`;
    case "vat":
      return `VAT ${labelize(r.got)}`;
    case "feature":
      return featureLabel(r.feature);
    case "status_not_available":
      return "Available now";
    default:
      return describeMatchReason(r);
  }
}
