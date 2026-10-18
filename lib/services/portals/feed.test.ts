import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { kyero } from "./dialects/kyero";
import type { DialectRenderer } from "./dialects/types";
import {
  SALE_VILLA,
  RENT_FLAT,
  LAND_PLOT,
  SHOP_UNIT,
  SALE_OR_RENT,
  KYERO_SETTINGS,
} from "./dialects/__fixtures__/listings";
import { assemblePortalFeed, MAX_PAGES, MAX_RECHECK, type AssembleArgs, type AssembleResult, type RevisionRow } from "./feed";
import type { FeedListing, FeedRow, SupplementImage, SupplementRow } from "./feed-listing";
import { MAX_LIMIT } from "@/lib/services/public-listings";
import { portalById } from "./registry";

const je = portalById("jamesedition")!;

/** A JPEG the portal will accept: 2400×1600 delivers 1600×1067, over JamesEdition's 800×600. */
const SHARP = { width: 2400, height: 1600 };
const jpeg = (ref: string, n: number, size: { width: number | null; height: number | null } = SHARP): SupplementImage => ({
  jpeg: `properties/${ref}/${n}_jpeg.jpg`,
  alt: null,
  ...size,
});

/** The supplement row 0150 would answer for a fixture: its photos, at a size the portal accepts. */
const sup = (l: FeedListing): SupplementRow => ({
  reference: l.row.reference,
  lat: l.coords?.lat ?? null,
  lng: l.coords?.lng ?? null,
  location_approx: l.coords?.approx ?? false,
  images: l.images.map((i) => ({ jpeg: i.url.split("/media/")[1]!, alt: null, ...SHARP })),
});

/** A supplement row for a hand-made reference with `photos` JPEGs of `size`. */
const supOf = (reference: string, photos: number, size = SHARP): SupplementRow => ({
  reference,
  lat: null,
  lng: null,
  location_approx: false,
  images: Array.from({ length: photos }, (_, i) => jpeg(reference, i + 1, size)),
});

/** What public_listings (0088) puts in `images`: the site's WebP renditions, one object per photo. */
const sitePhotos = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    thumb: `properties/x/${i}_thumb.webp`,
    card: `properties/x/${i}_card.webp`,
    full: `properties/x/${i}_full.webp`,
    alt: null,
    watermarked: false,
  }));

const pages = (all: FeedRow[]) => async (offset: number, limit: number) => all.slice(offset, offset + limit);
const filler = (prefix: string, n: number): FeedRow[] =>
  Array.from({ length: n }, (_, i) => ({ ...LAND_PLOT.row, reference: `${prefix}${i}` }));

const assemble = (a: Partial<AssembleArgs> & Pick<AssembleArgs, "supplements" | "fetchPage">) =>
  assemblePortalFeed({ portal: je, renderer: kyero, settings: KYERO_SETTINGS, supabaseUrl: "https://p.supabase.co", ...a });

function served(r: AssembleResult) {
  if (!r.ok) throw new Error(`refused: ${r.reason} — ${r.error}`);
  return r;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Each `<property>`'s `<date>`, keyed by its `<ref>`. */
function datesByRef(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of body.match(/<property>[\s\S]*?<\/property>/g) ?? []) {
    const ref = /<ref>([^<]*)<\/ref>/.exec(block)?.[1];
    if (ref) out[ref] = /<date>([^<]*)<\/date>/.exec(block)?.[1] ?? "";
  }
  return out;
}

/** The real renderer, with what the assembler handed it written down. */
function observed(renderer: DialectRenderer) {
  const fingerprints = new Map<string, string>();
  const rendered: FeedListing[][] = [];
  const spy: DialectRenderer = {
    contentType: renderer.contentType,
    render: (listings, settings) => {
      rendered.push([...listings]);
      return renderer.render(listings, settings);
    },
    fingerprint: (listing, settings) => {
      const fp = renderer.fingerprint(listing, settings);
      fingerprints.set(listing.row.reference, fp);
      return fp;
    },
    empty: () => renderer.empty(),
  };
  return { spy, fingerprints, rendered };
}

/**
 * A model of 0150 sync_portal_export: a listing keeps its changed_at while its
 * sha256 holds, takes the clock's time when it changes, and is forgotten when
 * it is no longer sent. Answers every listing it holds.
 */
function exportState(times: readonly string[]) {
  const state = new Map<string, { sha256: string; changedAt: string }>();
  const calls: RevisionRow[][] = [];
  let tick = 0;
  const sync = async (rows: readonly RevisionRow[]) => {
    calls.push(rows.map((r) => ({ ...r })));
    const now = times[Math.min(tick++, times.length - 1)]!;
    for (const r of rows) {
      const prev = state.get(r.reference);
      if (!prev || prev.sha256 !== r.sha256) state.set(r.reference, { sha256: r.sha256, changedAt: now });
    }
    for (const ref of [...state.keys()]) if (!rows.some((r) => r.reference === ref)) state.delete(ref);
    return new Map([...state].map(([ref, s]) => [ref, s.changedAt]));
  };
  return { sync, calls };
}

describe("assemblePortalFeed — selection and paging", () => {
  it("keeps selected, eligible listings in FEED order and drops the unselected and the ineligible", async () => {
    // SALE_OR_RENT (PAF0004) sits BEFORE SALE_VILLA (PAF0001) in the feed, the
    // reverse of supplement order — the rendered order must follow the feed.
    const rows = [SALE_OR_RENT.row, RENT_FLAT.row, LAND_PLOT.row, SALE_VILLA.row, SHOP_UNIT.row];
    const r = served(
      await assemble({
        supplements: [sup(SHOP_UNIT), sup(SALE_VILLA), sup(LAND_PLOT), sup(SALE_OR_RENT)],
        fetchPage: pages(rows),
      }),
    );
    expect(r.count).toBe(2); // LAND_PLOT and SHOP_UNIT have one photo; JamesEdition needs two
    expect(r.selected).toBe(4);
    expect(r.missing).toBe(0);
    expect(r.excluded).toBe(2);
    expect(r.body.indexOf("<ref>PAF0004</ref>")).toBeLessThan(r.body.indexOf("<ref>PAF0001</ref>"));
    expect(r.body).not.toContain("<ref>PAF0002</ref>"); // not selected
    expect(r.body).not.toContain("<ref>PAF0003</ref>"); // selected but ineligible
    expect(r.body).not.toContain("<ref>PAF0005</ref>"); // selected but ineligible
  });

  it("stops paging once every selected reference is found", async () => {
    let calls = 0;
    const many: FeedRow[] = Array.from({ length: 250 }, (_, i) => {
      if (i === 0) return SALE_VILLA.row;
      if (i === 150) return SALE_OR_RENT.row;
      return { ...LAND_PLOT.row, reference: `X${i}` };
    });
    const r = served(
      await assemble({
        supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
        fetchPage: async (offset, limit) => {
          calls++;
          return pages(many)(offset, limit);
        },
      }),
    );
    expect(calls).toBe(2); // SALE_OR_RENT is on the second page — the join spans pages
    expect(r.count).toBe(2);
    expect(r.body).toContain("<ref>PAF0001</ref>");
    expect(r.body).toContain("<ref>PAF0004</ref>");
  });

  it("a reference returned twice by a window shift between page fetches is emitted once", async () => {
    const page0 = [...filler("Z", MAX_LIMIT - 1), SALE_VILLA.row];
    const page1 = [
      SALE_VILLA.row, // window shift: the same row is returned again at the top of the next page
      SALE_OR_RENT.row,
      ...filler("W", MAX_LIMIT - 2),
    ];
    const r = served(
      await assemble({
        supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
        fetchPage: async (offset) => (offset === 0 ? page0 : page1),
      }),
    );
    expect(r.body.split("<ref>PAF0001</ref>").length - 1).toBe(1);
    expect(r.count).toBe(2);
  });

  it("a set completed on the final allowed page is not truncation", async () => {
    const lastPage = [SALE_VILLA.row, ...filler("V", MAX_LIMIT - 1)];
    const r = served(
      await assemble({
        maxPages: 2,
        supplements: [sup(SALE_VILLA)],
        fetchPage: async (offset, limit) => (offset === 0 ? filler("U", limit) : lastPage),
      }),
    );
    expect(r.count).toBe(1);
    expect(r.missing).toBe(0);
  });

  it("a reference not found after a complete scan is reported missing, not an error", async () => {
    const r = served(
      await assemble({
        supplements: [sup(SALE_VILLA), { ...sup(SALE_VILLA), reference: "GONE" }],
        // updated: the scan now ends on an EMPTY page, so the fake honours the offset
        fetchPage: pages([SALE_VILLA.row]),
        // asked for by reference, GONE is not on the website: a real departure
        fetchByReference: async () => [],
      }),
    );
    expect(r.count).toBe(1);
    expect(r.selected).toBe(2);
    expect(r.missing).toBe(1);
    // a miss is not an exclusion: nothing about the listing was refused
    expect(r.excluded).toBe(0);
    expect(r.excludedByReason).toEqual({});
  });

  it("no selection renders the empty document without touching the database", async () => {
    let calls = 0;
    const r = served(
      await assemble({
        supplements: [],
        fetchPage: async (o, l) => {
          calls++;
          return pages([SALE_VILLA.row, RENT_FLAT.row])(o, l);
        },
        syncRevisions: async () => new Map(),
      }),
    );
    expect(r.body).toBe(kyero.empty());
    expect(calls).toBe(0);
    // the sync still runs (with no rows) so listings that left are forgotten
    expect(r).toMatchObject({ count: 0, selected: 0, missing: 0, excluded: 0, renditionGaps: 0, revisions: "synced" });
  });
});

describe("assemblePortalFeed — refusals (a 503 keeps the portal's previous copy; an empty document would delist everything)", () => {
  it("marks truncation as an error at the page ceiling instead of looping forever", async () => {
    // updated to the 0150 result shape: a refusal now carries its pull-record
    // reason and how many listings were selected
    const r = await assemble({
      maxPages: 2,
      supplements: [{ ...sup(SALE_VILLA), reference: "NEVER" }],
      fetchPage: async () => filler("Y", MAX_LIMIT),
    });
    expect(r).toEqual({ ok: false, reason: "truncated", error: "feed truncated at the page ceiling", selected: 1 });
    expect(MAX_PAGES).toBe(25);
  });

  it("a failing page is an error, not an empty feed", async () => {
    // updated to the 0150 result shape (reason + selected), same refusal
    const r = await assemble({
      supplements: [sup(SALE_VILLA)],
      fetchPage: async () => {
        throw new Error("db down");
      },
    });
    expect(r).toEqual({ ok: false, reason: "listings_failed", error: "db down", selected: 1 });
  });

  it("a page failing AFTER some selected listings were found refuses the whole feed rather than serving the part", async () => {
    // a partial document would make the portal withdraw every listing on the pages never read
    const r = await assemble({
      supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
      fetchPage: async (offset) => {
        if (offset === 0) return [SALE_VILLA.row, ...filler("P", MAX_LIMIT - 1)];
        throw new Error("connection reset");
      },
    });
    expect(r).toEqual({ ok: false, reason: "listings_failed", error: "connection reset", selected: 2 });
  });

  it("a completed scan that finds NONE of the selected listings is refused, not served empty", async () => {
    // postgrest-js turns an array-bodied 404 into `[]`: a short (empty) page
    // ends the scan, and serving its result would be the empty document
    const hollow = await assemble({ supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)], fetchPage: async () => [] });
    expect(hollow).toEqual({
      ok: false,
      reason: "listings_incomplete",
      error: "the site feed answered none of the 2 selected listing(s)",
      selected: 2,
    });
    // the same when the page has rows, just none of the selected ones
    const others = await assemble({ supplements: [sup(SALE_VILLA)], fetchPage: pages([RENT_FLAT.row, LAND_PLOT.row]) });
    expect(others).toMatchObject({ ok: false, reason: "listings_incomplete", selected: 1 });
  });

  it("a selected listing the scan skipped is asked for by reference and goes in — a moved offset window or a hollow page is not a removal", async () => {
    let asked: string[] = [];
    const r = served(
      await assemble({
        supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
        // the scan never returns SALE_OR_RENT (skipped when the window moved)
        fetchPage: pages([SALE_VILLA.row]),
        fetchByReference: async (ref) => {
          asked = [...asked, ref];
          return ref === SALE_OR_RENT.row.reference ? [SALE_OR_RENT.row] : [];
        },
      }),
    );
    expect(asked).toEqual([SALE_OR_RENT.row.reference]);
    expect(r.count).toBe(2);
    expect(r.missing).toBe(0);
  });

  it(`more than MAX_RECHECK (${MAX_RECHECK}) misses is a scan that went wrong: refused, never a short document`, async () => {
    const many = Array.from({ length: MAX_RECHECK + 1 }, (_, i) => supOf(`MISS${i}`, 2));
    let lookups = 0;
    const r = await assemble({
      supplements: [sup(SALE_VILLA), ...many],
      fetchPage: pages([SALE_VILLA.row]),
      fetchByReference: async () => {
        lookups++;
        return [];
      },
    });
    expect(r).toMatchObject({ ok: false, reason: "listings_incomplete", selected: MAX_RECHECK + 2 });
    expect(lookups).toBe(0);
  });

  it("a re-check that fails refuses the feed", async () => {
    const r = await assemble({
      supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
      fetchPage: pages([SALE_VILLA.row]),
      fetchByReference: async () => {
        throw new Error("public listings by reference: the answer held no rows");
      },
    });
    expect(r).toMatchObject({ ok: false, reason: "listings_failed" });
  });

  it("short pages from a lowered max_rows do not end the scan — it advances by what arrived and stops on an empty page", async () => {
    const all = [...filler("F", 120), SALE_VILLA.row];
    const offsets: number[] = [];
    const r = served(
      await assemble({
        supplements: [sup(SALE_VILLA)],
        // every page capped at 50 rows, whatever limit was asked for
        fetchPage: async (offset, limit) => {
          offsets.push(offset);
          return all.slice(offset, offset + Math.min(limit, 50));
        },
      }),
    );
    expect(r.count).toBe(1);
    expect(offsets).toEqual([0, 50, 100]);
  });

  it("JamesEdition receives only the photos that meet its 800×600 minimum; a portal with none receives every one", async () => {
    const small = { width: 640, height: 480 };
    const mixed: SupplementRow = {
      ...sup(SALE_VILLA),
      images: [
        { jpeg: "properties/p1/a_jpeg.jpg", alt: null, ...SHARP },
        { jpeg: "properties/p1/b_jpeg.jpg", alt: null, ...small },
        { jpeg: "properties/p1/c_jpeg.jpg", alt: null, ...SHARP },
      ],
    };
    const je = served(await assemble({ supplements: [mixed], fetchPage: pages([SALE_VILLA.row]) }));
    expect(je.body).toContain("a_jpeg.jpg");
    expect(je.body).toContain("c_jpeg.jpg");
    expect(je.body).not.toContain("b_jpeg.jpg");
    const apits = served(
      await assemble({ portal: portalById("aplaceinthesun")!, supplements: [mixed], fetchPage: pages([SALE_VILLA.row]) }),
    );
    expect(apits.body).toContain("b_jpeg.jpg");
  });

  it("a renderer that throws is a refusal, not a 500 and not an empty document", async () => {
    const broken: DialectRenderer = {
      ...kyero,
      render: () => {
        throw new TypeError("xml tag <price>: non-finite number NaN");
      },
    };
    const r = await assemble({ renderer: broken, supplements: [sup(SALE_VILLA)], fetchPage: pages([SALE_VILLA.row]) });
    expect(r).toEqual({
      ok: false,
      reason: "render_failed",
      error: "xml tag <price>: non-finite number NaN",
      selected: 1,
    });
  });
});

describe("assemblePortalFeed — exclusions are served, counted and never a refusal", () => {
  it("counts every exclusion by reason and serves the smaller document", async () => {
    const chf: FeedRow = { ...SALE_VILLA.row, reference: "PAF0101", currency: "CHF" };
    const free: FeedRow = { ...SALE_VILLA.row, reference: "PAF0102", asking_price: 0 };
    const r = served(
      await assemble({
        supplements: [sup(SALE_VILLA), sup(LAND_PLOT), sup(SHOP_UNIT), supOf("PAF0101", 2), supOf("PAF0102", 2)],
        fetchPage: pages([SALE_VILLA.row, LAND_PLOT.row, SHOP_UNIT.row, chf, free]),
      }),
    );
    expect(r.count).toBe(1);
    expect(r.selected).toBe(5);
    expect(r.missing).toBe(0);
    expect(r.excluded).toBe(4);
    // one listing can be kept out for two reasons (SHOP_UNIT: one photo AND commercial),
    // so the reasons add up to more than `excluded`
    expect(r.excludedByReason).toEqual({
      too_few_photos: 2,
      type_not_accepted: 1,
      currency_unsupported: 1,
      no_price: 1,
    });
    expect(Object.keys(datesByRef(r.body))).toEqual(["PAF0001"]);
  });

  it("serves the EMPTY document — ok, not refused — when every found listing is excluded", async () => {
    // portal integrations audit 2026-10-18, finding 5, decided against
    // withholding: a 503 would keep the portal's whole previous copy up,
    // sold and deselected listings included
    const r = served(
      await assemble({
        supplements: [sup(LAND_PLOT), sup(SHOP_UNIT)],
        fetchPage: pages([SALE_VILLA.row, LAND_PLOT.row, SHOP_UNIT.row]),
      }),
    );
    expect(r.body).toBe(kyero.empty());
    expect(r).toMatchObject({ count: 0, selected: 2, missing: 0, excluded: 2 });
    expect(r.excludedByReason).toEqual({ too_few_photos: 2, type_not_accepted: 1 });
  });

  it("counts a rendition gap only for a listing kept out solely for photos the WEBSITE has and the portal did not get", async () => {
    const gap: FeedRow = { ...LAND_PLOT.row, images: sitePhotos(3) }; // 3 on the site, 1 JPEG → gap
    const commercial: FeedRow = { ...SHOP_UNIT.row, images: sitePhotos(3) }; // a second reason → not a gap
    // the portal got fewer than the site shows, but the site has only one: not enough even with its rendition
    const fewOnSite: FeedRow = { ...LAND_PLOT.row, reference: "PAF0103", images: sitePhotos(1) };
    const small: FeedRow = { ...LAND_PLOT.row, reference: "PAF0104", images: sitePhotos(2) }; // both JPEGs, too small
    const r = served(
      await assemble({
        supplements: [
          sup(LAND_PLOT),
          sup(SHOP_UNIT),
          supOf("PAF0103", 0),
          supOf("PAF0104", 2, { width: 640, height: 480 }),
          sup(SALE_VILLA),
        ],
        fetchPage: pages([gap, commercial, fewOnSite, small, SALE_VILLA.row]),
      }),
    );
    expect(r.count).toBe(1);
    expect(r.excluded).toBe(4);
    expect(r.excludedByReason).toEqual({ too_few_photos: 4, type_not_accepted: 1 });
    // only PAF0003: PAF0005 also fails on type, PAF0103's site has fewer than
    // JamesEdition's two, and PAF0104's portal got every photo the site has —
    // they are just small (the desk's to fix, not the pipeline's)
    expect(r.renditionGaps).toBe(1);
  });

  it("a rendition gap is never a refusal, even when it empties the document", async () => {
    const r = served(
      await assemble({ supplements: [sup(LAND_PLOT)], fetchPage: pages([{ ...LAND_PLOT.row, images: sitePhotos(4) }]) }),
    );
    expect(r).toMatchObject({ count: 0, excluded: 1, renditionGaps: 1 });
    expect(r.body).toBe(kyero.empty());
  });

  it("the listing's website page reaches the document through listingUrl", async () => {
    const withUrl = served(
      await assemble({
        supplements: [sup(SALE_VILLA)],
        fetchPage: pages([SALE_VILLA.row]),
        listingUrl: (ref) => `https://site.example/properties/${ref}`,
      }),
    );
    expect(withUrl.body).toContain("<en>https://site.example/properties/PAF0001</en>");
    const without = served(await assemble({ supplements: [sup(SALE_VILLA)], fetchPage: pages([SALE_VILLA.row]) }));
    expect(without.body).not.toContain("site.example");
  });
});

describe("assemblePortalFeed — export revisions (0150 sync_portal_export)", () => {
  it("syncs once, with one {reference, sha256} per SERVED listing — the sha256 of its fingerprint", async () => {
    const { spy, fingerprints } = observed(kyero);
    const calls: RevisionRow[][] = [];
    const r = served(
      await assemble({
        renderer: spy,
        supplements: [sup(SALE_VILLA), sup(LAND_PLOT), sup(SALE_OR_RENT)],
        fetchPage: pages([SALE_OR_RENT.row, LAND_PLOT.row, SALE_VILLA.row]),
        syncRevisions: async (rows) => {
          calls.push([...rows]);
          return new Map(rows.map((x) => [x.reference, "2026-10-01T07:00:00+00:00"]));
        },
      }),
    );
    expect(r.revisions).toBe("synced");
    expect(calls).toHaveLength(1);
    // LAND_PLOT is excluded: it is not on the portal, so it has no revision
    expect(calls[0]).toEqual([
      { reference: "PAF0004", sha256: sha256(fingerprints.get("PAF0004")!) },
      { reference: "PAF0001", sha256: sha256(fingerprints.get("PAF0001")!) },
    ]);
    expect(calls[0]!.every((x) => /^[0-9a-f]{64}$/.test(x.sha256))).toBe(true);
    expect(calls[0]![0]!.sha256).not.toBe(calls[0]![1]!.sha256);
  });

  it("dates each listing by the sync's answer and hands the renderer revisionAt", async () => {
    const { spy, rendered } = observed(kyero);
    const answer = new Map([
      ["PAF0001", "2026-10-01T07:00:00+00:00"],
      ["PAF0004", "2026-10-02T09:15:30.123456+00:00"],
    ]);
    const r = served(
      await assemble({
        renderer: spy,
        supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
        fetchPage: pages([SALE_VILLA.row, SALE_OR_RENT.row]),
        syncRevisions: async () => answer,
      }),
    );
    expect(r.revisions).toBe("synced");
    // not the rows' updated_at (2026-09-10 08:30:15 / 2026-09-12 10:00:00)
    expect(datesByRef(r.body)).toEqual({ PAF0001: "2026-10-01 07:00:00", PAF0004: "2026-10-02 09:15:30" });
    expect(rendered[0]!.map((l) => [l.row.reference, l.revisionAt])).toEqual([
      ["PAF0001", "2026-10-01T07:00:00+00:00"],
      ["PAF0004", "2026-10-02T09:15:30.123456+00:00"],
    ]);
  });

  it("a sync that throws falls back to updated_at for the whole document — and the feed still goes out", async () => {
    const r = served(
      await assemble({
        supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
        fetchPage: pages([SALE_VILLA.row, SALE_OR_RENT.row]),
        syncRevisions: async () => {
          throw new Error("sync_portal_export: permission denied");
        },
      }),
    );
    expect(r.revisions).toBe("fallback");
    expect(r.count).toBe(2);
    expect(datesByRef(r.body)).toEqual({ PAF0001: "2026-09-10 08:30:15", PAF0004: "2026-09-12 10:00:00" });
  });

  it("an answer missing ANY served reference is not trusted at all — two clocks never mix in one document", async () => {
    const r = served(
      await assemble({
        supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
        fetchPage: pages([SALE_VILLA.row, SALE_OR_RENT.row]),
        syncRevisions: async () => new Map([["PAF0001", "2026-10-01T07:00:00+00:00"]]),
      }),
    );
    expect(r.revisions).toBe("fallback");
    expect(datesByRef(r.body)).toEqual({ PAF0001: "2026-09-10 08:30:15", PAF0004: "2026-09-12 10:00:00" });
    expect(r.body).not.toContain("2026-10-01 07:00:00");
  });

  it("an empty answer (0150's `{}` for a connection it no longer finds) falls back", async () => {
    const r = served(
      await assemble({
        supplements: [sup(SALE_VILLA)],
        fetchPage: pages([SALE_VILLA.row]),
        syncRevisions: async () => new Map(),
      }),
    );
    expect(r.revisions).toBe("fallback");
    expect(datesByRef(r.body)).toEqual({ PAF0001: "2026-09-10 08:30:15" });
  });

  it("without a sync the revisions are 'none' and each listing is dated by updated_at", async () => {
    const r = served(await assemble({ supplements: [sup(SALE_VILLA)], fetchPage: pages([SALE_VILLA.row]) }));
    expect(r.revisions).toBe("none");
    expect(datesByRef(r.body)).toEqual({ PAF0001: "2026-09-10 08:30:15" });
  });

  it("two assemblies over unchanged data give byte-identical bodies; a change moves only that listing's date", async () => {
    // Kyero: "if the date does not change, we will not update the property" —
    // so the date must move exactly when what the portal receives moves
    const db = exportState(["2026-10-18T06:00:00+00:00", "2026-10-18T14:00:00+00:00", "2026-10-18T22:00:00+00:00"]);
    const args = {
      supplements: [sup(SALE_VILLA), sup(SALE_OR_RENT)],
      syncRevisions: db.sync,
      listingUrl: (ref: string) => `https://site.example/properties/${ref}`,
    };
    const first = served(await assemble({ ...args, fetchPage: pages([SALE_VILLA.row, SALE_OR_RENT.row]) }));
    const second = served(await assemble({ ...args, fetchPage: pages([SALE_VILLA.row, SALE_OR_RENT.row]) }));
    expect(second.body).toBe(first.body);
    expect(db.calls[1]).toEqual(db.calls[0]); // same fingerprints, so the database kept both dates
    expect(datesByRef(first.body)).toEqual({ PAF0001: "2026-10-18 06:00:00", PAF0004: "2026-10-18 06:00:00" });

    const repriced: FeedRow = { ...SALE_VILLA.row, asking_price: 640000 };
    const third = served(await assemble({ ...args, fetchPage: pages([repriced, SALE_OR_RENT.row]) }));
    expect(datesByRef(third.body)).toEqual({ PAF0001: "2026-10-18 22:00:00", PAF0004: "2026-10-18 06:00:00" });

    // and without a sync, unchanged data is still byte-identical
    const plain = () => assemble({ supplements: args.supplements, fetchPage: pages([SALE_VILLA.row, SALE_OR_RENT.row]) });
    expect(served(await plain()).body).toBe(served(await plain()).body);
  });

  /**
   * SOURCE DEFECT (reported, low): 0150 sync_portal_export forgets the
   * revision of a listing that is no longer sent — "if it comes back it is
   * new to the portal, and its date says so" (the delete before its return).
   * That only happens when the sync is CALLED, and the assembler skips it
   * when it serves nothing (`listings.length && a.syncRevisions`). So a
   * listing that leaves in a pull that empties the feed keeps its old
   * revision and comes back with its OLD date, while one that leaves beside a
   * listing that stays comes back with a new one. Drop `.fails` if the
   * assembler starts syncing an empty row set; delete this test if keeping
   * the state is the decision.
   */
  it("a pull whose every listing is excluded still syncs, with no rows, so the revisions of the listings that left are forgotten", async () => {
    const db = exportState(["2026-10-18T06:00:00+00:00", "2026-10-18T14:00:00+00:00"]);
    served(await assemble({ supplements: [sup(SALE_VILLA)], fetchPage: pages([SALE_VILLA.row]), syncRevisions: db.sync }));
    // the villa loses a photo: one is below JamesEdition's two, so the document is empty
    served(
      await assemble({
        supplements: [{ ...sup(SALE_VILLA), images: sup(SALE_VILLA).images.slice(0, 1) }],
        fetchPage: pages([SALE_VILLA.row]),
        syncRevisions: db.sync,
      }),
    );
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]).toEqual([]);
  });
});
