import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  absolutizeListingImages,
  parseFeedParams,
  publicMediaUrl,
} from "./public-listings";

const q = (s: string) => new URLSearchParams(s);

describe("public listing feed params", () => {
  it("an ABSENT limit takes the default, not zero", () => {
    // The regression this file exists for. `Number(null)` is 0, so the first
    // version answered a plain `?org=gnk` with limit 0 — a 200 and an empty
    // feed, which is exactly the failure a marketing site cannot diagnose.
    expect(parseFeedParams(q("org=gnk"))).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
  });

  it("an EMPTY limit also takes the default", () => {
    expect(parseFeedParams(q("limit=&offset=")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("limit=   ")).limit).toBe(DEFAULT_LIMIT);
  });

  it("an explicit limit is honoured, and zero is honoured when it is asked for", () => {
    expect(parseFeedParams(q("limit=10")).limit).toBe(10);
    // asking for nothing is a legitimate request — it is only the ABSENT case
    // that must not collapse to zero
    expect(parseFeedParams(q("limit=0")).limit).toBe(0);
  });

  it("the limit is capped server-side", () => {
    expect(parseFeedParams(q("limit=9999")).limit).toBe(MAX_LIMIT);
    expect(parseFeedParams(q("limit=101")).limit).toBe(MAX_LIMIT);
  });

  it("nonsense falls back rather than erroring", () => {
    // A feed that 400s on a stray query string goes dark for a reason nobody
    // can see from a browser.
    expect(parseFeedParams(q("limit=abc")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("limit=-5")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("limit=NaN")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("limit=Infinity")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("offset=abc")).offset).toBe(0);
    expect(parseFeedParams(q("offset=-1")).offset).toBe(0);
  });

  it("fractional values floor rather than reaching SQL as a float", () => {
    expect(parseFeedParams(q("limit=10.9")).limit).toBe(10);
    expect(parseFeedParams(q("offset=2.7")).offset).toBe(2);
  });

  it("offset is not capped at the limit's ceiling", () => {
    // paging deep into a large feed is legitimate; only page SIZE is capped
    expect(parseFeedParams(q("offset=5000")).offset).toBe(5000);
  });
});

describe("feed image URLs (FEED-1, 0073)", () => {
  const URL_BASE = "https://example.supabase.co";
  const img = (over: Partial<Record<"thumb" | "card" | "full", string | null>> = {}) => ({
    thumb: "properties/p1/m1_thumb.webp",
    card: "properties/p1/m1_card.webp",
    full: "properties/p1/m1_full.webp",
    alt: { en: "front" },
    watermarked: true,
    ...over,
  });

  it("builds the public-bucket URL a browser can load directly", () => {
    expect(publicMediaUrl(URL_BASE, "properties/p1/m1_card.webp")).toBe(
      "https://example.supabase.co/storage/v1/object/public/media/properties/p1/m1_card.webp",
    );
  });

  it("no double slashes whatever the inputs carry — broken images on someone else's site", () => {
    expect(publicMediaUrl(`${URL_BASE}/`, "/properties/p1/m1_card.webp")).toBe(
      "https://example.supabase.co/storage/v1/object/public/media/properties/p1/m1_card.webp",
    );
  });

  it("a null rendition stays null rather than becoming a URL to nothing", () => {
    expect(publicMediaUrl(URL_BASE, null)).toBeNull();
    const [row] = absolutizeListingImages([{ images: [img({ thumb: null })] }], URL_BASE);
    expect((row.images as Array<{ thumb: string | null }>)[0].thumb).toBeNull();
  });

  it("absolutizes every rendition and leaves the rest of the object alone", () => {
    const [row] = absolutizeListingImages(
      [{ reference: "PAF0001", images: [img()] } as { reference: string; images: unknown }],
      URL_BASE,
    );
    const image = (row.images as Array<Record<string, unknown>>)[0];
    for (const k of ["thumb", "card", "full"] as const) {
      expect(image[k]).toMatch(/^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/media\/properties\//);
    }
    expect(image.alt).toEqual({ en: "front" });
    expect(image.watermarked).toBe(true);
    expect((row as { reference?: string }).reference).toBe("PAF0001");
  });

  it("a row without an images array passes through untouched (pre-0073 database mid-rollout)", () => {
    const rows = [{ reference: "PAF0001" } as { reference: string; images?: unknown }];
    expect(absolutizeListingImages(rows, URL_BASE)).toEqual(rows);
  });
});
