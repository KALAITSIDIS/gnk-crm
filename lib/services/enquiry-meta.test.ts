import { describe, expect, it } from "vitest";
import {
  BUDGET_BANDS,
  budgetBandRange,
  briefChips,
  cleanEnquiryMeta,
  ENQUIRY_META_KEYS,
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
