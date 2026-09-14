import { describe, expect, it } from "vitest";
import { kyero } from "./dialects/kyero";
import { SALE_VILLA, RENT_FLAT, LAND_PLOT, SHOP_UNIT, KYERO_SETTINGS } from "./dialects/__fixtures__/listings";
import { assemblePortalFeed, MAX_PAGES } from "./feed";
import type { FeedListing, PublicListingRow, SupplementRow } from "./feed-listing";
import { MAX_LIMIT } from "@/lib/services/public-listings";
import { portalById } from "./registry";

const je = portalById("jamesedition")!;
const rows = [SALE_VILLA.row, RENT_FLAT.row, LAND_PLOT.row, SHOP_UNIT.row] as unknown as PublicListingRow[];
const sup = (l: FeedListing): SupplementRow => ({
  reference: l.row.reference,
  lat: l.coords?.lat ?? null,
  lng: l.coords?.lng ?? null,
  location_approx: l.coords?.approx ?? false,
  images: l.images.map((i) => ({ jpeg: i.url.split("/media/")[1], alt: null })),
});
const pages = (all: PublicListingRow[]) => async (offset: number) => all.slice(offset, offset + MAX_LIMIT);

describe("assemblePortalFeed", () => {
  it("keeps selected listings in feed order and drops the unselected and the ineligible", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p.supabase.co",
      supplements: [sup(SHOP_UNIT), sup(LAND_PLOT), sup(SALE_VILLA)],
      fetchPage: pages(rows),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.count).toBe(1); // LAND_PLOT and SHOP_UNIT have one photo; JamesEdition needs two
    expect(r.body).toContain("<ref>PAF0001</ref>");
    expect(r.body).not.toContain("<ref>PAF0002</ref>"); // not selected
    expect(r.body).not.toContain("<ref>PAF0003</ref>");
    expect(r.body).not.toContain("<ref>PAF0005</ref>");
  });

  it("stops paging once every selected reference is found", async () => {
    let calls = 0;
    const many = Array.from({ length: 250 }, (_, i) => (i === 0 ? SALE_VILLA.row : { ...LAND_PLOT.row, reference: `X${i}` })) as unknown as PublicListingRow[];
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [sup(SALE_VILLA)],
      fetchPage: async (offset) => { calls++; return pages(many)(offset); },
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("marks truncation at the page ceiling instead of looping forever", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [{ ...sup(SALE_VILLA), reference: "NEVER" }],
      fetchPage: async () => Array.from({ length: MAX_LIMIT }, (_, i) => ({ ...LAND_PLOT.row, reference: `Y${i}` })) as unknown as PublicListingRow[],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.truncated).toBe(true);
    expect(r.count).toBe(0);
    expect(MAX_PAGES).toBe(25);
  });

  it("a failing page is an error, not an empty feed (an empty feed would delist everything)", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [sup(SALE_VILLA)],
      fetchPage: async () => { throw new Error("db down"); },
    });
    expect(r).toEqual({ ok: false, error: "db down" });
  });

  it("no selection renders the empty document without touching the database", async () => {
    let calls = 0;
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [], fetchPage: async (o) => { calls++; return pages(rows)(o); },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.body).toBe(kyero.empty());
    expect(calls).toBe(0);
  });

  it("a selection with nothing eligible renders the empty document", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [sup(LAND_PLOT)], fetchPage: pages(rows),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.count).toBe(0);
    expect(r.body).toBe(kyero.empty());
  });
});
