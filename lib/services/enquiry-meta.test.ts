import { describe, expect, it } from "vitest";
import {
  BUDGET_BANDS,
  budgetBandRange,
  briefChips,
  cleanEnquiryMeta,
  ENQUIRY_META_KEYS,
  requirementFromMeta,
} from "./enquiry-meta";

/**
 * The allowlist the enquiry door applies to `p_meta` (0096, audit LR-01/02),
 * as the app reads it. The SQL function holds the same table and is the
 * boundary; `supabase/tests/enquiry-meta.test.ts` proves that side. This
 * file pins the app's copy so the two cannot drift on a key or a cap.
 */
describe("cleanEnquiryMeta — the same rule the SQL function applies", () => {
  it("keeps only allowlisted string keys, trimmed and capped", () => {
    const out = cleanEnquiryMeta({
      budget: " 300_500k ",
      buy_area: "Peyia / Coral Bay",
      email: "buyer@example.invalid", // never — identity stays in message
      name: "A Buyer",
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
      bedrooms_min: 3, // a number is not a string: dropped
      looking_to: "",
    });
    expect(out).toEqual({
      budget: "300_500k",
      buy_area: "Peyia / Coral Bay",
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
    });
  });

  it("caps each value at its declared length", () => {
    const out = cleanEnquiryMeta({ utm_campaign: "x".repeat(121), utm_medium: "y".repeat(80) });
    expect(out.utm_campaign).toBeUndefined();
    expect(out.utm_medium).toBe("y".repeat(80));
  });

  it("returns an empty object for nothing, null or garbage", () => {
    expect(cleanEnquiryMeta(null)).toEqual({});
    expect(cleanEnquiryMeta(undefined)).toEqual({});
    expect(cleanEnquiryMeta("x")).toEqual({});
    expect(cleanEnquiryMeta([1])).toEqual({});
  });

  it("names no personal key — the allowlist is shape only", () => {
    for (const k of Object.keys(ENQUIRY_META_KEYS)) {
      expect(k).not.toMatch(/name|email|phone|message|address/);
    }
  });

  it("holds the site's caps to the character (gnk-web FIELD_CAPS)", () => {
    expect(ENQUIRY_META_KEYS.district).toBe(60);
    expect(ENQUIRY_META_KEYS.area).toBe(80);
    expect(ENQUIRY_META_KEYS.buy_area).toBe(80);
    expect(ENQUIRY_META_KEYS.bedrooms_min).toBe(20);
    expect(ENQUIRY_META_KEYS.source_page).toBe(200);
  });
});

describe("budget bands", () => {
  it("maps every band the site offers to a range, and 'unsure' to none", () => {
    expect(budgetBandRange("under_300k")).toEqual({ min: null, max: 300000 });
    expect(budgetBandRange("300_500k")).toEqual({ min: 300000, max: 500000 });
    expect(budgetBandRange("500_750k")).toEqual({ min: 500000, max: 750000 });
    expect(budgetBandRange("750k_1m")).toEqual({ min: 750000, max: 1000000 });
    expect(budgetBandRange("over_1m")).toEqual({ min: 1000000, max: null });
    expect(budgetBandRange("unsure")).toBeNull();
    expect(budgetBandRange("nonsense")).toBeNull();
    expect(budgetBandRange(undefined)).toBeNull();
    expect(Object.keys(BUDGET_BANDS)).toHaveLength(6);
  });
});

describe("briefChips — what the inbox shows beside a website lead", () => {
  it("renders labelled chips for the brief and provenance, in a fixed order", () => {
    expect(
      briefChips({
        channel: "website_form",
        listing_reference: "PAF0001",
        budget: "300_500k",
        buy_area: "Peyia / Coral Bay",
        buy_timing: "3_months",
        looking_to: "buy",
        utm_source: "instagram",
        source_page: "/properties/PAF0001",
      }),
    ).toEqual([
      "Buy",
      "€300,000 – €500,000",
      "Peyia / Coral Bay",
      "Within about three months",
      "via instagram",
    ]);
  });

  it("reads a seller's brief too", () => {
    expect(
      briefChips({ district: "Paphos", area: "Tala / Tsada", property_type: "villa", timing: "now" }),
    ).toEqual(["Tala / Tsada, Paphos", "villa", "Ready to sell now"]);
  });

  it("is empty for a lead with no brief", () => {
    expect(briefChips({ channel: "website_form", listing_reference: null })).toEqual([]);
    expect(briefChips(null)).toEqual([]);
  });
});

describe("requirementFromMeta — the saved search a buyer's brief becomes (LR-01)", () => {
  const areas = [
    { id: "a-peyia", district_id: "d-paf", name_en: "Peyia" },
    { id: "a-tala", district_id: "d-paf", name_en: "Tala" },
    { id: "a-germ", district_id: "d-lim", name_en: "Germasogeia" },
  ];

  it("maps the seven buyer answers onto the CRM's requirement fields", () => {
    const r = requirementFromMeta(
      {
        looking_to: "buy",
        budget: "300_500k",
        buy_area: "Peyia / Coral Bay",
        buy_property_type: "villa",
        bedrooms_min: "3",
        deed_required: "yes",
        buy_timing: "3_months",
      },
      areas,
    );
    expect(r).toEqual({
      label: "From website enquiry",
      transaction_type: "sale",
      property_types: ["villa"],
      area_ids: ["a-peyia"],
      district_ids: ["d-paf"],
      budget_min: 300000,
      budget_max: 500000,
      bedrooms_min: 3,
      title_deed_required: true,
      notes: "Timing: Within about three months\nSeparate title deed: Yes — separate deed only",
    });
  });

  it("matches an area by any slash-separated part, case-insensitively, and leaves it open otherwise", () => {
    expect(requirementFromMeta({ budget: "over_1m", buy_area: "Coral Bay / PEYIA" }, areas)!.area_ids).toEqual(["a-peyia"]);
    const open = requirementFromMeta({ budget: "over_1m", buy_area: "Universal" }, areas)!;
    expect(open.area_ids).toEqual([]);
    expect(open.district_ids).toEqual([]);
    expect(open.notes).toContain("Area: Universal");
  });

  it("treats rent as a rental search, 'either' as a sale, and an unknown type as no type", () => {
    expect(requirementFromMeta({ looking_to: "rent", budget: "unsure" }, areas)!.transaction_type).toBe("rent");
    expect(requirementFromMeta({ looking_to: "either" }, areas)!.transaction_type).toBe("sale");
    expect(requirementFromMeta({ looking_to: "buy", buy_property_type: "castle" }, areas)!.property_types).toEqual([]);
  });

  it("keeps 'unsure' and blank answers out of the numbers", () => {
    const r = requirementFromMeta({ budget: "unsure", bedrooms_min: "about three", deed_required: "unsure" }, areas)!;
    expect(r.budget_min).toBeNull();
    expect(r.budget_max).toBeNull();
    expect(r.bedrooms_min).toBeNull();
    expect(r.title_deed_required).toBe(false);
  });

  it("is null when the brief has no buyer answer at all", () => {
    expect(requirementFromMeta({ source_page: "/contact", utm_source: "instagram" }, areas)).toBeNull();
    expect(requirementFromMeta({ district: "Paphos", area: "Tala / Tsada", property_type: "villa" }, areas)).toBeNull();
    expect(requirementFromMeta({}, areas)).toBeNull();
  });
});
