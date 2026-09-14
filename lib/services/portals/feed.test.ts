import { describe, expect, it } from "vitest";
import { kyero } from "./dialects/kyero";
import {
  SALE_VILLA,
  RENT_FLAT,
  LAND_PLOT,
  SHOP_UNIT,
  SALE_OR_RENT,
  KYERO_SETTINGS,
} from "./dialects/__fixtures__/listings";
import { assemblePortalFeed, MAX_PAGES } from "./feed";
import type { FeedListing, PublicListingRow, SupplementRow } from "./feed-listing";
import { MAX_LIMIT } from "@/lib/services/public-listings";
import { portalById } from "./registry";

const je = portalById("jamesedition")!;
const sup = (l: FeedListing): SupplementRow => ({
  reference: l.row.reference,
  lat: l.coords?.lat ?? null,
  lng: l.coords?.lng ?? null,
  location_approx: l.coords?.approx ?? false,
  images: l.images.map((i) => ({ jpeg: i.url.split("/media/")[1], alt: null })),
});
const pages = (all: PublicListingRow[]) => async (offset: number, limit: number) => all.slice(offset, offset + limit);

describe("assemblePortalFeed", () => {
  it("keeps selected, eligible listings in FEED order and drops the unselected and the ineligible", async () => {
    // SALE_OR_RENT (PAF0004) sits BEFORE SALE_VILLA (PAF0001) in the feed, the
    // reverse of supplement order — the rendered order must follow the feed.
    const rows = [
      SALE_OR_RENT.row,
      RENT_FLAT.row,
      LAND_PLOT.row,
      SALE_VILLA.row,
      SHOP_UNIT.row,
    ] as unknown as PublicListingRow[];
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p.supabase.co",
      supplements: [sup(SHOP_UNIT), sup(SALE_VILLA), sup(LAND_PLOT), sup(SALE_OR_RENT)],
      fetchPage: pages(rows),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.count).toBe(2); // LAND_PLOT and SHOP_UNIT have one photo; JamesEdition needs two
    expect(r.selected).toBe(4);
    expect(r.missing).toBe(0);
    expect(r.body.indexOf("<ref>PAF0004</ref>")).toBeLessThan(r.body.indexOf("<ref>PAF0001</ref>"));
    expect(r.body).not.toContain("<ref>PAF0002</ref>"); // not selected
    expect(r.body).not.toContain("<ref>PAF0003</ref>"); // selected but ineligible
    expect(r.body).not.toContain("<ref>PAF0005</ref>"); // selected but ineligible
  });

  it("stops paging once every selected reference is found", async () => {
    let calls = 0;
    const many = Array.from({ length: 250 }, (_, i) => {
      if (i === 0) return SALE_VILLA.row;
      if (i === 150) return SALE_OR_RENT.row;
      return { ...LAND_PLOT.row, reference: `X${i}` };
    }) as unknown as PublicListingRow[];
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
      fetchPage: async (offset, limit) => { calls++; return pages(many)(offset, limit); },
    });
    if (!r.ok) throw new Error(r.error);
    expect(calls).toBe(2); // SALE_OR_RENT is on the second page — the join spans pages
    expect(r.count).toBe(2);
    expect(r.body).toContain("<ref>PAF0001</ref>");
    expect(r.body).toContain("<ref>PAF0004</ref>");
  });

  it("a reference returned twice by a window shift between page fetches is emitted once", async () => {
    const page0 = [
      ...Array.from({ length: MAX_LIMIT - 1 }, (_, i) => ({ ...LAND_PLOT.row, reference: `Z${i}` })),
      SALE_VILLA.row,
    ] as unknown as PublicListingRow[];
    const page1 = [
      SALE_VILLA.row, // window shift: the same row is returned again at the top of the next page
      SALE_OR_RENT.row,
      ...Array.from({ length: MAX_LIMIT - 2 }, (_, i) => ({ ...LAND_PLOT.row, reference: `W${i}` })),
    ] as unknown as PublicListingRow[];
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
      fetchPage: async (offset) => (offset === 0 ? page0 : page1),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.body.split("<ref>PAF0001</ref>").length - 1).toBe(1);
    expect(r.count).toBe(2);
  });

  it("marks truncation as an error at the page ceiling instead of looping forever", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      maxPages: 2,
      supplements: [{ ...sup(SALE_VILLA), reference: "NEVER" }],
      fetchPage: async () => Array.from({ length: MAX_LIMIT }, (_, i) => ({ ...LAND_PLOT.row, reference: `Y${i}` })) as unknown as PublicListingRow[],
    });
    expect(r).toEqual({ ok: false, error: "feed truncated at the page ceiling" });
    expect(MAX_PAGES).toBe(25);
  });

  it("a set completed on the final allowed page is not truncation", async () => {
    const filler = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...LAND_PLOT.row, reference: `${prefix}${i}` })) as unknown as PublicListingRow[];
    const lastPage = [SALE_VILLA.row as unknown as PublicListingRow, ...filler("V", MAX_LIMIT - 1)];
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p", maxPages: 2,
      supplements: [sup(SALE_VILLA)],
      fetchPage: async (offset, limit) => (offset === 0 ? filler("U", limit) : lastPage),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.count).toBe(1);
    expect(r.missing).toBe(0);
  });

  it("a reference not found after a complete scan is reported missing, not an error", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [sup(SALE_VILLA), { ...sup(SALE_VILLA), reference: "GONE" }],
      fetchPage: async () => [SALE_VILLA.row] as unknown as PublicListingRow[],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.count).toBe(1);
    expect(r.selected).toBe(2);
    expect(r.missing).toBe(1);
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
    const rows = [SALE_VILLA.row, RENT_FLAT.row, LAND_PLOT.row, SHOP_UNIT.row] as unknown as PublicListingRow[];
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [], fetchPage: async (o, l) => { calls++; return pages(rows)(o, l); },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.body).toBe(kyero.empty());
    expect(calls).toBe(0);
  });

  it("a selection with nothing eligible renders the empty document", async () => {
    const rows = [SALE_VILLA.row, RENT_FLAT.row, LAND_PLOT.row, SHOP_UNIT.row] as unknown as PublicListingRow[];
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p",
      supplements: [sup(LAND_PLOT)], fetchPage: pages(rows),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.count).toBe(0);
    expect(r.body).toBe(kyero.empty());
  });
});
